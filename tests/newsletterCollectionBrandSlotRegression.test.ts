import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Product } from "../src/types";
import { renderNewsletterCollectionCampaign } from "../server/services/newsletterCampaignTemplate";
import { buildNewsletterAssetUrl } from "../server/services/newsletterInstitutional";
import { buildProviderCampaignSubject } from "../server/services/newsletterProvider";
import {
  DISPLAY_TITLE_REVIEW_VERSION,
  IMAGE_REVIEW_VERSION,
  imageUrlFingerprint,
} from "../server/services/productEditorialReview";

function product(id: string, createdAt: string): Product {
  const image = `https://cdn.example.com/${id}.jpg`;
  return {
    id,
    ref: `REF-${id}`,
    produto: `Produto bruto ${id}`,
    rawTitle: `Produto bruto ${id}`,
    displayTitle: `Peça editorial ${id}`,
    displayTitleStatus: "ready",
    displayTitleReviewedAt: createdAt,
    displayTitleReviewModel: "test-curator",
    displayTitleReviewVersion: DISPLAY_TITLE_REVIEW_VERSION,
    categoria: "Acessórios",
    preco: 199.9,
    imagens: [image],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [image],
      primaryImageUrl: image,
      galleryImageUrls: [],
      assessments: [{
        url: image,
        decision: "clean",
        confidence: "HIGH",
        reason: "fixture",
      }],
    },
    imageReviewedAt: createdAt,
    imageReviewModel: "test-image-review",
    imageReviewVersion: IMAGE_REVIEW_VERSION,
    imageReviewFingerprint: imageUrlFingerprint(image),
    link: `https://market.example.com/${id}`,
    ativo: true,
    destaque: false,
    status: "published",
    descricao: `Descrição factual ${id}`,
    createdAt,
  };
}

function mastheadHtml(html: string): string {
  const mastheadStart = html.indexOf('class="editorial-block editorial-masthead');
  const heroStart = html.indexOf('class="editorial-block editorial-hero');
  assert.ok(mastheadStart >= 0);
  assert.ok(heroStart > mastheadStart);
  return html.slice(mastheadStart, heroStart);
}

test("user-selected masthead logo is a real PNG with the expected email-safe canvas", () => {
  const png = readFileSync(new URL("../public/assets/newsletter/branding/cerberus-logo-user-tight.png", import.meta.url));
  assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 384);
  assert.equal(png.readUInt32BE(20), 280);
});

test("generic collection renders the user-selected black logo once and never duplicates it in the masthead image slot", () => {
  const products = [
    product("bag-1", "2026-09-05T12:00:00.000Z"),
    product("lamp-2", "2026-09-05T11:00:00.000Z"),
    product("chair-3", "2026-09-05T10:00:00.000Z"),
  ];
  const brandIcon = buildNewsletterAssetUrl("assets/newsletter/branding/cerberus-logo-user-tight.png");
  const rendered = renderNewsletterCollectionCampaign(products, {
    subject: "Novidades da semana — Edição de regressão",
    trackingCampaignId: "collection-brand-regression",
    mastheadImageStatus: "clean",
    mastheadAssetUrl: brandIcon,
    mastheadLogoStatus: "available",
  });

  const masthead = mastheadHtml(rendered.html);
  assert.match(masthead, /editorial-masthead-a/);
  assert.match(masthead, new RegExp(brandIcon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((masthead.match(/cerberus-logo-user-tight\.png/g) || []).length, 1);
  assert.doesNotMatch(masthead, /class="email-masthead-image"/);
  assert.doesNotMatch(masthead, /class="email-masthead-logo-print"/);
  assert.match(masthead, /class="email-masthead-logo"[^>]+width="96" height="70"/);
  assert.match(masthead, /class="email-masthead-brand-mark" width="108" height="82"/);
  assert.doesNotMatch(masthead, /https:\/\/cdn\.example\.com\/bag-1\.jpg/);
  assert.match(rendered.html, /https:\/\/cdn\.example\.com\/bag-1\.jpg/);
});

test("collection masthead never falls back to product #1 when no dedicated editorial masthead image exists", () => {
  const products = [
    product("bag-1", "2026-09-05T12:00:00.000Z"),
    product("lamp-2", "2026-09-05T11:00:00.000Z"),
  ];
  const rendered = renderNewsletterCollectionCampaign(products, {
    subject: "Novidades da semana — sem imagem editorial",
    trackingCampaignId: "collection-no-product-fallback",
    mastheadImageStatus: "clean",
    mastheadLogoStatus: "available",
  });

  const masthead = mastheadHtml(rendered.html);
  assert.match(masthead, /editorial-masthead-a/);
  assert.doesNotMatch(masthead, /class="email-masthead-image"/);
  assert.doesNotMatch(masthead, /https:\/\/cdn\.example\.com\/bag-1\.jpg/);
  assert.match(rendered.html, /https:\/\/cdn\.example\.com\/bag-1\.jpg/);
});

test("provider rewrites only administrative test subjects with a stable campaign marker", () => {
  const campaignId = "12345678-aaaa-4bbb-8ccc-1234567890ab";
  assert.equal(
    buildProviderCampaignSubject({
      campaignId,
      recipientId: `test:${campaignId}`,
      subject: "[Teste controlado] Novidades da semana — Edição 2026-09-05",
    }),
    "[TESTE CERBERUS · 12345678] Novidades da semana — Edição 2026-09-05",
  );
  assert.equal(
    buildProviderCampaignSubject({
      campaignId,
      recipientId: "recipient-production-1",
      subject: "Novidades da semana — Edição 2026-09-05",
    }),
    "Novidades da semana — Edição 2026-09-05",
  );
});
