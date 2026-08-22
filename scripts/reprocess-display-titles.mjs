/**
 * Reprocessador CONTROLADO de display_title.
 *
 * Este script não é chamado por build, bot, deploy ou pipeline. O modo padrão
 * só lista o escopo. A execução exige modelo explícito, confirmação explícita
 * de custo e a migration 20260822_product_display_title.sql já aplicada.
 *
 * Exemplos:
 *   node scripts/reprocess-display-titles.mjs --dry-run
 *   node scripts/reprocess-display-titles.mjs --execute --model <modelo-gemini> --confirm-model-cost --limit 10
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, Type } from "@google/genai";

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const dryRun = args.has("--dry-run") || !execute;
const modelIndex = process.argv.indexOf("--model");
const limitIndex = process.argv.indexOf("--limit");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : "";
const parsedLimit = limitIndex >= 0 ? Number.parseInt(process.argv[limitIndex + 1], 10) : 0;
const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 0;

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.");
}

const supabase = createClient(supabaseUrl, supabaseKey);

function normalizeDisplayTitle(value) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);
  if (normalized.length < 3 || normalized.length > 90 || words.length > 8) return "";
  return normalized;
}

async function loadEligibleProducts() {
  const query = supabase
    .from("products")
    .select("id,produto,raw_title,display_title,status,ativo")
    .eq("ativo", true)
    .eq("status", "published")
    .is("display_title", null)
    .order("created_at", { ascending: true });
  const { data, error } = limit > 0 ? await query.limit(limit) : await query;
  if (error) {
    throw new Error(`Não foi possível ler display_title. Confirme que a migration foi aplicada: ${error.message}`);
  }
  return data || [];
}

async function generateTitle(ai, rawTitle) {
  const response = await ai.models.generateContent({
    model,
    contents: `Título bruto do anúncio: ${JSON.stringify(rawTitle)}\n\nRetorne somente um título de exibição em PT-BR, de 6 a 8 palavras no máximo. Preserve apenas tipo e nome factual do produto. Remova marca, SKU, idioma estrangeiro, marketplace, promoção, frete e termos comerciais. Não invente atributos.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: { display_title: { type: Type.STRING } },
        required: ["display_title"],
      },
    },
  });
  const parsed = JSON.parse(response.text || "{}");
  return normalizeDisplayTitle(parsed.display_title);
}

const products = await loadEligibleProducts();
console.log(JSON.stringify({
  mode: dryRun ? "dry_run" : "execute",
  eligibleProducts: products.length,
  limit: limit || null,
  productIds: products.map((product) => product.id),
}, null, 2));

if (dryRun) {
  console.log("Nenhuma chamada Gemini e nenhuma atualização foram executadas. Para executar, revise modelo/custo e use --execute --model <modelo> --confirm-model-cost.");
  process.exit(0);
}

if (!args.has("--confirm-model-cost") || !model) {
  throw new Error("Execução bloqueada: informe --model <modelo-gemini> e --confirm-model-cost após revisar disponibilidade e custo.");
}
if (!process.env.GEMINI_API_KEY) {
  throw new Error("Execução bloqueada: GEMINI_API_KEY não configurada.");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const results = [];
for (const product of products) {
  const sourceTitle = String(product.raw_title || product.produto || "").trim();
  const displayTitle = await generateTitle(ai, sourceTitle);
  if (!displayTitle) {
    results.push({ id: product.id, status: "skipped_invalid_output" });
    continue;
  }
  const { error } = await supabase
    .from("products")
    .update({ raw_title: product.raw_title || sourceTitle, display_title: displayTitle })
    .eq("id", product.id);
  if (error) throw new Error(`Falha ao atualizar ${product.id}: ${error.message}`);
  results.push({ id: product.id, status: "updated", displayTitle });
}

console.log(JSON.stringify({ completed: true, results }, null, 2));
