from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one replacement, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


replace_once(
    "server/services/newsletterCampaignService.ts",
    '''import {
  createBrevoNewsletterProvider,
  type NewsletterCampaignProvider,
  type NewsletterProviderResult,
} from "./newsletterProvider";
''',
    '''import {
  createBrevoNewsletterProvider,
  type NewsletterCampaignProvider,
  type NewsletterProviderResult,
} from "./newsletterProvider";
import type { WeeklyBrevoMarketingProvider } from "./newsletterWeeklyBrevoProvider";
import { sendWeeklyMarketingNow, sendWeeklyMarketingTest } from "./newsletterWeeklyDelivery";
''',
)

replace_once(
    "server/services/newsletterCampaignService.ts",
    '''  provider?: NewsletterCampaignProvider;
  /** Probe injetável para validar acessibilidade da imagem principal sem duplicar lógica. */
''',
    '''  provider?: NewsletterCampaignProvider;
  weeklyProvider?: WeeklyBrevoMarketingProvider;
  /** Probe injetável para validar acessibilidade da imagem principal sem duplicar lógica. */
''',
)

replace_once(
    "server/services/newsletterCampaignService.ts",
    '''    const current = await readCurrentCampaign(store, campaign.id);
    if (current.status !== "approved") {
''',
    '''    const current = await readCurrentCampaign(store, campaign.id);
    if (current.editionKey?.startsWith("weekly-test:")) {
      return sendWeeklyMarketingTest(current, actorTelegramId, {
        store,
        env,
        now: options.now || new Date(),
        provider: options.weeklyProvider,
      });
    }
    if (current.status !== "approved") {
''',
)

replace_once(
    "server/services/newsletterCampaignService.ts",
    '''  const current = await readCurrentCampaign(store, campaign.id);
  const sending = transitionCampaign(current, { type: "begin_sending", actorTelegramId }, now);
  // A campanha geral deve alcançar todos os assinantes elegíveis; o endereço de teste
''',
    '''  const current = await readCurrentCampaign(store, campaign.id);
  if (current.editionKey?.startsWith("weekly:")) {
    return sendWeeklyMarketingNow(current, actorTelegramId, {
      store,
      env: options.env || process.env,
      now,
      provider: options.weeklyProvider,
    });
  }
  const sending = transitionCampaign(current, { type: "begin_sending", actorTelegramId }, now);
  // A campanha geral deve alcançar todos os assinantes elegíveis; o endereço de teste
''',
)

replace_once(
    "server/services/newsletterCampaignTelegram.ts",
    '''import type { NewsletterCampaignProvider } from "./newsletterProvider";
''',
    '''import type { NewsletterCampaignProvider } from "./newsletterProvider";
import type { WeeklyBrevoMarketingProvider } from "./newsletterWeeklyBrevoProvider";
''',
)

replace_once(
    "server/services/newsletterCampaignTelegram.ts",
    '''  provider?: NewsletterCampaignProvider;
  productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>;
''',
    '''  provider?: NewsletterCampaignProvider;
  weeklyProvider?: WeeklyBrevoMarketingProvider;
  productLoader?: (productId: string) => Promise<import("../../src/types").Product | null>;
''',
)

replace_once(
    "server/services/newsletterCampaignTelegram.ts",
    '''    if (data.startsWith("campaign_weekly_approve:")) {
      if (campaign.status !== "pending_approval") return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      const approved = await approveCampaign(campaign, senderId, { store, env });
      if (approved.editionKey?.startsWith("weekly-test:")) {
        const tested = await sendCampaignTest(approved, senderId, { store, env, provider: deps.provider });
        await deps.answerCallbackQuery(callbackId, "Rascunho aprovado. Teste enviado somente ao destino controlado.");
        await syncCampaignTelegramState(tested.campaign.id, deps, messageReference(chatId, messageId));
        return true;
      }
      const confirmed = await confirmGeneralSend(approved, senderId, { store, env });
      const sending = await startGeneralSend(confirmed, senderId, { store, env });
      await deps.answerCallbackQuery(callbackId, "Campanha aprovada. Envio geral enfileirado.");
      await syncCampaignTelegramState(sending.id, deps, messageReference(chatId, messageId));
      return true;
    }
''',
    '''    if (data.startsWith("campaign_weekly_approve:")) {
      if (campaign.status !== "pending_approval" && campaign.status !== "approved") {
        return handleIncompatibleCampaignCallback(deps, callbackId, chatId, messageId, campaign);
      }
      const approved = campaign.status === "pending_approval"
        ? await approveCampaign(campaign, senderId, { store, env })
        : campaign;
      if (approved.editionKey?.startsWith("weekly-test:")) {
        const tested = await sendCampaignTest(approved, senderId, {
          store,
          env,
          provider: deps.provider,
          weeklyProvider: deps.weeklyProvider,
        });
        await deps.answerCallbackQuery(callbackId, "Rascunho aprovado. Teste enviado somente ao destino controlado.");
        await syncCampaignTelegramState(tested.campaign.id, deps, messageReference(chatId, messageId));
        return true;
      }
      const confirmed = approved.generalSendConfirmedAt
        ? approved
        : await confirmGeneralSend(approved, senderId, { store, env });
      const sending = await startGeneralSend(confirmed, senderId, {
        store,
        env,
        weeklyProvider: deps.weeklyProvider,
      });
      await deps.answerCallbackQuery(callbackId, "Campanha aprovada. Envio de marketing entregue ao provider Brevo.");
      await syncCampaignTelegramState(sending.id, deps, messageReference(chatId, messageId));
      return true;
    }
''',
)

replace_once(
    "server/services/newsletterCampaignWorker.ts",
    '''  if (campaign.status !== "sending") {
    return { outcome: "idle", providerCalled: false, campaign, recipient: null, processed: 0 };
  }

  const config = getNewsletterCampaignWorkerConfig();
''',
    '''  if (campaign.status !== "sending") {
    return { outcome: "idle", providerCalled: false, campaign, recipient: null, processed: 0 };
  }
  if (campaign.editionKey?.startsWith("weekly:")) {
    // Weekly marketing is owned by the Brevo Email Campaign provider, never by SMTP per-recipient delivery.
    return { outcome: "idle", providerCalled: false, campaign, recipient: null, processed: 0 };
  }

  const config = getNewsletterCampaignWorkerConfig();
''',
)

replace_once(
    "tests/newsletterWeeklyCampaign.test.ts",
    '''  assert.match(rendered.html, new RegExp(BREVO_NATIVE_UNSUBSCRIBE.replace(/[{}]/g, "\\\\$&")));
  assert.doesNotMatch(rendered.html, /display\\s*:\\s*(flex|grid)/i);
''',
    '''  assert.match(rendered.html, new RegExp(BREVO_NATIVE_UNSUBSCRIBE.replace(/[{}]/g, "\\\\$&")));
  assert.match(rendered.html, /<a\\b[^>]*href=["']\\{\\{\\s*unsubscribe\\s*\\}\\}["'][^>]*>[^<]*Cancelar inscrição[^<]*<\\/a>/i);
  assert.doesNotMatch(rendered.html, /display\\s*:\\s*(flex|grid)/i);
''',
)
