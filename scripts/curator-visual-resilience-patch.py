from pathlib import Path
import re

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing expected block in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    p = ROOT / path
    text = p.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'expected one regex match in {path}, got {count}')
    p.write_text(updated)


# 1) Make image-review failure reasons observable instead of collapsing every
# operational problem into image_review_unavailable.
replace_once(
    'src/lib/productImageCuration.ts',
    '  reason?: "no_images" | "no_commercial_image" | "image_review_unavailable";\n',
    '  reason?: "no_images" | "no_commercial_image" | "image_review_unavailable" | "image_review_budget_exhausted" | "image_fetch_unavailable" | "image_review_model_unavailable";\n',
)

# 2) Dedicated resilient visual reviewer. Individual broken CDN images no longer
# invalidate the complete candidate, and image-review calls have their own bounded
# hourly budget so editorial-copy calls cannot starve them.
(ROOT / 'server/services/productImageReview.ts').write_text(r'''import { GoogleGenAI } from "@google/genai";
import {
  curateProductImages,
  type ProductImageAssessment,
  type ProductImageCuration,
} from "../../src/lib/productImageCuration";
import { ExternalCallBudget, type BudgetDecision } from "./operationalGuards";
import { repairProductImage, type ProductImageRepairResult } from "./productImageRepair";

type BudgetLike = {
  reserve(name: string, amount?: number): BudgetDecision;
};

type GenerateContent = (request: Record<string, unknown>) => Promise<{ text?: string | null }>;
type RepairImage = (options: Parameters<typeof repairProductImage>[0]) => Promise<ProductImageRepairResult | null>;

type ReviewOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  generateContent?: GenerateContent;
  repairImage?: RepairImage;
  budget?: BudgetLike;
  allowRepair?: boolean;
  maxImages?: number;
  timeoutMs?: number;
};

type DownloadedImage = {
  url: string;
  mimeType: string;
  data: string;
};

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const productionImageReviewBudget = new ExternalCallBudget(
  {
    productImageReview: positiveInt(process.env.GEMINI_PRODUCT_IMAGE_REVIEW_HOURLY_BUDGET, 72),
  },
  60 * 60 * 1000,
);

function reviewRequired(
  rawImageUrls: string[],
  reason: NonNullable<ProductImageCuration["reason"]>,
  assessments: ProductImageAssessment[] = [],
): ProductImageCuration {
  return {
    status: "review_required",
    rawImageUrls,
    galleryImageUrls: [],
    assessments,
    reason,
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadImage(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<DownloadedImage | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        headers: {
          Accept: "image/avif,image/webp,image/jpeg,image/png",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",
          "User-Agent": "Mozilla/5.0 (compatible; CerberusFinds/1.0; +https://cerberusfinds.com)",
        },
        signal: controller.signal,
      });
      const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
      if (!response.ok || !/^image\/(?:avif|webp|jpeg|png)$/.test(mimeType)) {
        if (attempt === 0 && response.status >= 500) {
          await delay(120);
          continue;
        }
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null;
      return { url, mimeType, data: bytes.toString("base64") };
    } catch {
      if (attempt === 0) {
        await delay(120);
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function downloadReviewableImages(
  rawImageUrls: string[],
  fetchImpl: typeof fetch,
  maxImages: number,
  timeoutMs: number,
): Promise<DownloadedImage[]> {
  const selected = rawImageUrls.slice(0, Math.max(1, maxImages));
  const outcomes = await Promise.all(selected.map(url => downloadImage(url, fetchImpl, timeoutMs)));
  return outcomes.filter((item): item is DownloadedImage => Boolean(item));
}

function parseAssessments(rawImageUrls: string[], downloaded: DownloadedImage[], value: unknown): ProductImageAssessment[] {
  const parsed = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const modelAssessments = Array.isArray(parsed.images) ? parsed.images : [];
  const allowedDecisions = new Set<ProductImageAssessment["decision"]>([
    "clean", "technical", "promotional", "logo", "collage", "screenshot", "unknown",
  ]);
  const allowedConfidence = new Set<ProductImageAssessment["confidence"]>(["HIGH", "MEDIUM", "LOW"]);

  return downloaded.map((image, index) => {
    const item = modelAssessments.find(candidate =>
      candidate && typeof candidate === "object" && Number((candidate as Record<string, unknown>).index) === index + 1,
    ) as Record<string, unknown> | undefined;
    const decisionText = String(item?.decision || "unknown") as ProductImageAssessment["decision"];
    const confidenceText = String(item?.confidence || "LOW") as ProductImageAssessment["confidence"];
    return {
      url: image.url,
      decision: allowedDecisions.has(decisionText) ? decisionText : "unknown",
      confidence: allowedConfidence.has(confidenceText) ? confidenceText : "LOW",
      reason: typeof item?.reason === "string" ? item.reason.slice(0, 180) : "Avaliação visual insuficiente.",
    };
  }).filter(item => rawImageUrls.includes(item.url));
}

export async function reviewProductImages(
  rawImages: readonly string[],
  title: string,
  options: ReviewOptions = {},
): Promise<ProductImageCuration> {
  const rawImageUrls = curateProductImages(rawImages).rawImageUrls;
  if (rawImageUrls.length === 0) return curateProductImages(rawImageUrls);

  const env = options.env || process.env;
  const apiKey = String(env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return reviewRequired(rawImageUrls, "image_review_unavailable");

  const budget = options.budget || productionImageReviewBudget;
  const reserved = budget.reserve("productImageReview");
  if (!reserved.allowed) return reviewRequired(rawImageUrls, "image_review_budget_exhausted");

  const fetchImpl = options.fetchImpl || fetch;
  const maxImages = options.maxImages || positiveInt(env.GEMINI_PRODUCT_IMAGE_REVIEW_MAX_IMAGES, 6);
  const timeoutMs = options.timeoutMs || positiveInt(env.GEMINI_PRODUCT_IMAGE_FETCH_TIMEOUT_MS, 10_000);
  const downloaded = await downloadReviewableImages(rawImageUrls, fetchImpl, maxImages, timeoutMs);
  if (downloaded.length === 0) return reviewRequired(rawImageUrls, "image_fetch_unavailable");

  try {
    const prompt = `Avalie TODAS as imagens numeradas deste produto para seleção comercial de catálogo. Produto: ${title || "sem título"}. Para cada imagem, classifique somente como clean, technical, promotional, logo, collage, screenshot ou unknown. Rejeite medidas, dimensões, setas, textos promocionais, selos, logos, marcas d'água, molduras técnicas, colagens e screenshots. clean exige apresentação clara do produto, sem overlay visível, com confiança HIGH ou MEDIUM. Não invente características. Retorne JSON: {"images":[{"index":1,"decision":"clean|technical|promotional|logo|collage|screenshot|unknown","confidence":"HIGH|MEDIUM|LOW","reason":"motivo factual curto"}]}. Inclua exatamente uma entrada para cada imagem recebida.`;
    const request: Record<string, unknown> = {
      model: env.GEMINI_PRODUCT_IMAGE_REVIEW_MODEL || env.GEMINI_PRODUCT_CURATOR_MODEL || "gemini-3.6-flash",
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          ...downloaded.map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
        ],
      }],
      config: { responseMimeType: "application/json" },
    };
    const generateContent: GenerateContent = options.generateContent || (async input => {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { "User-Agent": "aistudio-build" } },
      });
      return ai.models.generateContent(input as any) as Promise<{ text?: string | null }>;
    });
    const response = await generateContent(request);
    const parsed = JSON.parse(response.text || "{}");
    const assessments = parseAssessments(rawImageUrls, downloaded, parsed);
    const curation = curateProductImages(rawImageUrls, assessments);
    if (curation.status === "ready" || options.allowRepair === false) return curation;

    const repairImage = options.repairImage || repairProductImage;
    const repaired = await repairImage({
      rawImageUrls: downloaded.map(image => image.url),
      title,
      assessments,
      env,
      fetchImpl,
    });
    if (!repaired) return curation;

    // Generated/edited imagery is never trusted directly. It must pass the
    // exact same reviewer once more before it can become canonical.
    const repairedCuration = await reviewProductImages([repaired.url], title, {
      ...options,
      env,
      fetchImpl,
      budget,
      allowRepair: false,
    });
    if (repairedCuration.status !== "ready" || !repairedCuration.primaryImageUrl) return curation;
    return {
      status: "ready",
      rawImageUrls: [...rawImageUrls, repaired.url],
      primaryImageUrl: repairedCuration.primaryImageUrl,
      galleryImageUrls: repairedCuration.galleryImageUrls,
      assessments: [...assessments, ...repairedCuration.assessments],
    };
  } catch (error) {
    console.warn(`[Product Image Review] modelo indisponível: ${error instanceof Error ? error.message : "erro desconhecido"}`);
    return reviewRequired(rawImageUrls, "image_review_model_unavailable");
  }
}

export const productImageReviewInternals = {
  downloadImage,
  downloadReviewableImages,
  parseAssessments,
  positiveInt,
};
''')

# 3) Replace the fragile in-file reviewer with the resilient dedicated service,
# and isolate the editorial-copy budget from visual review.
replace_once(
    'server/services/productAutomation.ts',
    'import { curateProductImages, type ProductImageAssessment, type ProductImageCuration } from "../../src/lib/productImageCuration";\nimport { repairProductImage } from "./productImageRepair";\n',
    'import { curateProductImages, type ProductImageCuration } from "../../src/lib/productImageCuration";\nimport { reviewProductImages } from "./productImageReview";\n',
)
replace_once(
    'server/services/productAutomation.ts',
    'const geminiBudget = new ExternalCallBudget(\n  { gemini: Number.parseInt(process.env.GEMINI_HOURLY_BUDGET || "20", 10) },\n  60 * 60 * 1000,\n);\n',
    'function productCuratorBudgetLimit(value: unknown, fallback = 50): number {\n  const parsed = Number.parseInt(String(value ?? ""), 10);\n  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;\n}\n\nconst productCuratorBudget = new ExternalCallBudget(\n  { productCurator: productCuratorBudgetLimit(process.env.GEMINI_PRODUCT_CURATOR_HOURLY_BUDGET) },\n  60 * 60 * 1000,\n);\n',
)
regex_once(
    'server/services/productAutomation.ts',
    r'async function reviewScrapedImages\(rawImages: string\[\], title: string, allowRepair = true\): Promise<ProductImageCuration> \{.*?\n\}\n\n/\*\*\n \* Normaliza',
    '''async function reviewScrapedImages(rawImages: string[], title: string, allowRepair = true): Promise<ProductImageCuration> {
  const rawImageUrls = curateProductImages(rawImages).rawImageUrls;
  if (testOverrideImageReview) return testOverrideImageReview(rawImageUrls, title);
  return reviewProductImages(rawImageUrls, title, { allowRepair });
}

/**
 * Normaliza''',
)
replace_once(
    'server/services/productAutomation.ts',
    '      const budget = geminiBudget.reserve("gemini");\n',
    '      const budget = productCuratorBudget.reserve("productCurator");\n',
)

# 4) Make repair acquisition use the same browser-compatible fetch posture and
# keep image-generation fallback bounded independently.
replace_once(
    'server/services/productImageRepair.ts',
    'import type { ProductImageAssessment } from "../../src/lib/productImageCuration";\n',
    'import type { ProductImageAssessment } from "../../src/lib/productImageCuration";\nimport { ExternalCallBudget } from "./operationalGuards";\n',
)
replace_once(
    'server/services/productImageRepair.ts',
    'type RepairOptions = {\n',
    'function positiveRepairBudget(value: unknown, fallback = 24): number {\n  const parsed = Number.parseInt(String(value ?? ""), 10);\n  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;\n}\n\nconst imageRepairBudget = new ExternalCallBudget(\n  { imageRepair: positiveRepairBudget(process.env.GEMINI_PRODUCT_IMAGE_REPAIR_HOURLY_BUDGET) },\n  60 * 60 * 1000,\n);\n\ntype RepairOptions = {\n',
)
replace_once(
    'server/services/productImageRepair.ts',
    '  if (!apiKey || !supabaseUrl || !serviceRole) return null;\n\n  const sourceUrl = chooseRepairSource(options.rawImageUrls, options.assessments);\n',
    '  if (!apiKey || !supabaseUrl || !serviceRole) return null;\n  if (!imageRepairBudget.reserve("imageRepair").allowed) return null;\n\n  const sourceUrl = chooseRepairSource(options.rawImageUrls, options.assessments);\n',
)
replace_once(
    'server/services/productImageRepair.ts',
    '    const response = await fetchImpl(sourceUrl, { headers: { Accept: "image/avif,image/webp,image/jpeg,image/png" } });\n',
    '    const response = await fetchImpl(sourceUrl, {\n      headers: {\n        Accept: "image/avif,image/webp,image/jpeg,image/png",\n        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.7",\n        "User-Agent": "Mozilla/5.0 (compatible; CerberusFinds/1.0; +https://cerberusfinds.com)",\n      },\n      signal: AbortSignal.timeout(10_000),\n    });\n',
)

# 5) max_enrich_per_category is a category-wide ceiling, not a per-query ceiling.
# Return the number actually examined and distribute the remaining budget across
# deterministic alternate queries.
replace_once(
    'server/services/autonomousCurator.ts',
    '}): Promise<{ candidate: CuratedCandidate | null; decision: "none" | "duplicate" | "reject" | "failed"; reason: string; rawTitle?: string | null; shopId?: string | null; itemId?: string | null; sourceUrl?: string | null }> {\n',
    '}): Promise<{ candidate: CuratedCandidate | null; decision: "none" | "duplicate" | "reject" | "failed"; reason: string; rawTitle?: string | null; shopId?: string | null; itemId?: string | null; sourceUrl?: string | null; examined: number }> {\n',
)
replace_once(
    'server/services/autonomousCurator.ts',
    '  if (!search.ok) return { candidate: null, decision: "failed", reason: `SHOPEE_SEARCH:${search.reason || "failed"}` };\n  if (search.items.length === 0) return { candidate: null, decision: "none", reason: "NO_OFFICIAL_CANDIDATES" };\n',
    '  if (!search.ok) return { candidate: null, decision: "failed", reason: `SHOPEE_SEARCH:${search.reason || "failed"}`, examined: 0 };\n  if (search.items.length === 0) return { candidate: null, decision: "none", reason: "NO_OFFICIAL_CANDIDATES", examined: 0 };\n',
)
replace_once(
    'server/services/autonomousCurator.ts',
    '  if (ranked.length === 0) return { candidate: null, decision: "none", reason: "NO_PROFILE_CANDIDATES" };\n',
    '  if (ranked.length === 0) return { candidate: null, decision: "none", reason: "NO_PROFILE_CANDIDATES", examined: 0 };\n',
)
replace_once(
    'server/services/autonomousCurator.ts',
    '      sourceUrl,\n    };\n  }\n\n  return { candidate: null, decision: lastReason === "SOURCE_IDENTITY_ALREADY_PUBLISHED" ? "duplicate" : "reject", reason: lastReason };\n',
    '      sourceUrl,\n      examined,\n    };\n  }\n\n  return { candidate: null, decision: lastReason === "SOURCE_IDENTITY_ALREADY_PUBLISHED" ? "duplicate" : "reject", reason: lastReason, examined };\n',
)
replace_once(
    'server/services/autonomousCurator.ts',
    '      for (const candidateQuery of queryOrder) {\n        query = candidateQuery;\n        const currentPrepared = await prepareCategoryCandidate({ profile, query, runId: open.run.id, config, existingProducts, client, deps });\n',
    '      let enrichRemaining = config.maxEnrichPerCategory;\n      for (let queryIndex = 0; queryIndex < queryOrder.length && enrichRemaining > 0; queryIndex += 1) {\n        const candidateQuery = queryOrder[queryIndex];\n        query = candidateQuery;\n        const queriesRemaining = queryOrder.length - queryIndex;\n        const maxEnrichThisQuery = Math.max(1, Math.ceil(enrichRemaining / queriesRemaining));\n        const currentPrepared = await prepareCategoryCandidate({\n          profile,\n          query,\n          runId: open.run.id,\n          config: { ...config, maxEnrichPerCategory: maxEnrichThisQuery },\n          existingProducts,\n          client,\n          deps,\n        });\n        enrichRemaining = Math.max(0, enrichRemaining - currentPrepared.examined);\n',
)

# 6) Regression tests for the real production failure mode.
(ROOT / 'tests/productImageReview.test.ts').write_text(r'''import test from "node:test";
import assert from "node:assert/strict";
import { reviewProductImages } from "../server/services/productImageReview";

const allowBudget = {
  reserve() {
    return { allowed: true, used: 1, limit: 100, resetAt: Date.now() + 60_000 };
  },
};

const denyBudget = {
  reserve() {
    return { allowed: false, used: 100, limit: 100, resetAt: Date.now() + 60_000 };
  },
};

function imageResponse(status = 200): Response {
  return new Response(new Uint8Array([1, 2, 3, 4]), {
    status,
    headers: { "content-type": "image/jpeg" },
  });
}

test("uma imagem CDN quebrada não invalida outra imagem revisável do mesmo produto", async () => {
  const bad = "https://cdn.example.test/bad.jpg";
  const good = "https://cdn.example.test/good.jpg";
  let generationCalls = 0;
  const result = await reviewProductImages([bad, good], "Abajur Cogumelo", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: allowBudget,
    allowRepair: false,
    timeoutMs: 50,
    fetchImpl: (async (url: string | URL | Request) => {
      if (String(url) === bad) return imageResponse(404);
      return imageResponse(200);
    }) as typeof fetch,
    generateContent: async () => {
      generationCalls += 1;
      return {
        text: JSON.stringify({
          images: [{ index: 1, decision: "clean", confidence: "HIGH", reason: "produto isolado" }],
        }),
      };
    },
  });
  assert.equal(generationCalls, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.primaryImageUrl, good);
  assert.deepEqual(result.rawImageUrls, [bad, good]);
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].url, good);
});

test("quando todas as imagens falham no CDN o motivo fica explícito e o Gemini não é chamado", async () => {
  let generationCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Produto", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: allowBudget,
    allowRepair: false,
    timeoutMs: 25,
    fetchImpl: (async () => imageResponse(404)) as typeof fetch,
    generateContent: async () => {
      generationCalls += 1;
      return { text: "{}" };
    },
  });
  assert.equal(generationCalls, 0);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_fetch_unavailable");
});

test("exaustão do orçamento visual é distinguida de falha de imagem", async () => {
  let fetchCalls = 0;
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Produto", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: denyBudget,
    allowRepair: false,
    fetchImpl: (async () => {
      fetchCalls += 1;
      return imageResponse(200);
    }) as typeof fetch,
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_review_budget_exhausted");
});

test("erro do modelo visual permanece fail-closed com motivo observável", async () => {
  const result = await reviewProductImages(["https://cdn.example.test/a.jpg"], "Produto", {
    env: { GEMINI_API_KEY: "test-key" },
    budget: allowBudget,
    allowRepair: false,
    fetchImpl: (async () => imageResponse(200)) as typeof fetch,
    generateContent: async () => {
      throw new Error("provider unavailable");
    },
  });
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "image_review_model_unavailable");
  assert.equal(result.primaryImageUrl, undefined);
});
''')

# 7) Permanent CI gate for this subsystem. Previously curator changes required an
# ad-hoc bootstrap workflow; this keeps focused + global validation permanently.
(ROOT / '.github/workflows/autonomous-curator-gate.yml').write_text(r'''name: Autonomous Curator Gate

on:
  pull_request:
    paths:
      - "server/services/autonomousCurator*.ts"
      - "server/services/productAutomation.ts"
      - "server/services/productImage*.ts"
      - "server/repositories/autonomousCuratorRepository.ts"
      - "src/lib/productImageCuration.ts"
      - "src/lib/productCanonical.ts"
      - "tests/autonomousCurator.test.ts"
      - "tests/productImage*.test.ts"
      - "tests/productCanonical.test.ts"
      - "supabase/migrations/*autonomous_curator*"
      - ".github/workflows/autonomous-curator*.yml"
      - "package.json"
      - "package-lock.json"
  push:
    branches:
      - main
    paths:
      - "server/services/autonomousCurator*.ts"
      - "server/services/productAutomation.ts"
      - "server/services/productImage*.ts"
      - "server/repositories/autonomousCuratorRepository.ts"
      - "src/lib/productImageCuration.ts"
      - "src/lib/productCanonical.ts"
      - "tests/autonomousCurator.test.ts"
      - "tests/productImage*.test.ts"
      - "tests/productCanonical.test.ts"
      - "supabase/migrations/*autonomous_curator*"
      - ".github/workflows/autonomous-curator*.yml"
      - "package.json"
      - "package-lock.json"

permissions:
  contents: read

concurrency:
  group: autonomous-curator-gate-${{ github.ref }}
  cancel-in-progress: true

jobs:
  curator-gate:
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    env:
      # Test-only authorization fixture required by the existing global suite.
      TELEGRAM_ALLOWED_USER_IDS: "1976526372"
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Focused curator and image tests
        run: >-
          node --import tsx/esm --test --test-concurrency=1
          tests/autonomousCurator.test.ts
          tests/productImageReview.test.ts
          tests/productImageRepair.test.ts
          tests/productCanonical.test.ts

      - name: TypeScript
        run: npm run lint

      - name: Global tests
        run: npm test

      - name: Production build
        run: npm run build

      - name: Diff check
        shell: bash
        run: |
          set -euo pipefail
          if git rev-parse HEAD^ >/dev/null 2>&1; then
            git diff --check HEAD^ HEAD
          else
            git diff --check
          fi

      - name: Reject skipped/todo/only tests
        shell: bash
        run: |
          set -euo pipefail
          if grep -R -n -E '\b(test|describe|it)\.(skip|todo|only)\b' tests --include='*.test.ts'; then
            echo "Forbidden skip/todo/only detected"
            exit 1
          fi

      - name: Secret scan changed content
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p /tmp/gitleaks-scan
          if git rev-parse HEAD^ >/dev/null 2>&1; then
            git diff --no-ext-diff HEAD^ HEAD > /tmp/gitleaks-scan/curator.patch
          else
            git show --format= --no-ext-diff HEAD > /tmp/gitleaks-scan/curator.patch
          fi
          curl -fsSL https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz -o /tmp/gitleaks.tar.gz
          tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks
          /tmp/gitleaks detect --no-git --source /tmp/gitleaks-scan --redact --exit-code 1
''')

print('curator visual resilience patch applied')
