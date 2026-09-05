import test from "node:test";
import assert from "node:assert/strict";
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

test("generic collection masthead uses Cerberus brand asset and never product #1 image", () => {
  const products = [
    product("bag-1", "2026-09-05T12:00:00.000Z"),
    product("lamp-2", "2026-09-05T11:00:00.000Z"),
    product("chair-3", "2026-09-05T10:00:00.000Z"),
  ];
  const brandIcon = buildNewsletterAssetUrl("assets/newsletter/branding/cerberus-logo-official.png");
  const rendered = renderNewsletterCollectionCampaign(products, {
    subject: "Novidades da semana — Edição de regressão",
    trackingCampaignId: "collection-brand-regression",
    mastheadImageStatus: "clean",
    mastheadAssetUrl: brandIcon,
    mastheadLogoStatus: "available",
  });

  const mastheadStart = rendered.html.indexOf('class="editorial-block editorial-masthead');
  const heroStart = rendered.html.indexOf('class="editorial-block editorial-hero');
  assert.ok(mastheadStart >= 0);
  assert.ok(heroStart > mastheadStart);
  const mastheadHtml = rendered.html.slice(mastheadStart, heroStart);

  assert.match(mastheadHtml, /cerberus-logo-official\.png/);
  assert.doesNotMatch(mastheadHtml, /https:\/\/cdn\.example\.com\/bag-1\.jpg/);
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
