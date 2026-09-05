const backend = (process.env.BACKEND_BASE_URL || "https://cerberus-forge-deploy-backend.onrender.com").replace(/\/$/, "");
const frontend = (process.env.FRONTEND_URL || "https://cerberus-design-static.onrender.com").replace(/\/$/, "");
const catalog = process.env.PUBLIC_CATALOG_API_URL || "https://juiychcfdqxgnatffnla.supabase.co/functions/v1/cerberus-public-api/products";
const token = process.env.OIDC_TOKEN || "";
const expectedSha = String(process.env.EXPECTED_SHA || "").trim();
const timeoutMs = Math.max(75_000, Number(process.env.SMOKE_TIMEOUT_MS || 75_000));

async function get(url, headers = {}) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { headers: { "User-Agent": "cerberus-production-smoke/1.0", ...headers }, signal: controller.signal, cache: "no-store" });
      const text = await response.text();
      let body = text;
      try { body = JSON.parse(text); } catch {}
      if (response.ok) return { status: response.status, body, attempt };
      last = new Error(`${url} HTTP ${response.status}`);
    } catch (error) {
      last = error;
    } finally { clearTimeout(timer); }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw last;
}

function assert(condition, message) { if (!condition) throw new Error(message); }

const checks = {};
const frontendResult = await get(frontend);
checks.frontend = frontendResult.status === 200;
const healthResult = await get(`${backend}/health`);
checks.backend = healthResult.status === 200;
const liveSha = typeof healthResult.body?.version === "string" ? healthResult.body.version.trim() : "";
checks.liveSha = liveSha || null;
if (expectedSha) assert(liveSha === expectedSha, `LIVE_SHA_MISMATCH expected=${expectedSha} actual=${liveSha || "missing"}`);

const catalogResult = await get(catalog);
const catalogRows = Array.isArray(catalogResult.body) ? catalogResult.body : (Array.isArray(catalogResult.body?.products) ? catalogResult.body.products : []);
checks.catalog = catalogResult.status === 200 && catalogRows.length >= 0;
assert(checks.catalog, "PUBLIC_CATALOG_UNREADABLE");

assert(token, "OIDC_TOKEN_MISSING");
const auth = { Authorization: `Bearer ${token}` };
const invariant = await get(`${backend}/api/internal/autonomous-curator/invariant`, auth);
checks.invariant = invariant.status === 200 && typeof invariant.body?.ok === "boolean";
assert(checks.invariant, "INVARIANT_UNREADABLE");
const status = await get(`${backend}/api/internal/autonomous-curator/status`, auth);
checks.curatorStatus = status.status === 200 && status.body?.ok === true;
assert(checks.curatorStatus, "CURATOR_STATUS_UNREADABLE");

console.log(JSON.stringify({
  ok: true,
  readOnly: true,
  frontendUrl: frontend,
  backend,
  catalog,
  checks,
  catalogCount: catalogRows.length,
  invariant: { ok: invariant.body.ok, target: invariant.body.target, totalDeficit: invariant.body.totalDeficit, policyVersion: invariant.body.policyVersion },
  curator: { running: status.body.running === true, latestRunStatus: status.body.latestRun?.status || null },
  expectedSha: expectedSha || null,
  liveSha: liveSha || null,
}, null, 2));
