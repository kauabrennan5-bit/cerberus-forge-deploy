import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { evaluatePublicationAuthorization } from "../server/commercial/publication/n16Engine";
import { executePublicationN16 } from "../server/commercial/publication/n16Service";
import { FakePublicationProvider, type PublicationProvider } from "../server/commercial/publication/n16Provider";
import { PublicationAction, PublicationStatus, publicationExecutionKey, publicationPayloadDigest, stableJson, type PublicationExecutionInput } from "../server/commercial/publication/n16Contract";
import type { PublicationExecutionRecord, PublicationExecutionInsert } from "../server/repositories/publicationExecutionsRepository";

const now = "2026-08-19T12:00:00.000Z";
const n13Digest = "sha256:n13-proof";
const n14Digest = "sha256:n14-proof";
const n15Digest = "sha256:n15-proof";
const candidateId = "can-0123456789abcdef01234567";

function payload(overrides: Record<string, unknown> = {}): any {
  return { candidate_id: candidateId, title: "Produto de prova", source_url: "https://example.com/item/1", category: "Casa", price: 29.9, currency: "BRL", ...overrides };
}
function auth(overrides: Record<string, unknown> = {}): any {
  return { assessment_id: "gov-proof", candidate_id: candidateId, status: "APPROVED", action: "PUBLISH", authorization_digest: n15Digest, evaluated_at: now, expires_at: "2026-08-26T12:00:00.000Z", n13: { assessment_id: "n13-proof", digest: n13Digest, verdict: "PASS" }, n14: { assessment_id: "n14-proof", digest: n14Digest, band: "HIGH", score: 0.9 }, ...overrides };
}
function engineInput(overrides: Record<string, unknown> = {}): any {
  return { candidate_id: candidateId, candidate_status: "APPROVED", destination: "storefront", payload: payload(), action: PublicationAction, n13: auth().n13, n14: auth().n14, n15: auth(), now_iso: now, ...overrides };
}
function assessmentRows(overrides: { n15?: Record<string, unknown>; n13?: Record<string, unknown>; n14?: Record<string, unknown> } = {}): Record<string, unknown>[] {
  const n13 = overrides.n13 ?? { assessment_id: "n13-proof", filter_version: "n13:curator_v1", dimensions: { verdict: "PASS" }, metadata: { digest: n13Digest, verdict: "PASS" }, idempotency_key: n13Digest, created_at: now };
  const n14 = overrides.n14 ?? { assessment_id: "n14-proof", filter_version: "n14:commercial_brain_v1", dimensions: { band: "HIGH", score: 0.9 }, metadata: { digest: n14Digest, band: "HIGH", score: 0.9 }, idempotency_key: n14Digest, created_at: now };
  const n15 = overrides.n15 ?? { assessment_id: "gov-proof", filter_version: "n15:governance_v1", dimensions: { status: "APPROVED", action: "PUBLISH", decision_digest: n15Digest, expires_at: "2026-08-26T12:00:00.000Z" }, metadata: { authorization_digest: n15Digest, evaluated_at: now }, input_snapshot: { governance: { decision_digest: n15Digest, source_assessments: [{ block: "n13", assessment_id: "n13-proof", digest: n13Digest, verdict: "PASS" }, { block: "n14", assessment_id: "n14-proof", digest: n14Digest, band: "HIGH", score: 0.9 }] } }, created_at: now };
  return [n15, n14, n13];
}

function memoryDeps(provider: PublicationProvider, rows = assessmentRows(), candidate: any = { status: "APPROVED" }) {
  const records = new Map<string, PublicationExecutionRecord>();
  const deps: any = {
    provider,
    getCandidate: async () => ({ ok: true, candidate }),
    listAssessments: async () => ({ ok: true, assessments: rows }),
    getExecution: async ({ executionKey }: { executionKey?: string }) => ({ ok: true, record: executionKey ? [...records.values()].find((r) => r.execution_key === executionKey) ?? null : null }),
    insertExecution: async (input: PublicationExecutionInsert) => {
      const duplicate = input.execution_key ? [...records.values()].find((r) => r.execution_key === input.execution_key) : undefined;
      if (duplicate) return { ok: true, outcome: "identical_duplicate", record: duplicate };
      const record: any = { ...input, execution_key: input.execution_key ?? null, n15_authorization_digest: input.n15_authorization_digest ?? null, publication_payload_digest: input.publication_payload_digest ?? null, reason_codes: input.reason_codes ?? [], provider_reference: null, result: {}, error_code: null, error_message: null, started_at: null, finished_at: null, metadata: input.metadata ?? {}, status: input.status };
      records.set(record.execution_id, record);
      return { ok: true, outcome: "inserted", record };
    },
    updateExecutionStatus: async (id: string, status: string, patch: any = {}) => {
      const record: any = records.get(id);
      if (!record) return { ok: false, outcome: "database_error", error: "not_found" };
      Object.assign(record, patch, { status });
      return { ok: true, outcome: "inserted", record };
    },
    now: () => now,
    records,
  };
  return deps;
}

// A — autorização válida
 test("A — N15 APPROVED/PUBLISH válido libera N16", () => { const r = evaluatePublicationAuthorization(engineInput()); assert.equal(r.allowed, true); assert.equal(r.status, PublicationStatus.AUTHORIZED); assert.deepEqual(r.reasons, []); });
// B — N15 ausente
 test("B — N15 ausente bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n15: null })); assert.equal(r.status, PublicationStatus.BLOCKED); assert.ok(r.reasons.includes("n15_authorization_missing")); });
// C — status não aprovado
 test("C — N15 REVIEW bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n15: auth({ status: "REVIEW" }) })); assert.ok(r.reasons.includes("n15_authorization_not_approved")); });
// D — ação divergente
 test("D — N15 ACQUIRE não autoriza PUBLISH", () => { const r = evaluatePublicationAuthorization(engineInput({ n15: auth({ action: "ACQUIRE_AFFILIATE" }) })); assert.ok(r.reasons.includes("n15_action_mismatch")); });
// E — candidato divergente
 test("E — candidate_id divergente bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n15: auth({ candidate_id: "can-fedcba9876543210fedcba98" }) })); assert.ok(r.reasons.includes("n15_authorization_invalid")); });
// F — TTL expirado
 test("F — autorização expirada bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n15: auth({ expires_at: "2026-08-18T12:00:00.000Z" }) })); assert.ok(r.reasons.includes("n15_authorization_expired")); });
// G — timestamps inválidos
 test("G — timestamps inválidos bloqueiam", () => { const r = evaluatePublicationAuthorization(engineInput({ n15: auth({ expires_at: "invalid" }) })); assert.ok(r.reasons.includes("n15_authorization_invalid")); });
// H — N13 ausente
 test("H — N13 ausente bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n13: null })); assert.ok(r.reasons.includes("n15_digest_mismatch")); });
// I — N13 não PASS
 test("I — N13 BLOCKED bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n13: { ...auth().n13, verdict: "BLOCKED" } })); assert.ok(r.reasons.includes("n15_digest_mismatch")); });
// J — N14 ausente
 test("J — N14 ausente bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n14: null })); assert.ok(r.reasons.includes("n15_digest_mismatch")); });
// K — score não finito
 test("K — N14 score não finito bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n14: { ...auth().n14, score: Number.NaN } })); assert.ok(r.reasons.includes("n15_digest_mismatch")); });
// L — digest N13 divergente
 test("L — digest N13 divergente bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n13: { ...auth().n13, digest: "sha256:other" } })); assert.ok(r.reasons.includes("n15_digest_mismatch")); });
// M — digest N14 divergente
 test("M — digest N14 divergente bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ n14: { ...auth().n14, digest: "sha256:other" } })); assert.ok(r.reasons.includes("n15_digest_mismatch")); });
// N — título inválido
 test("N — payload sem título bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ payload: payload({ title: "" }) })); assert.ok(r.reasons.includes("publication_payload_invalid")); });
// O — preço inválido
 test("O — preço não finito bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ payload: payload({ price: Number.NaN }) })); assert.ok(r.reasons.includes("publication_payload_invalid")); });
// P — categoria inválida
 test("P — categoria vazia bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ payload: payload({ category: "" }) })); assert.ok(r.reasons.includes("publication_payload_invalid")); });
// Q — source URL inválida
 test("Q — source_url HTTP bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ payload: payload({ source_url: "http://example.com" }) })); assert.ok(r.reasons.includes("publication_payload_invalid")); });
// R — destino inválido
 test("R — destino com espaço bloqueia", () => { const r = evaluatePublicationAuthorization(engineInput({ destination: "bad destination" })); assert.ok(r.reasons.includes("publication_destination_invalid")); });
// S — candidato já publicado
 test("S — candidato PUBLISHED não é republicado", () => { const r = evaluatePublicationAuthorization(engineInput({ candidate_status: "PUBLISHED" })); assert.ok(r.reasons.includes("publication_already_published")); });
// T — chave determinística
 test("T — execution key segue concatenação SHA256 sem separadores", () => { const r = evaluatePublicationAuthorization(engineInput()); const expected = createHash("sha256").update(candidateId + n15Digest + (r.payloadDigest as string) + "storefront" + "PUBLISH").digest("hex"); assert.equal(r.executionKey, expected); });
// U — replay do engine
 test("U — replay idêntico produz mesma chave e digest", () => { const a = evaluatePublicationAuthorization(engineInput()); const b = evaluatePublicationAuthorization(engineInput()); assert.equal(a.executionKey, b.executionKey); assert.equal(a.payloadDigest, b.payloadDigest); });
// V — destino participa da chave
 test("V — destino diferente muda a chave", () => { const a = evaluatePublicationAuthorization(engineInput()); const b = evaluatePublicationAuthorization(engineInput({ destination: "partner" })); assert.notEqual(a.executionKey, b.executionKey); });
// W — payload participa do digest
 test("W — payload diferente muda digest", () => { assert.notEqual(publicationPayloadDigest(payload()), publicationPayloadDigest(payload({ price: 30 }))); });
// X — JSON estável
 test("X — stableJson ordena chaves", () => { assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 })); });
// Y — fórmula exportada
 test("Y — helper de execution key é reproduzível", () => { assert.equal(publicationExecutionKey({ candidateId, authorizationDigest: n15Digest, payloadDigest: "sha256:p", destination: "storefront", action: "PUBLISH" }), createHash("sha256").update(candidateId + n15Digest + "sha256:p" + "storefrontPUBLISH").digest("hex")); });
// Z — N15 bloqueado não chama provider
 test("Z — N15 BLOCKED não chama FakeProvider", async () => { const p = new FakePublicationProvider("success"); const d = memoryDeps(p, assessmentRows({ n15: { ...assessmentRows()[0], dimensions: { status: "BLOCKED", action: "PUBLISH", decision_digest: n15Digest } } })); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, d); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
// AA — approved publica
 test("AA — N15 APPROVED chama provider e confirma PUBLISHED", async () => { const p = new FakePublicationProvider("success"); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "PUBLISHED"); assert.equal(r.ok, true); assert.equal(p.publishCalls, 1); assert.equal(p.statusCalls, 1); });
// AB — validate payload
 test("AB — provider valida antes de publicar", async () => { const p = new FakePublicationProvider("success"); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "PUBLISHED"); assert.equal(p.validateCalls, 1); });
// AC — provider failure
 test("AC — provider FAILED termina FAILED", async () => { const p = new FakePublicationProvider("failure"); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "FAILED"); assert.equal(r.ok, false); });
// AD — provider ambiguous
 test("AD — provider AMBIGUOUS termina AMBIGUOUS", async () => { const p = new FakePublicationProvider("ambiguous"); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "AMBIGUOUS"); assert.equal(r.ok, false); });
// AE — ambiguous replay
 test("AE — AMBIGUOUS não faz retry automático", async () => { const p = new FakePublicationProvider("ambiguous"); const d = memoryDeps(p); const input = { candidate_id: candidateId, destination: "storefront", payload: payload() }; await executePublicationN16(input, d); const calls = p.publishCalls; const second = await executePublicationN16(input, d); assert.equal(second.status, "AMBIGUOUS"); assert.equal(p.publishCalls, calls); });
// AF — published replay
 test("AF — PUBLISHED replay é idempotente e não duplica", async () => { const p = new FakePublicationProvider("success"); const d = memoryDeps(p); const input = { candidate_id: candidateId, destination: "storefront", payload: payload() }; await executePublicationN16(input, d); const second = await executePublicationN16(input, d); assert.equal(second.status, "PUBLISHED"); assert.equal(p.publishCalls, 1); });
// AG — provider validation failure
 test("AG — rejeição de payload do provider falha fechado", async () => { const p: PublicationProvider = { validatePayload: async () => ({ ok: false, reason: "provider_rejected" }), publish: async () => ({ ok: true, status: "PUBLISHED" }), getStatus: async () => ({ status: "PUBLISHED" }) }; const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "FAILED"); });
// AH — provider throw
 test("AH — exceção no publish nunca vira PUBLISHED", async () => { const p: PublicationProvider = { validatePayload: async () => ({ ok: true }), publish: async () => { throw new Error("transport"); }, getStatus: async () => ({ status: "PUBLISHED" }) }; const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "FAILED"); });
// AI — confirmation throw
 test("AI — exceção na confirmação vira AMBIGUOUS", async () => { const p: PublicationProvider = { validatePayload: async () => ({ ok: true }), publish: async () => ({ ok: true, status: "PUBLISHED", provider_reference: "r" }), getStatus: async () => { throw new Error("timeout"); } }; const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "AMBIGUOUS"); });
// AJ — confirmation failure
 test("AJ — confirmação FAILED termina FAILED", async () => { const p: PublicationProvider = { validatePayload: async () => ({ ok: true }), publish: async () => ({ ok: true, status: "PUBLISHED", provider_reference: "r" }), getStatus: async () => ({ status: "FAILED" }) }; const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, memoryDeps(p)); assert.equal(r.status, "FAILED"); });
// AK — candidate not found
 test("AK — candidato ausente bloqueia e não publica", async () => { const p = new FakePublicationProvider(); const d = memoryDeps(p); d.getCandidate = async () => ({ ok: false }); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, d); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
// AL — assessment failure
 test("AL — erro ao carregar assessments falha fechado", async () => { const p = new FakePublicationProvider(); const d = memoryDeps(p); d.listAssessments = async () => ({ ok: false, assessments: [], error: "db" }); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload() }, d); assert.equal(r.status, "FAILED"); assert.equal(p.publishCalls, 0); });
// AM — action input mismatch
 test("AM — input ACQUIRE não publica", async () => { const p = new FakePublicationProvider(); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", action: "ACQUIRE_AFFILIATE" as any, payload: payload() }, memoryDeps(p)); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
// AN — payload candidate mismatch
 test("AN — payload de outro candidato bloqueia", async () => { const p = new FakePublicationProvider(); const r = await executePublicationN16({ candidate_id: candidateId, destination: "storefront", payload: payload({ candidate_id: "can-fedcba9876543210fedcba98" }) }, memoryDeps(p)); assert.equal(r.status, "BLOCKED"); assert.equal(p.publishCalls, 0); });
// AO — isolamento e ausência de catálogo downstream
 test("AO — fontes N16 não importam blocos downstream ou side effects proibidos", async () => { const files = ["server/commercial/publication/n16Contract.ts", "server/commercial/publication/n16Engine.ts", "server/commercial/publication/n16Provider.ts", "server/commercial/publication/n16Service.ts", "server/routes/publicationN16Routes.ts"]; for (const file of files) { const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8"); assert.doesNotMatch(source, /N17|N18|N19|N20|Telegram|telegramBot|scheduler|job_queue|agentExecutions|productsRepository/); } });
