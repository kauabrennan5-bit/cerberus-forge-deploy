import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildActiveProductListView } from "../server/services/telegramBot";

const wrapperSource = readFileSync(new URL("../server/services/telegramBot.ts", import.meta.url), "utf8");
const cleanupSource = readFileSync(new URL("../server/services/rotationCandidateCleanup.ts", import.meta.url), "utf8");

test("Telegram Produtos mostra somente o catálogo ativo e publicado", () => {
  const view = buildActiveProductListView([
    { id: "active-1", ref: "REF-A", produto: "Produto ativo um", preco: 10, ativo: true, status: "published" },
    { id: "paused-1", ref: "ROTA-P", produto: "Candidato pausado", preco: 20, ativo: false, status: "paused" },
    { id: "archived-1", ref: "ROTA-X", produto: "Candidato rejeitado", preco: 30, ativo: false, status: "archived" },
    { id: "approved-1", ref: "REF-I", produto: "Produto não público", preco: 40, ativo: true, status: "approved" },
    { id: "active-2", ref: "REF-B", produto: "Produto ativo dois", preco: 50, ativo: true, status: "published" },
  ], 0);

  assert.equal(view.total, 2);
  assert.equal(view.totalPages, 1);
  assert.match(view.text, /PRODUTOS ATIVOS — 2 no catálogo/);
  assert.match(view.text, /Produto ativo um/);
  assert.match(view.text, /Produto ativo dois/);
  assert.doesNotMatch(view.text, /Candidato pausado|Candidato rejeitado|Produto não público/);
  assert.equal(view.keyboard.inline_keyboard.flat().some(button => button.text === "🟢 Ativar"), false);
});

test("comando Produtos e paginação passam pela visão ativa no wrapper do webhook", () => {
  assert.match(wrapperSource, /canonicalTelegramCommand\(parsed\.name\) !== "produtos"/);
  assert.match(wrapperSource, /renderActiveProductList\(0\)/);
  assert.match(wrapperSource, /data\.startsWith\("products_list:"\)/);
  assert.match(wrapperSource, /data\.startsWith\("product_toggle:"\)/);
  assert.match(wrapperSource, /await refreshActiveProductCallback\(update, data\)/);
});

test("limpeza física de candidato rejeitado é limitada a candidatos temporários inativos", () => {
  assert.match(cleanupSource, /created_by.*ROTATION_CANDIDATE_CREATED_BY/s);
  assert.match(cleanupSource, /product\.ativo !== false/);
  assert.match(cleanupSource, /DELETABLE_ROTATION_STATUSES/);
  assert.match(cleanupSource, /hasRotationReference\(productId\)/);
  assert.match(cleanupSource, /\.from\("products"\)\s*\.delete\(\)/s);
  assert.match(cleanupSource, /detachDisposableRotationCandidateForCancellation/);
  assert.match(cleanupSource, /candidate_product_id: null/);
});
