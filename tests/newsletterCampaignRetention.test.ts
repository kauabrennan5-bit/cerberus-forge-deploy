import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getNewsletterCampaignRetentionConfig,
  runNewsletterCampaignRetentionOnce,
} from "../server/services/newsletterCampaignRetention";

const MIGRATION_PATH = new URL(
  "../supabase/migrations/20260827040000_newsletter_campaign_test_retention.sql",
  import.meta.url,
);

function fakeClient(result: unknown = [{ archived_count: 2, deleted_count: 1, skipped_recipient_count: 3 }]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: result, error: null };
    },
  } as any;
  return { client, calls };
}

test("retenção usa os padrões autorizados e não permite exclusão física antes de 30 dias", () => {
  const config = getNewsletterCampaignRetentionConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.archiveAfterDays, 7);
  assert.equal(config.deleteAfterDays, 30);
  assert.equal(config.batchSize, 50);
  assert.equal(config.intervalMs, 86_400_000);

  const bounded = getNewsletterCampaignRetentionConfig({
    NEWSLETTER_CAMPAIGN_RETENTION_ARCHIVE_AFTER_DAYS: "0",
    NEWSLETTER_CAMPAIGN_RETENTION_DELETE_AFTER_DAYS: "1",
    NEWSLETTER_CAMPAIGN_RETENTION_BATCH_SIZE: "999",
    NEWSLETTER_CAMPAIGN_RETENTION_INTERVAL_MS: "100",
  });
  assert.equal(bounded.archiveAfterDays, 1);
  assert.equal(bounded.deleteAfterDays, 30);
  assert.equal(bounded.batchSize, 50);
  assert.equal(bounded.intervalMs, 3_600_000);
});

test("retenção pode ser desligada explicitamente sem afetar a configuração do provider", () => {
  const config = getNewsletterCampaignRetentionConfig({ NEWSLETTER_CAMPAIGN_RETENTION_ENABLED: "false" });
  assert.equal(config.enabled, false);
});

test("runNewsletterCampaignRetentionOnce chama somente o RPC de retenção e normaliza o resultado", async () => {
  const { client, calls } = fakeClient([{ archived_count: "2", deleted_count: "1", skipped_recipient_count: "3" }]);
  const result = await runNewsletterCampaignRetentionOnce(client, {
    enabled: true,
    archiveAfterDays: 7,
    deleteAfterDays: 30,
    batchSize: 50,
    intervalMs: 86_400_000,
  });

  assert.deepEqual(result, { archivedCount: 2, deletedCount: 1, skippedRecipientCount: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "cleanup_expired_newsletter_test_campaigns");
  assert.deepEqual(calls[0]?.args, {
    p_archive_after_days: 7,
    p_delete_after_days: 30,
    p_batch_size: 50,
  });
});

test("migration mantém a política fail-closed: product + test_sent, recipients protegidos e welcome fora do escopo", () => {
  const source = readFileSync(MIGRATION_PATH, "utf8");
  assert.match(source, /add column if not exists archived_at timestamptz/);
  assert.match(source, /add column if not exists archive_reason text/);
  assert.match(source, /campaign_type = 'product'/);
  assert.match(source, /status = 'test_sent'/);
  assert.match(source, /status = 'cancelled'/);
  assert.match(source, /archive_reason = 'test_retention_expired'/);
  assert.match(source, /p_delete_after_days < 30/);
  assert.match(source, /p_batch_size > 50/);
  assert.match(source, /not exists \(\s*select 1\s*from public\.email_campaign_recipients/);
  assert.match(source, /grant execute on function public\.cleanup_expired_newsletter_test_campaigns/);
  assert.doesNotMatch(source, /delete\s+from\s+public\.email_campaign_recipients/i);
  assert.doesNotMatch(source, /delete\s+from\s+public\.newsletter_subscribers/i);
});
