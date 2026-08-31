import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { getNewsletterInstitutionalOptions } from "../server/services/newsletterInstitutional";
import {
  emptySocialLinkConfig,
  isSocialNetwork,
  listPublicSocialLinks,
  normalizeSocialLinkUrl,
  readCanonicalSocialLinks,
} from "../server/services/socialLinks";

describe("social links", () => {
  test("accepts only public HTTPS URLs without embedded credentials or whitespace", () => {
    assert.equal(normalizeSocialLinkUrl("https://instagram.com/cerberusfinds"), "https://instagram.com/cerberusfinds");
    assert.equal(normalizeSocialLinkUrl("http://instagram.com/cerberusfinds"), null);
    assert.equal(normalizeSocialLinkUrl("https://user:pass@example.com/profile"), null);
    assert.equal(normalizeSocialLinkUrl("https://example.com/a link"), null);
    assert.equal(normalizeSocialLinkUrl("javascript:alert(1)"), null);
  });

  test("reads only known, valid networks and keeps empty defaults for the rest", async () => {
    const fakeClient = {
      from(table: string) {
        assert.equal(table, "social_links");
        const query = {
          select() { return query; },
          order() { return query; },
          limit: async () => ({
            data: [
              { network: "instagram", url: "https://instagram.com/cerberusfinds" },
              { network: "unknown", url: "https://example.com/unknown" },
              { network: "youtube", url: "http://youtube.com/unsafe" },
            ],
            error: null,
          }),
        };
        return query;
      },
    } as any;

    const config = await readCanonicalSocialLinks(fakeClient);
    assert.equal(config.instagram, "https://instagram.com/cerberusfinds");
    assert.equal(config.youtube, "");
    assert.deepEqual(config, { ...emptySocialLinkConfig(), instagram: "https://instagram.com/cerberusfinds" });

    const links = await listPublicSocialLinks(fakeClient);
    assert.deepEqual(links, [{ network: "instagram", label: "Instagram", url: "https://instagram.com/cerberusfinds" }]);
  });

  test("propagates canonical links to future newsletter institutional options", async () => {
    const fakeClient = {
      from() {
        const query = {
          select() { return query; },
          order() { return query; },
          limit: async () => ({ data: [{ network: "instagram", url: "https://instagram.com/cerberusfinds" }], error: null }),
        };
        return query;
      },
    } as any;
    const options = await getNewsletterInstitutionalOptions({ PUBLIC_SITE_URL: "https://example.com", NEWSLETTER_PUBLIC_ASSET_BASE_URL: "https://example.com" }, fakeClient);
    assert.equal(options.privacyUrl, "https://example.com/politica-de-privacidade");
    assert.equal(options.termsUrl, "https://example.com/termos-e-condicoes");
    assert.deepEqual(options.socialLinks.find(link => link.label === "Instagram"), {
      label: "Instagram",
      url: "https://instagram.com/cerberusfinds",
      iconUrl: "https://example.com/assets/newsletter/social/instagram.png",
    });
  });

  test("recognizes exactly the supported networks", () => {
    assert.equal(isSocialNetwork("instagram"), true);
    assert.equal(isSocialNetwork("youtube"), true);
    assert.equal(isSocialNetwork("linkedin"), false);
    assert.equal(isSocialNetwork(""), false);
  });

  test("Telegram exposes the social-links editor without hardcoded destinations", () => {
    const core = readFileSync(new URL("../server/services/telegramBotCore.ts", import.meta.url), "utf8");
    const extension = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
    const bot = `${core}\n${extension}`;
    const commands = readFileSync(new URL("../server/services/telegramCommands.ts", import.meta.url), "utf8");
    assert.match(bot, /callback_data: "social_links"/);
    assert.match(bot, /social_edit:/);
    assert.match(bot, /social_clear:/);
    assert.match(bot, /upsertCanonicalSocialLink/);
    assert.match(bot, /normalizeSocialLinkUrl/);
    assert.match(bot, /resolvePublicSiteUrl\(\)/);
    assert.match(commands, /command: "redes"/);
    assert.doesNotMatch(bot, /https:\/\/cerberusfinds\.com\/produto/);
  });

  test("migration is narrow, HTTPS-only and service-role scoped", () => {
    const sql = readFileSync(new URL("../supabase/migrations/20260827210000_social_links.sql", import.meta.url), "utf8");
    assert.match(sql, /create table if not exists public\.social_links/);
    assert.match(sql, /network in \('instagram', 'tiktok', 'facebook', 'youtube', 'x', 'pinterest'\)/);
    assert.match(sql, /left\(lower\(btrim\(url\)\), 8\) = 'https:\/\/'/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /grant all on table public\.social_links to service_role/);
    assert.doesNotMatch(sql, /subscriber|consent|tracking|newsletter_subscribers/i);
  });
});
