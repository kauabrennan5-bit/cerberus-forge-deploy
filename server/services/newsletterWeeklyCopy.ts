import { GoogleGenAI } from "@google/genai";
import type { Product } from "../../src/types";
import { ExternalCallBudget } from "./operationalGuards";

export type WeeklyNewsletterCopy = {
  subject: string;
  previewText: string;
  heroHeadline: string;
  heroBody: string;
  secondaryCaptions: Record<string, string>;
};

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || "",
  httpOptions: { headers: { "User-Agent": "aistudio-build" } },
});

const geminiBudget = new ExternalCallBudget(
  { gemini: Number.parseInt(process.env.GEMINI_HOURLY_BUDGET || "20", 10) },
  60 * 60 * 1000,
);

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function safeEditorialProduct(product: Product) {
  return {
    id: product.id,
    title: clean(product.displayTitle || product.produto, 120),
    category: clean(product.categoria, 80),
    description: clean(product.curatorNote || product.descricao, 500),
  };
}

export function buildWeeklyCopyPrompt(products: readonly Product[]): string {
  const safeProducts = products.map(safeEditorialProduct);
  return `Você é o curador editorial do Cerberus Finds. Use o MESMO tom direto, factual e curatorial já usado nas descrições do catálogo: sem hype, sem urgência artificial e sem inventar atributos.\n\nGere SOMENTE copy editorial para uma newsletter semanal. Você NÃO recebe preço, estoque, disponibilidade, frete ou links e está proibido de inventar qualquer um desses fatos. Não mencione preço, desconto, estoque, disponibilidade ou prazo.\n\nProdutos editoriais já validados:\n${JSON.stringify(safeProducts)}\n\nRetorne JSON estrito no formato:\n{\n  "subject":"até 90 caracteres",\n  "previewText":"até 140 caracteres",\n  "heroHeadline":"até 70 caracteres",\n  "heroBody":"1 ou 2 frases, até 220 caracteres",\n  "secondaryCaptions":{"PRODUCT_ID":"uma frase factual de até 120 caracteres"}\n}\n\nO primeiro produto é o destaque. Gere secondaryCaptions para todos os demais IDs, sem criar IDs novos.`;
}

function assertNoInventedCommercialFacts(value: string): void {
  if (/R\$\s*\d|\b(preço|estoque|em estoque|disponível agora|frete|desconto|cupom|por apenas)\b/i.test(value)) {
    throw new Error("WEEKLY_COPY_COMMERCIAL_FACT_FORBIDDEN");
  }
}

export function sanitizeWeeklyNewsletterCopy(value: unknown, products: readonly Product[]): WeeklyNewsletterCopy {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const subject = clean(raw.subject, 90);
  const previewText = clean(raw.previewText, 140);
  const heroHeadline = clean(raw.heroHeadline, 70);
  const heroBody = clean(raw.heroBody, 220);
  if (!subject || !previewText || !heroHeadline || !heroBody) throw new Error("WEEKLY_COPY_INCOMPLETE");

  const sourceCaptions = raw.secondaryCaptions && typeof raw.secondaryCaptions === "object"
    ? raw.secondaryCaptions as Record<string, unknown>
    : {};
  const secondaryCaptions: Record<string, string> = {};
  for (const product of products.slice(1)) {
    const caption = clean(sourceCaptions[product.id], 120);
    if (!caption) throw new Error(`WEEKLY_COPY_CAPTION_MISSING:${product.id}`);
    secondaryCaptions[product.id] = caption;
  }

  assertNoInventedCommercialFacts([subject, previewText, heroHeadline, heroBody, ...Object.values(secondaryCaptions)].join(" "));
  return { subject, previewText, heroHeadline, heroBody, secondaryCaptions };
}

export async function generateWeeklyNewsletterCopy(products: readonly Product[]): Promise<WeeklyNewsletterCopy> {
  if (products.length < 3 || products.length > 4) throw new Error("WEEKLY_COPY_PRODUCT_COUNT_INVALID");
  if (!process.env.GEMINI_API_KEY?.trim()) throw new Error("WEEKLY_COPY_GEMINI_NOT_CONFIGURED");
  const reservation = geminiBudget.reserve("gemini");
  if (!reservation.allowed) throw new Error("WEEKLY_COPY_GEMINI_BUDGET_EXCEEDED");

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.6-flash",
    contents: buildWeeklyCopyPrompt(products),
    config: { responseMimeType: "application/json" },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text || "{}");
  } catch {
    throw new Error("WEEKLY_COPY_INVALID_JSON");
  }
  return sanitizeWeeklyNewsletterCopy(parsed, products);
}
