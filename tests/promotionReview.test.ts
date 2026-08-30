import test from "node:test";
import assert from "node:assert/strict";
import { handleTelegramWebhookUpdate, PendingReview, setTestTelegramSenders } from "../server/services/telegramBot";
import {
  deleteUserState,
  setTestGetPendingReview,
  setTestSavePendingReview,
  setTestUserStateHandlers,
} from "../server/repositories/telegramRepository";

// Usa um administrador exclusivo deste arquivo para não disputar o mesmo
// telegram_user_states.json com outros arquivos executados em paralelo.
const adminId = 1976526373;
const originalAllowedUsers = process.env.TELEGRAM_ALLOWED_USER_IDS;
const originalToken = process.env.TELEGRAM_BOT_TOKEN;
const originalFetch = globalThis.fetch;
process.env.TELEGRAM_ALLOWED_USER_IDS = String(adminId);
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "fake-bot-token";

function callback(data: string) {
  return {
    callback_query: {
      id: `cb-${data}`,
      from: { id: adminId, first_name: "admin" },
      message: { chat: { id: adminId }, message_id: 10, text: "preview" },
      data,
    },
  } as any;
}

function message(text: string) {
  return {
    message: {
      from: { id: adminId, first_name: "admin" },
      chat: { id: adminId },
      message_id: 11,
      text,
    },
  } as any;
}

test("revisão promocional humana registra Pix com cupom sem alterar preço-base", async () => {
  const reviewId = "promo-review-test";
  const review: PendingReview = {
    id: reviewId,
    chatId: adminId,
    senderId: adminId,
    firstName: "admin",
    username: "admin",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    produto: "Luminária Bauhaus",
    categoria: "affiliate_preview",
    preco: 299,
    imagens: [],
    normalizedUrl: "https://shopee.com.br/product/852965232/46816332146",
    status: "pending",
  };
  const sent: string[] = [];
  // answerCallbackQuery também passa pelo transporte HTTP do Telegram; mantenha
  // o teste inteiramente local mesmo quando TELEGRAM_BOT_TOKEN está definido.
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ ok: true, result: true }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;
  setTestTelegramSenders(async (_chatId, text) => { sent.push(text); }, async () => {});
  setTestGetPendingReview(async (id) => id === reviewId ? review : null);
  setTestSavePendingReview(async (saved) => {
    Object.assign(review, saved);
  });
  let localState: { action: string; reviewId?: string; productId?: string } | null = null;
  setTestUserStateHandlers({
    set: async (_senderId, state) => { localState = { ...state }; },
    get: async () => localState,
    delete: async () => { localState = null; },
  });
  await deleteUserState(adminId);

  try {
    await handleTelegramWebhookUpdate(callback(`promo_edit:${reviewId}`));
    await handleTelegramWebhookUpdate(message("264,44"));
    await handleTelegramWebhookUpdate(callback("promo_condition:pix_with_coupon"));
    await handleTelegramWebhookUpdate(message("Compre R$200 e ganhe R$6 off\nLeve 2 e aproveite 2% de desconto"));
    await handleTelegramWebhookUpdate(callback(`promo_confirm:${reviewId}`));

    assert.equal(review.preco, 299, "preço-base canônico não é alterado");
    assert.deepEqual(review.promotionReview, {
      price: 264.44,
      condition: "pix_with_coupon",
      benefits: ["Compre R$200 e ganhe R$6 off", "Leve 2 e aproveite 2% de desconto"],
      source: "admin_confirmed",
      confirmedAt: review.promotionReview?.confirmedAt,
      expiresAt: review.promotionReview?.expiresAt,
    });
    assert.equal(
      review.promotionReview?.expiresAt,
      (review.promotionReview?.confirmedAt || 0) + 24 * 60 * 60 * 1000,
      "oferta confirmada recebe validade explícita conservadora de 24h",
    );
    assert.equal(review.promotionDraft, null, "rascunho é removido após confirmação");
    assert.ok(sent.some((text) => /OFERTA PROMOCIONAL REGISTRADA/.test(text)));
    assert.ok(sent.some((text) => /produto não foi publicado/i.test(text)));
  } finally {
    await deleteUserState(adminId);
    setTestTelegramSenders(null, null);
    setTestGetPendingReview(null);
    setTestSavePendingReview(null);
    setTestUserStateHandlers(null);
    if (originalAllowedUsers === undefined) delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = originalAllowedUsers;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    globalThis.fetch = originalFetch;
  }
});
