import { strict as assert } from "node:assert";
import { executePublicationN16 } from "../server/commercial/publication/n16Service";
import { FakePublicationProvider, type PublicationProvider } from "../server/commercial/publication/n16Provider";

const candidateId = "can-0123456789abcdef01234567";
const now = "2026-08-19T12:00:00.000Z";
const n13Digest = "sha256:n13-proof";
const n14Digest = "sha256:n14-proof";
const n15Digest = "sha256:n15-proof";
const makePayload = (extra: Record<string, unknown> = {}) => ({ candidate_id: candidateId, title: "Produto artificial N16", source_url: "https://example.com/artificial", category: "Casa", price: 19.9, currency: "BRL", ...extra });
const makeRows = (n15: Record<string, unknown> = {}) => [
  { assessment_id: "gov", filter_version: "n15:governance_v1", dimensions: { status: "APPROVED", action: "PUBLISH", expires_at: "2026-08-26T12:00:00.000Z", ...n15 }, metadata: { authorization_digest: n15Digest, evaluated_at: now }, input_snapshot: { governance: { source_assessments: [{ block: "n13", assessment_id: "n13", digest: n13Digest, verdict: "PASS" }, { block: "n14", assessment_id: "n14", digest: n14Digest, band: "HIGH", score: 0.9 }] } }, created_at: now },
  { assessment_id: "n14", filter_version: "n14:commercial_brain_v1", dimensions: { band: "HIGH", score: 0.9 }, metadata: { digest: n14Digest }, idempotency_key: n14Digest, created_at: now },
  { assessment_id: "n13", filter_version: "n13:curator_v1", dimensions: { verdict: "PASS" }, metadata: { digest: n13Digest }, idempotency_key: n13Digest, created_at: now },
];
function deps(provider: PublicationProvider, rows = makeRows()) {
  const records = new Map<string, any>();
  return {
    provider,
    getCandidate: async () => ({ ok: true, candidate: { status: "APPROVED" } }),
    listAssessments: async () => ({ ok: true, assessments: rows }),
    getExecution: async ({ executionKey }: { executionKey?: string }) => ({ ok: true, record: [...records.values()].find((r) => r.execution_key === executionKey) ?? null }),
    insertExecution: async (input: any) => { const old = [...records.values()].find((r) => r.execution_key === input.execution_key); if (old) return { ok: true, outcome: "identical_duplicate", record: old }; const row = { ...input, reason_codes: input.reason_codes ?? [], provider_reference: null, result: {}, error_code: null, error_message: null, status: input.status }; records.set(input.execution_id, row); return { ok: true, outcome: "inserted", record: row }; },
    updateExecutionStatus: async (id: string, status: string, patch: any = {}) => { const row = records.get(id); Object.assign(row, patch, { status }); return { ok: true, outcome: "inserted", record: row }; },
    now: () => now,
  } as any;
}
async function run(): Promise<void> {
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>) => { await fn(); passed += 1; console.log(`PASS ${name}`); };
  const input: any = { candidate_id: candidateId, destination: "storefront", payload: makePayload() };

  await check("1 N15 BLOCKED -> N16 BLOCKED -> provider não chamado", async () => { const p = new FakePublicationProvider(); const r = await executePublicationN16(input, deps(p, makeRows({ status: "BLOCKED" }))); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
  await check("2 N15 APPROVED -> provider -> PUBLISHED", async () => { const p = new FakePublicationProvider("success"); const r = await executePublicationN16(input, deps(p)); assert.equal(r.status, "PUBLISHED"); assert.equal(p.publishCalls, 1); });
  await check("3 replay PUBLISHED sem segunda publicação", async () => { const p = new FakePublicationProvider("success"); const d = deps(p); await executePublicationN16(input, d); await executePublicationN16(input, d); assert.equal(p.publishCalls, 1); });
  await check("4 autorização expirada bloqueia", async () => { const p = new FakePublicationProvider(); const r = await executePublicationN16(input, deps(p, makeRows({ expires_at: "2026-08-18T12:00:00.000Z" }))); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
  await check("5 ação diferente bloqueia", async () => { const p = new FakePublicationProvider(); const r = await executePublicationN16({ ...input, action: "ACQUIRE_AFFILIATE" }, deps(p)); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
  await check("6 digest N13 divergente bloqueia", async () => { const p = new FakePublicationProvider(); const rows = makeRows(); (rows[0] as any).input_snapshot.governance.source_assessments[0].digest = "sha256:other"; const r = await executePublicationN16(input, deps(p, rows)); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
  await check("7 payload inválido bloqueia", async () => { const p = new FakePublicationProvider(); const r = await executePublicationN16({ ...input, payload: makePayload({ price: Number.NaN }) }, deps(p)); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
  await check("8 destino inválido bloqueia", async () => { const p = new FakePublicationProvider(); const r = await executePublicationN16({ ...input, destination: "bad destination" }, deps(p)); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
  await check("9 provider failure -> FAILED", async () => { const r = await executePublicationN16(input, deps(new FakePublicationProvider("failure"))); assert.equal(r.status, "FAILED"); });
  await check("10 provider ambiguous -> AMBIGUOUS", async () => { const r = await executePublicationN16(input, deps(new FakePublicationProvider("ambiguous"))); assert.equal(r.status, "AMBIGUOUS"); });
  await check("11 AMBIGUOUS não sofre retry automático", async () => { const p = new FakePublicationProvider("ambiguous"); const d = deps(p); await executePublicationN16(input, d); await executePublicationN16(input, d); assert.equal(p.publishCalls, 1); });
  await check("12 provider só é alcançado após validação N15", async () => { let called = false; const p: PublicationProvider = { validatePayload: async () => { called = true; return { ok: true }; }, publish: async () => ({ ok: true, status: "PUBLISHED" }), getStatus: async () => ({ status: "PUBLISHED" }) }; const r = await executePublicationN16(input, deps(p)); assert.equal(r.status, "PUBLISHED"); assert.equal(called, true); });
  console.log(`N16 PROOF PASS — ${passed}/12 cenários`);
}
run().catch((error) => { console.error("N16 PROOF FAIL", error instanceof Error ? error.message : error); process.exitCode = 1; });
