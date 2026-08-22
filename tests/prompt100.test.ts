import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { getProductDisplayTitle } from "../src/lib/productPresentation";
import { normalizeCandidate } from "../server/services/productLifecycle";

const projectRoot = path.resolve(import.meta.dirname, "..");
const readProjectFile = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

test("título editorial é prioritário na vitrine e o título canônico é fallback", () => {
  assert.equal(getProductDisplayTitle({ produto: "Produto bruto com SKU X-900", displayTitle: "Luminária de Mesa Bauhaus" }), "Luminária de Mesa Bauhaus");
  assert.equal(getProductDisplayTitle({ produto: "Produto bruto com SKU X-900" }), "Produto bruto com SKU X-900");
});

test("candidato preserva títulos e nota editorial sem alterar os campos de validação", () => {
  const candidate = normalizeCandidate({
    normalizedUrl: "https://shopee.com.br/product/1/2",
    marketplace: "Shopee",
    produto: "Luminária Bauhaus Original SKU 123",
    rawTitle: "Luminária Bauhaus Original SKU 123",
    displayTitle: "Luminária de Mesa Bauhaus",
    curatorNote: "Peça de luz direta para leitura.",
    categoria: "Iluminação",
    preco: 199,
    imagens: ["https://cdn.example.com/item.jpg"],
    descricao: "Estrutura metálica com acabamento fosco.",
  });
  assert.equal(candidate.produto, "Luminária Bauhaus Original SKU 123");
  assert.equal(candidate.rawTitle, "Luminária Bauhaus Original SKU 123");
  assert.equal(candidate.displayTitle, "Luminária de Mesa Bauhaus");
  assert.equal(candidate.curatorNote, "Peça de luz direta para leitura.");
});

test("copy de produto não reintroduz ID técnico, benefício incompleto ou copy antiga", () => {
  const detail = readProjectFile("src/components/ProductDetail.tsx");
  const card = readProjectFile("src/components/ProductCard.tsx");
  assert.doesNotMatch(detail, /REG\.\s*\{?product\.id\}?/);
  assert.doesNotMatch(detail, /Envie/);
  assert.match(detail, /visiblePromotionBenefits/);
  assert.match(card, /PREÇO VERIFICADO/);
  assert.doesNotMatch(`${card}\n${detail}`, /OFERTA CONFIRMADA/);
});

test("contagem de categoria observa o catálogo carregado", () => {
  const grid = readProjectFile("src/components/ProductGrid.tsx");
  assert.match(grid, /useMemo\([\s\S]*?\[products\]\)/);
});

test("prévia Open Graph é limitada a crawlers e newsletter não expõe leitura pública", () => {
  const server = readProjectFile("server.ts");
  const newsletterMigration = readProjectFile("supabase/migrations/20260822_newsletter_subscribers.sql");
  assert.match(server, /app\.get\("\/produto\/:slug"/);
  assert.match(server, /isSocialCrawler/);
  assert.match(server, /og:type" content="product/);
  assert.match(server, /app\.post\("\/api\/newsletter"/);
  assert.match(newsletterMigration, /enable row level security/i);
  assert.match(newsletterMigration, /revoke all on table public\.newsletter_subscribers from anon, authenticated/i);
  assert.doesNotMatch(newsletterMigration, /create policy/i);
});

test("reprocessador de títulos permanece bloqueado por padrão", () => {
  const script = readProjectFile("scripts/reprocess-display-titles.mjs");
  assert.match(script, /--confirm-model-cost/);
  assert.match(script, /--dry-run/);
  assert.match(script, /Nenhuma chamada Gemini e nenhuma atualização foram executadas/);
});
