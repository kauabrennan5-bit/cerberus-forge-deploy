/**
 * N17 — FASE 25C — COMMIT 3 — TESTES DO COMANDO /publicar <reviewId>
 *
 * Escopo (mesmo padrão da codebase: node:test + assert/strict + fetch fake):
 *   A) /publicar sem id → sintaxe informativa, ZERO publicação.
 *   B) /publicar id inexistente → aviso, ZERO escrita.
 *   C) /publicar review cancelada → bloqueada, ZERO escrita.
 *   D) /publicar review expirada → bloqueada, ZERO escrita.
 *   E) /publicar review pendente → card de confirmação enviado com
 *      teclado canônico (confirm_pub), lifecycle prévio registrado.
 *   F) /publicar review já aprovada (status=published) → card enviado.
 *   G) /publicar NÃO executa pipeline.publish (DECISION ≠ ACTION).
 *   H) review com preco=0 → card enviado com alerta de preço AUSENTE;
 *      a publicação só falha no confirm_pub (fail-closed do pipeline).
 *
 * PREVIEW ≠ PUBLICATION · DECISION ≠ ACTION · approval humana obrigatória.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PendingReview, setTestTelegramSenders } from "../server/services/telegramBot";
import {
  setTestSavePendingReview,
  setTestGetPendingReview,
} from "../server/repositories/telegramRepository";
import {
  createProductionProductPipeline,
  setTestProductPipeline,
  ProductPipeline,
} from "../server/services/productPipeline";
import { handleTelegramWebhookUpdate } from "../server/services/telegramBot";

// ============================================================================
// 1. Fake do transporte Telegram (sendMessage) e persistência do repositório.
// ============================================================================
const TELEGRAM_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "1976526372";
// TELEGRAM_BOT_TOKEN precisa existir para sendTelegramMessage sair do early
// return (getTelegramBotToken() === "" → sem envio). O fake do fetch só é
// atingido quando o token está presente.
const ORIGINAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "fake-bot-token";

let sentMessages: Array<{ chatId: number; text: string; keyboard?: any }> = [];
function installFakeTelegramTransport(): () => void {
  sentMessages = [];
  setTestTelegramSenders(
    async (chatId: number, text: string, replyMarkup?: any) => {
      sentMessages.push({ chatId, text, keyboard: replyMarkup });
    },
    async () => {},
  );
  return () => {
    setTestTelegramSenders(null, null);
    sentMessages = [];
  };
}

type FakeReview = PendingReview & { [key: string]: any };
const reviewsById = new Map<string, FakeReview>();
let saveCallCount = 0;
let savedReviews: PendingReview[] = [];

// O módulo productAutomation é importado dinamicamente ANTES do primeiro teste
// (módulo ESM — require() não está disponível neste runner).
let productAutomationModule: { setTestFindExistingProduct?: (fn: ((...args: any[]) => Promise<null>) | null) => void } | null = null;

/**
 * Pipeline em memória: o evaluate real roda (validação canônica), mas o
 * getProducts usa catálogo vazio e o publish NUNCA toca o Supabase/gateway
 * (apenas avança o record para PUBLISHED com publishedProductId fake).
 */
function buildInMemoryPipeline(): ProductPipeline {
  // Cria uma nova instância do pipeline canônico com adapters em memória
  // (o evaluate/validate curadoria rodam de verdade, o banco nunca é tocado).
  return new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async (candidate: any) => ({
      id: `mem_${candidate.produto?.slice(0, 10)}_${Date.now()}`,
      ...candidate,
      status: "approved",
      ref: "MEMREF",
    }),
    syncAndValidatePublication: async (product: any, operationId: string) => ({
      success: true,
      operationId,
      diagnostic: undefined,
    }),
    pauseCanonicalProduct: async () => {},
  });
}

async function installFakeProductPipeline(): Promise<void> {
  setTestProductPipeline(buildInMemoryPipeline);
  if (!productAutomationModule) {
    productAutomationModule = (await import("../server/services/productAutomation")) as any;
  }
  if (typeof productAutomationModule.setTestFindExistingProduct === "function") {
    productAutomationModule.setTestFindExistingProduct(
      async (normalizedUrl: string, marketplaceId?: string | null, slug?: string | null, cleanedTitle?: string | null) => null,
    );
  }
}

function restoreFindExistingProduct(): void {
  if (!productAutomationModule) return;
  if (typeof productAutomationModule.setTestFindExistingProduct === "function") {
    productAutomationModule.setTestFindExistingProduct(null);
  }
}

function installFakeTelegramRepo(): void {
  reviewsById.clear();
  savedReviews = [];
  saveCallCount = 0;
  setTestSavePendingReview(async (review: PendingReview) => {
    const r = review as unknown as FakeReview;
    reviewsById.set(r.id, r);
    savedReviews.push(review);
    saveCallCount += 1;
  });
  setTestGetPendingReview(async (reviewId: string) => reviewsById.get(reviewId) ?? null);
}

function restoreAll(): void {
  setTestSavePendingReview(null);
  setTestGetPendingReview(null);
}

function buildPendingReview(partial: Partial<FakeReview>): FakeReview {
  return {
    id: "affprev-test-01",
    chatId: Number(TELEGRAM_ALLOWED_USERS),
    senderId: Number(TELEGRAM_ALLOWED_USERS),
    firstName: "admin",
    username: "admin",
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    produto: "Porta Talher Madeira Nobre Teste",
    categoria: "affiliate_preview",
    preco: 79.9,
    imagens: ["https://down-br.img.susercontent.com/file/sg-test"],
    normalizedUrl: "https://shopee.com.br/product/1530442944/23794344926",
    descricao: "affiliate_preview · source=affiliate_preview",
    status: "pending",
    existingProduct: { source: "affiliate_preview", affiliateUrl: "https://s.shopee.com.br/default-affiliate", priceScaleVerified: false },
    ...partial,
  } as FakeReview;
}

const adminUserId = Number(TELEGRAM_ALLOWED_USERS);

test.before(async () => {
  // Pré-carregar o módulo antes dos testes (uma única vez, sem require).
  if (!productAutomationModule) {
    productAutomationModule = (await import("../server/services/productAutomation")) as any;
  }
});

test.beforeEach(async () => {
  installFakeTelegramRepo();
  await installFakeProductPipeline();
});

test.afterEach(async () => {
  restoreAll();
  setTestProductPipeline(null);
  restoreFindExistingProduct();
  if (ORIGINAL_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_TOKEN;
});

// ============================================================================
// 2. Testes
// ============================================================================
test("/publicar sem reviewId entrega sintaxe e NÃO escreve nada", async () => {
  const cleanup = installFakeTelegramTransport();
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: "/publicar",
        message_id: 1,
      },
    });
    assert.equal(saveCallCount, 0, "NENHUMA escrita de review sem id");
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /Sintaxe/i, "mensagem de sintaxe entregue");
    assert.match(msg.text, /NUNCA publica automaticamente/i, "governança comunicada");
  } finally {
    cleanup();
  }
});

test("/publicar com reviewId inexistente avisa e NÃO escreve", async () => {
  const cleanup = installFakeTelegramTransport();
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: "/publicar affprev-nao-existe",
        message_id: 2,
      },
    });
    assert.equal(saveCallCount, 0, "review inexistente não gera escrita");
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /Review não localizada/i, "aviso de review ausente");
    assert.doesNotMatch(msg.text, /Confirmar/i, "nenhum card de confirmação sem review");
  } finally {
    cleanup();
  }
});

test("/publicar bloqueia review cancelada e NÃO escreve", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-cancel";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "cancelled" }));
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: `/publicar ${reviewId}`,
        message_id: 3,
      },
    });
    assert.equal(saveCallCount, 0, "review cancelada não gera escrita");
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /cancelada/i, "bloqueio comunicado");
  } finally {
    cleanup();
  }
});

test("/publicar bloqueia review expirada e NÃO escreve", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-expired";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "pending", expiresAt: Date.now() - 1000 }));
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: `/publicar ${reviewId}`,
        message_id: 4,
      },
    });
    assert.equal(saveCallCount, 0, "review expirada não gera escrita");
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /expirada/i, "expiração comunicada");
  } finally {
    cleanup();
  }
});

test("/publicar encaminha review pendente ao card de confirmação canônico", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-ok";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "pending" }));
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: `/publicar ${reviewId}`,
        message_id: 5,
      },
    });
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /ENCAMINHAMENTO À PUBLICAÇÃO/i, "card de encaminhamento enviado");
    assert.match(msg.text, new RegExp(reviewId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")), "reviewId apresentado no card");
    // Teclado canônico com confirmação humana obrigatória.
    const buttons = (msg.keyboard?.inline_keyboard ?? []).flat().map((b: any) => b.text);
    assert.ok(buttons.some((b: string) => b.includes("Confirmar & Publicar")), "card com [✅ Confirmar & Publicar]");
    // Lifecycle prévio registrado para reutilização do confirm_pub.
    const saved = savedReviews.find((r) => r.id === reviewId);
    assert.ok(saved?.lifecycle, "lifecycle prévio persistido");
  } finally {
    cleanup();
  }
});

test("/publicar encaminha review já aprovada (published) — decisão humana registrada", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-approved";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "published" }));
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: `/publicar ${reviewId}`,
        message_id: 6,
      },
    });
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /ENCAMINHAMENTO/i, "encaminhamento aceito para review aprovada");
    const buttons = (msg.keyboard?.inline_keyboard ?? []).flat().map((b: any) => b.text);
    assert.ok(buttons.some((b: string) => b.includes("Confirmar & Publicar")));
  } finally {
    cleanup();
  }
});

test("/publicar NÃO executa pipeline.publish — DECISION ≠ ACTION", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-noaction";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "pending" }));
  const pipeline = createProductionProductPipeline();
  let publishInvoked = false;
  const originalPublish = pipeline.publish.bind(pipeline);
  pipeline.publish = ((...args: unknown[]) => {
    publishInvoked = true;
    return originalPublish(...args);
  }) as never;
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: `/publicar ${reviewId}`,
        message_id: 7,
      },
    });
    assert.equal(publishInvoked, false, "pipeline.publish NÃO foi executado pelo /publicar");
    const saved = savedReviews.find((r) => r.id === reviewId);
    assert.notEqual(saved?.status, "published", "status da review NÃO mudou para published");
  } finally {
    pipeline.publish = originalPublish;
    cleanup();
  }
});

test("/publicar com preco=0 entrega alerta de preço AUSENTE e mantém fail-closed", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-noprice";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "pending", preco: 0, imagens: [] }));
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: `/publicar ${reviewId}`,
        message_id: 8,
      },
    });
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /AUSENTE/i, "preço ausente explicitamente reportado");
    assert.match(msg.text, /Alterar Preço/i, "caminho corretivo indicado");
    // O card AINDA é enviado (a decisão humana permanece obrigatória), mas o
    // pipeline falhará fail-closed no confirm_pub — validado separadamente no
    // fluxo do callback (previewTelegramRoutes.test.ts).
    const buttons = (msg.keyboard?.inline_keyboard ?? []).flat().map((b: any) => b.text);
    assert.ok(buttons.some((b: string) => b.includes("Alterar Preço")));
  } finally {
    cleanup();
  }
});

test("/publicar é rejeitado para usuário não autorizado", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-unauth";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "pending" }));
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: 99999, first_name: "intruso" },
        chat: { id: 99999 },
        text: `/publicar ${reviewId}`,
        message_id: 9,
      },
    });
    assert.equal(saveCallCount, 0, "usuário não autorizado não gera escrita");
    const unauthorizedMsg = sentMessages.find((m) => /Acesso Negado/i.test(m.text));
    assert.ok(unauthorizedMsg, "mensagem de acesso negado entregue");
  } finally {
    cleanup();
  }
});

test("confirm_pub publica com o affiliate link oficial como link do produto e descrição pública limpa", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-affiliate";
  const affiliateUrl = "https://s.shopee.com.br/40ftCq9rTu";
  reviewsById.set(reviewId, buildPendingReview({
    id: reviewId,
    status: "pending",
    descricao: "affiliate_preview · source=/shopee · batch=shopee-test · link oficial retornado pela Affiliate API: " + affiliateUrl,
    existingProduct: { source: "affiliate_preview", affiliateUrl, priceScaleVerified: false },
  }));
  let capturedCandidate: any = null;
  setTestProductPipeline(() => new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async (candidate: any) => {
      capturedCandidate = candidate;
      return {
        ...candidate,
        id: `mem_${candidate.produto?.slice(0, 10)}_${Date.now()}`,
        status: "approved",
        ref: "MEMREF",
      };
    },
    syncAndValidatePublication: async (product: any, operationId: string) => ({ success: true, operationId, diagnostic: undefined }),
    pauseCanonicalProduct: async () => {},
  }));
  try {
    // Simula o callback canônico confirm_pub via handleTelegramWebhookUpdate
    // (o mesmo caminho executado pelo botão [✅ Confirmar & Publicar]).
    await handleTelegramWebhookUpdate({
      callback_query: {
        from: { id: adminUserId },
        message: { chat: { id: adminUserId }, message_id: 50, text: "placeholder" },
        data: `confirm_pub:${reviewId}`,
      } as any,
    });
    assert.ok(capturedCandidate, "candidate foi persistido pelo publish canônico");
    assert.equal(
      capturedCandidate.link,
      affiliateUrl,
      "link do produto = affiliate link oficial da review (autoridade)",
    );
    assert.equal(
      capturedCandidate.normalizedUrl,
      "https://shopee.com.br/product/1530442944/23794344926",
      "URL pública canônica preservada em normalizedUrl para auditoria/deduplicação",
    );
    assert.equal(capturedCandidate.descricao, "", "descrição pública vazia quando o conteúdo é proveniência raw");
    assert.equal(capturedCandidate.categoria, "Afiliado", "categoria interna 'affiliate_preview' mapeada para a apresentação pública");
    assert.ok(
      sentMessages.some((message) => /PEÇA PUBLICADA COM SUCESSO/i.test(message.text)),
      "confirmação de sucesso é enviada como nova mensagem tanto para card de foto quanto de texto",
    );
  } finally {
    setTestProductPipeline(null);
    cleanup();
  }
});

test("confirm_pub preserva descrição, preço, título editorial e link oficial na publicação", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-legit";
  reviewsById.set(reviewId, buildPendingReview({
    id: reviewId,
    status: "pending",
    produto: "Luminária de mesa observada no anúncio",
    rawTitle: "Luminária de mesa observada no anúncio",
    displayTitle: "Luminária de Mesa Bauhaus",
    preco: 264,
    descricao: "Organizador de talheres em madeira nobre com suporte de vidro. Peça elegante para mesas postas.",
    existingProduct: { source: "affiliate_preview", affiliateUrl: "https://s.shopee.com.br/legit", priceScaleVerified: false },
  }));
  let capturedCandidate: any = null;
  setTestProductPipeline(() => new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async (candidate: any) => {
      capturedCandidate = candidate;
      return { ...candidate, id: `mem_${Date.now()}`, status: "approved", ref: "MEMREF" };
    },
    syncAndValidatePublication: async (product: any, operationId: string) => ({ success: true, operationId, diagnostic: undefined }),
    pauseCanonicalProduct: async () => {},
  }));
  try {
    await handleTelegramWebhookUpdate({
      callback_query: {
        from: { id: adminUserId },
        message: { chat: { id: adminUserId }, message_id: 51, text: "placeholder" },
        data: `confirm_pub:${reviewId}`,
      } as any,
    });
    assert.equal(
      capturedCandidate.descricao,
      "Organizador de talheres em madeira nobre com suporte de vidro. Peça elegante para mesas postas.",
      "descrição legítima preservada — fail-closed nunca inventa nem apaga conteúdo real",
    );
    assert.equal(capturedCandidate.rawTitle, "Luminária de mesa observada no anúncio");
    assert.equal(capturedCandidate.displayTitle, "Luminária de Mesa Bauhaus");
    assert.equal(capturedCandidate.preco, 264);
    assert.equal(capturedCandidate.link, "https://s.shopee.com.br/legit");
  } finally {
    setTestProductPipeline(null);
    cleanup();
  }
});

test("confirm_pub bloqueia a review Shopee sem link de afiliado antes da persistência canônica", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-without-affiliate";
  reviewsById.set(reviewId, buildPendingReview({
    id: reviewId,
    existingProduct: { source: "affiliate_preview", priceScaleVerified: false },
  }));
  let createCanonicalProductCalls = 0;
  setTestProductPipeline(() => new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async () => {
      createCanonicalProductCalls += 1;
      throw new Error("não deveria persistir produto");
    },
    syncAndValidatePublication: async () => ({ success: true }),
    pauseCanonicalProduct: async () => {},
  }));
  try {
    await handleTelegramWebhookUpdate({
      callback_query: {
        from: { id: adminUserId },
        message: { chat: { id: adminUserId }, message_id: 54, text: "placeholder" },
        data: `confirm_pub:${reviewId}`,
      } as any,
    });
    assert.equal(createCanonicalProductCalls, 0, "nenhum produto parcial é criado");
    assert.equal(reviewsById.get(reviewId)?.status, "error");
    assert.ok(sentMessages.some((message) => /AFFILIATE_LINK_REQUIRED/.test(message.text)));
  } finally {
    setTestProductPipeline(null);
    cleanup();
  }
});

test("confirm_pub bloqueia novo clique enquanto a mesma review está em publicação", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-publishing-lock";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "publishing" }));
  try {
    await handleTelegramWebhookUpdate({
      callback_query: {
        from: { id: adminUserId },
        message: { chat: { id: adminUserId }, message_id: 52, text: "placeholder" },
        data: `confirm_pub:${reviewId}`,
      } as any,
    });
    assert.equal(saveCallCount, 0, "nenhuma persistência canônica inicia em clique concorrente");
    assert.ok(sentMessages.some((message) => /já está em publicação/i.test(message.text)));
  } finally {
    cleanup();
  }
});

test("confirm_pub marca review como erro e informa falha quando a sincronização não é confirmada", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-sync-failure";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "pending" }));
  setTestProductPipeline(() => new ProductPipeline({
    getProducts: async () => [],
    createCanonicalProduct: async (candidate: any) => ({ ...candidate, id: "mem-sync-failure", ref: "MEMREF", status: "approved" }),
    syncAndValidatePublication: async (_product: any, operationId: string) => ({
      success: false,
      operationId,
      error: "GITHUB_SYNC_ERROR",
    }),
    pauseCanonicalProduct: async () => {},
  }));
  try {
    await handleTelegramWebhookUpdate({
      callback_query: {
        from: { id: adminUserId },
        message: { chat: { id: adminUserId }, message_id: 53, text: "placeholder" },
        data: `confirm_pub:${reviewId}`,
      } as any,
    });
    assert.equal(reviewsById.get(reviewId)?.status, "error");
    assert.ok(sentMessages.some((message) => /PUBLICAÇÃO NÃO CONCLUÍDA/i.test(message.text)));
    assert.ok(!sentMessages.some((message) => /PEÇA PUBLICADA COM SUCESSO/i.test(message.text)));
  } finally {
    setTestProductPipeline(null);
    cleanup();
  }
});

test("/publicar preserva escala não verificada no preço exibido", async () => {
  const cleanup = installFakeTelegramTransport();
  const reviewId = "affprev-scale";
  reviewsById.set(reviewId, buildPendingReview({ id: reviewId, status: "pending", preco: 79.9 }));
  try {
    await handleTelegramWebhookUpdate({
      message: {
        from: { id: adminUserId, first_name: "admin" },
        chat: { id: adminUserId },
        text: `/publicar ${reviewId}`,
        message_id: 10,
      },
    });
    const msg = sentMessages[sentMessages.length - 1];
    assert.match(msg.text, /escala não verificada/i, "escala não verificada sempre explícita");
    // O preço NUNCA é rotulado como moeda BRL neste caminho (o card de
    // confirmação também não rotula — ver previewTelegramRoutes.test.ts).
    assert.doesNotMatch(msg.text, /R\$\s79/, "preço não apresentado como moeda");
  } finally {
    cleanup();
  }
});
