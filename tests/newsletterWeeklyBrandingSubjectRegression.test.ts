import test from "node:test";
import assert from "node:assert/strict";
import type { Product } from "../src/types";
import { renderWeeklyNewsletter } from "../server/services/newsletterWeeklyTemplate";
import { createCampaignDraft, transitionCampaign, type EmailCampaign } from "../server/services/newsletterCampaignState";
import { buildWeeklyTestProviderSubject, sendWeeklyMarketingTest } from "../server/services/newsletterWeeklyDelivery";
import type { WeeklyBrevoMarketingProvider } from "../server/services/newsletterWeeklyBrevoProvider";

function product(id: string, ref: string, price: number): Product {
  const image = `https://cdn.example.com/${id}.jpg`;
  return {
    id,
    ref,
    produto: `Produto ${id}`,
    displayTitle: `Peça editorial ${id}`,
    categoria: "Móveis",
    preco: price,
    imagens: [image],
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: [image],
      primaryImageUrl: image,
      galleryImageUrls: [],
      assessments: [{ url: image, decision: "clean", confidence: "HIGH", reason: "fixture" }],
    },
    link: `https://market.example.com/${id}`,
    ativo: true,
    destaque: false,
    status: "published",
    createdAt: "2026-09-04T12:00:00Z",
  } as Product;
}

const copy = {
  subject: "Seleção Cerberus Finds",
  previewText: "Uma curadoria curta para esta semana.",
  heroHeadline: "UM OLHAR ATENTO PARA O QUE ENTRA.",
  heroBody: "Uma edição curta para descobrir o que saiu do óbvio.",
  secondaryCaptions: {},
};

test("masthead semanal usa o ícone oficial e nunca a primeira imagem do produto no primeiro slot", () => {
  const products = [
    product("cadeira", "REF-A", 100),
    product("luminaria", "REF-B", 200),
    product("mesa", "REF-C", 300),
  ];
  const rendered = renderWeeklyNewsletter(products, copy, {
    campaignId: "camp-brand-slot",
    publicBaseUrl: "https://cerberus.example.com",
  });

  const mastheadImageCell = rendered.html.match(/<td class="email-masthead-image"[\s\S]*?<\/td>/)?.[0] || "";
  assert.ok(mastheadImageCell, "masthead image slot must exist");
  assert.match(mastheadImageCell, /assets\/newsletter\/branding\/cerberus-logo-official\.png/);
  assert.doesNotMatch(mastheadImageCell, /cdn\.example\.com\/cadeira\.jpg/);
  assert.match(rendered.html, /class="email-collection-image" src="https:\/\/cdn\.example\.com\/cadeira\.jpg"/);
});

function weeklyTestCampaign(): EmailCampaign {
  const draft = createCampaignDraft(
    null,
    "123",
    {
      subject: "[Teste controlado] Seleção Cerberus Finds",
      html: '<html><body><a href="{{ unsubscribe }}">Cancelar inscrição</a></body></html>',
      text: "Cancelar: {{ unsubscribe }}",
      offerUrl: "",
    },
    new Date("2026-09-04T12:00:00Z"),
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "collection",
    [
      { productId: "a", position: 1, layout: "feature" },
      { productId: "b", position: 2, layout: "grid" },
      { productId: "c", position: 3, layout: "grid" },
    ],
    "weekly-test:2026-09-04:subject-regression",
  );
  const pending = transitionCampaign(draft, { type: "submit_for_approval", actorTelegramId: "123" });
  return transitionCampaign(pending, { type: "approve", actorTelegramId: "123" });
}

test("teste Brevo recebe assunto exclusivo por campanha enquanto produção mantém assunto editorial", async () => {
  const campaign = weeklyTestCampaign();
  const expected = "[TESTE CERBERUS · AAAAAAAA] Seleção Cerberus Finds";
  assert.equal(buildWeeklyTestProviderSubject(campaign), expected);

  let stored = structuredClone(campaign);
  let providerSubject = "";
  const store = {
    async getCampaign(id: string) { return id === stored.id ? structuredClone(stored) : null; },
    async updateCampaign(value: EmailCampaign) { stored = structuredClone(value); return structuredClone(stored); },
  } as any;
  const provider: WeeklyBrevoMarketingProvider = {
    async createCampaign(input) {
      providerSubject = input.subject;
      return { status: "succeeded", brevoCampaignId: "901", operation: "create", providerRef: "901", providerReference: "901" };
    },
    async sendTest(id) {
      return { status: "succeeded", brevoCampaignId: id, operation: "send_test", providerRef: id, providerReference: id };
    },
    async sendNow() {
      throw new Error("SEND_NOW_FORBIDDEN_IN_TEST");
    },
  };

  await sendWeeklyMarketingTest(campaign, "123", {
    store,
    provider,
    env: { NEWSLETTER_TEST_EMAIL: "qa@example.com" },
  });

  assert.equal(providerSubject, expected);
  assert.notEqual(providerSubject, "Seleção Cerberus Finds");
});
