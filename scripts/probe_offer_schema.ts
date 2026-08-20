// ============================================================================
// PROVA ÚNICA READ-ONLY — Fase 14 Opção B
//
// Objetivo: observar o schema real do nó de oferta de productOfferV2
// registrando SOMENTE nomes/paths/tipos dos campos.
//
// PROIBIDO:
//   - registrar/imprimir valores de preço reais
//   - registrar secrets/credentials
//   - qualquer efeito colateral (sem candidate/evidence/assessment)
//
// Execução: npx tsx scripts/probe_offer_schema.ts
// Saída:  docs/phase14_schema_probe_result.json  (apenas após sucesso)
// ============================================================================

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const API_URL = "https://open-api.affiliate.shopee.com.br/graphql";
const ITEM_ID = "23794344926";
const SHOP_ID = "1530442944";

// Selection set expandido — inclui os campos comerciais conhecidos pelo
// contrato local (price, productLink, offerLink, stockInfo) e nomes
// candidatos às dimensões N14 (seller/availability/commission/market).
// GraphQL ignora campos inexistentes na seleção, então campos rejeitados
// revelam ausência do contrato; campos aceitos revelam o shape real.
// Nenhum valor é registrado no output.
// Subset de campos: --base | --extra | --all (default: --all)
// --base: seleção comprovada da Fase 15/17 (regressão de contrato)
// --extra: campos candidatos às dimensões N14
// --all: união (descoberta)
const PROBE_QUERY = `
  { productOfferV2(itemId: ${ITEM_ID}, shopId: ${SHOP_ID}, limit: 1) { nodes { ${selectionSet()} } } }
`;

function selectionSet(): string {
  const args = process.argv.slice(2);
  const wantBase = args.includes("--base");
  const wantExtra = args.includes("--extra");
  const all = !wantBase && !wantExtra;
  const base = "itemId shopId productName price productLink offerLink";
  // Bissect dos candidatos às dimensões N14:
  //   --x1 = stockInfo, seller
  //   --x2 = sellerId, sellerName, sellerRating
  const x1 = "stockInfo seller";
  const x2 = "sellerId sellerName sellerRating";
  if (all) return `${base} ${x1} ${x2}`;
  if (wantBase && wantExtra) return `${base} ${x1} ${x2}`;
  if (wantBase) return base;
  if (args.includes("--x1")) return `${base} ${x1}`;
  if (args.includes("--x2")) return `${base} ${x2}`;
  // Campos isolados (base + 1 campo extra) — isolamento exato do 10010.
  const singles: Record<string, string> = {
    "--s1": "stockInfo",
    "--s2": "seller",
    "--s3": "sellerId",
    "--s4": "sellerName",
    "--s5": "sellerRating",
  };
  for (const [flag, field] of Object.entries(singles)) {
    if (args.includes(flag)) return `${base} ${field}`;
  }
  // Campo INVENTADO — teste de rejeição pré-análise vs. por campo.
  if (args.includes("--fake")) return `${base} fakeAvailability`;
  return `${base} ${x1} ${x2}`;
}

function envSanitize(v: string): boolean {
  return !!v && !/[\s]/.test(v);
}

async function run() {
  const appId = process.env.SHOPEE_AFFILIATE_APP_ID ?? "";
  const secret = process.env.SHOPEE_AFFILIATE_APP_SECRET ?? "";
  const presence = {
    SHOPEE_AFFILIATE_APP_ID: envSanitize(appId) ? "PRESENT" : "ABSENT",
    SHOPEE_AFFILIATE_APP_SECRET: envSanitize(secret) ? "PRESENT" : "ABSENT",
  };
  if (!appId || !secret) {
    const out = {
      proofRunId: "PHASE14_SCHEMA_PROBE_20260820",
      observedAt: new Date().toISOString(),
      status: "SKIPPED",
      reason: "credential_absent_in_execution_runtime",
      presence,
    };
    persist(out);
    process.exit(0);
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Contrato oficial: assinar o PAYLOAD JSON completo (body serializado),
  // exatamente como o cliente oficial (shopeeApiClient.ts).
  const payload = JSON.stringify({ query: PROBE_QUERY, variables: {} });
  const signatureInput = [appId, timestamp, payload, secret].join("");
  const signature = createHash("sha256").update(signatureInput).digest("hex");
  const authorization = `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let httpStatus: number | null = null;
  let parsed: unknown = null;
  let transportError: string | null = null;
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: payload,
      signal: controller.signal,
    });
    httpStatus = response.status;
    if (!response.ok) throw new Error(`http_${response.status}`);
    parsed = await response.json();
  } catch (err) {
    transportError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  if (transportError) {
    const out = {
      proofRunId: "PHASE14_SCHEMA_PROBE_20260820",
      observedAt: new Date().toISOString(),
      status: "TRANSPORT_FAILED",
      error: sanitizeError(transportError),
      presence,
    };
    persist(out);
    process.exit(1);
  }

  const schema = observeSchema(parsed);
  const out = {
    proofRunId: "PHASE14_SCHEMA_PROBE_20260820",
    observedAt: new Date().toISOString(),
    status: schema.ok ? "SCHEMA_OBSERVED" : "SCHEMA_NOT_OBSERVED",
    requestedItemId: ITEM_ID,
    requestedShopId: SHOP_ID,
    fields: schema.fields,
    nodeCount: schema.nodeCount,
    identityMatch: schema.identityMatch,
    errorCodes: schema.errorCodes,
    errorKeyCount: schema.errorKeyCount,
    topKeys: schema.topKeys,
    dataKeys: schema.dataKeys,
    httpStatus,
    presence,
    note: "no_price_values_logged; no_credentials_logged; zero_side_effects",
  };
  persist(out);
  process.exit(0);
}

function sanitizeError(message: string): string {
  // Remove qualquer fragmento que pareça segredo — apenas códigos/prefixos.
  return message.replace(/Credential=[^, ]+/g, "Credential=<redacted>")
    .replace(/Signature=[^, ]+/g, "Signature=<redacted>")
    .replace(/\b[A-Za-z0-9]{32,}\b/g, "<redacted>");
}

function observeSchema(json: unknown): {
  ok: boolean;
  fields: ReadonlyArray<{ path: string; type: string; present: boolean }>;
  nodeCount: number;
  identityMatch: boolean;
  errorCodes: ReadonlyArray<string>;
  errorKeyCount: number;
  topKeys: ReadonlyArray<string>;
  dataKeys: ReadonlyArray<string>;
} {
  const fields: { path: string; type: string; present: boolean }[] = [];
  let nodeCount = 0;
  let identityMatch = false;

  const nodes = (json as { data?: { productOfferV2?: { nodes?: unknown[] } } })?.data?.productOfferV2?.nodes;
  if (Array.isArray(nodes)) {
    nodeCount = nodes.length;
    const node = nodes[0];
    if (node && typeof node === "object") {
      identityMatch =
        String((node as Record<string, unknown>).itemId ?? "") === ITEM_ID &&
        String((node as Record<string, unknown>).shopId ?? "") === SHOP_ID;
      for (const key of Object.keys(node as Record<string, unknown>)) {
        fields.push({ path: `nodes.${key}`, type: describeType((node as Record<string, unknown>)[key]), present: true });
      }
    }
  }
  const errors = ((json as { errors?: unknown[] })?.errors) ?? [];
  const errorCodes: string[] = Array.isArray(errors)
    ? errors
        .map((e): string => {
          if (!e || typeof e !== "object") return "<no_code>";
          const obj = e as Record<string, unknown>;
          const candidate = obj?.code ?? obj?.errorCode ?? (obj?.extensions as Record<string, unknown> | undefined)?.code ?? "<no_code>";
          return String(candidate ?? "<no_code>");
        })
        .filter((c) => /^\d+$|^[A-Z_]+$|^<no_code>$/.test(c))
        .slice(0, 10)
    : [];
  const errorKeyCount = Array.isArray(errors) ? errors.length : 0;
  const topKeys: string[] =
    json && typeof json === "object"
      ? Object.keys(json as Record<string, unknown>).sort()
      : [];
  const dataKeys: string[] =
    json && typeof json === "object"
      ? Object.keys(((json as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>).sort()
      : [];
  const ok = nodeCount > 0 && fields.length > 0 && errors.length === 0;
  return { ok, fields, nodeCount, identityMatch, errorCodes, errorKeyCount, topKeys, dataKeys };
}

function describeType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string") {
    const isUrl = /^https?:\/\//i.test(String(value));
    return isUrl ? "string(url-like)" : value === "" ? "string(empty)" : "string(non-empty)";
  }
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (Array.isArray(value)) {
    const itemType = value.length > 0 ? describeType(value[0]) : "none";
    return `array[${value.length}]<${itemType}>`;
  }
  if (t === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort().join(",");
    return `object{${keys}}`;
  }
  return t;
}

function persist(out: unknown) {
  const dir = join(process.cwd(), "docs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(out, null, 2) + "\n";
  writeFileSync(join(dir, "phase14_schema_probe_result.json"), json);
  // Imprime o mesmo conteúdo sanitizado em stdout para que os logs do
  // runtime (incl. one-off job) registrem o resultado da prova.
  process.stdout.write(`[PROOF_OUTPUT]\n${json}[END_PROOF_OUTPUT]\n`);
}

void run();
