// Prova viva — Bloco N1 (Contratos de Descoberta) contra o banco de PRODUÇÃO,
// via candidatesRepository diretamente (SUPABASE_SERVICE_ROLE_KEY).
// NÃO altera Telegram, Operator, watchdog, lifecycle, job_queue, products ou catálogo.
// Ao final remove integralmente os registros de teste e confirma zero resíduos.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  registerCandidate,
  startReview,
  recordVerdict,
  promoteToProduct,
  getCandidate,
  listCandidates,
  deleteCandidateForProof,
  getCandidatesClient,
} from "../server/repositories/candidatesRepository";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function requireEnv(): { url: string; key: string } {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("FALTAM SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  return { url: SUPABASE_URL, key: SUPABASE_SERVICE_ROLE_KEY };
}

const { url, key } = requireEnv();
const serviceClient: SupabaseClient = createClient(url, key);

// Injeta o cliente service-role direto no repository (fail-closed: não há fallback)
import { setCandidatesClient } from "../server/repositories/candidatesRepository";
setCandidatesClient(serviceClient);

const TEST_PREFIX = "n1-prova-viva";
const nowIso = () => new Date().toISOString();

let exitCode = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  [check] ${label} → ${cond ? "OK" : "FALHOU"}`);
  if (!cond) exitCode = 1;
};

async function main() {
  console.log("== N1 PROVA VIVA — BANCO DE PRODUÇÃO ==");

  const listing = {
    marketplace: "Shopee",
    external_listing_id: "1530442944-23794344926-teste-n1",
    source_url: "https://shopee.com.br/loja-teste-n1/prova-viva-n1-00001",
    merchant: "Loja Teste N1",
    title: "Produto de Prova Viva Bloco N1 (registro artificial)",
    description: "Registro artificial de teste do registry de descoberta.",
    category: "Casa",
    observed_price: 29.9,
    observed_rating: 4.5,
    observed_rating_count: 10,
    observed_availability: "IN_STOCK",
    evidence_hash: "sha256:provavivan1",
    collection_method: "MANUAL",
    raw_snapshot_url: null,
    observed_at: nowIso(),
    metadata: { purpose: "n1-prova-viva", artifact: "registry" },
  };

  // 1. Criação
  const r1 = await registerCandidate(listing as any);
  console.log("[1] registerCandidate →", r1.outcome, r1.candidate_id ?? r1.existing_id ?? "");
  check("outcome é created", r1.ok && r1.outcome === "created");
  const candidateId = r1.candidate_id ?? r1.existing_id ?? "";
  check("candidate_id começa com can-", candidateId.startsWith("can-"));

  // 2. Idempotência — replay idêntico retorna o mesmo registro
  const r2 = await registerCandidate(listing as any);
  console.log("[2] idempotência (replay idêntico) →", r2.outcome, r2.existing_id ?? r2.candidate_id ?? "");
  check("replay idêntico → identical_duplicate", r2.ok && r2.outcome === "identical_duplicate");
  check("existing_id igual ao original", r2.existing_id === candidateId);

  // 3. Colisão — mesmo listing_key com payload divergente
  const r3 = await registerCandidate({
    ...listing,
    title: "OUTRA URL, MESMO LISTING_KEY (colisão)",
  } as any);
  console.log("[3] colisão →", r3.outcome, r3.reason ?? "");
  check("colisão → conflict_rejected", r3.ok === false || r3.outcome === "conflict_rejected");

  // 4. Funil: DISCOVERED/INTAKE → REVIEWING
  const cBefore = await getCandidate(candidateId);
  console.log("[4] estado inicial → status:", cBefore.candidate?.status, "stage:", cBefore.candidate?.funnel_stage);
  check("status inicial DISCOVERED", cBefore.candidate?.status === "DISCOVERED");
  check("funnel_stage inicial INTAKE", cBefore.candidate?.funnel_stage === "INTAKE");

  const start = await startReview(candidateId);
  console.log("[5] startReview →", start.ok, start.candidate?.status, start.candidate?.funnel_stage);
  check("startReview OK e EVIDENCE_OK", start.ok && start.candidate?.funnel_stage === "EVIDENCE_OK");

  // 5. Veredito negativo SEM motivo obrigatório (deve recusar REJECTED sem reason)
  const vBad = await recordVerdict({ candidate_id: candidateId, status: "REJECTED" });
  console.log("[6] REJECTED sem motivo →", vBad.outcome, vBad.reason ?? "");
  check("REJECTED sem reason recusado", vBad.ok === false || vBad.outcome === "rejected");

  // 6. Segundo candidato para o teste de recusa com motivo
  const c2input = { ...listing, title: "Segundo candidato de teste (a ser rejeitado)" };
  const r4 = await registerCandidate(c2input as any);
  const candidateId2 = r4.candidate_id ?? r4.existing_id ?? "";
  console.log("[7] segundo candidato →", r4.outcome, candidateId2);
  check("segundo candidato criado", r4.ok);
  await startReview(candidateId2);

  // 7. Veredito REJECTED COM motivo
  const vOk = await recordVerdict({
    candidate_id: candidateId2,
    status: "REJECTED",
    rejection_reason: "preço inconsistente com evidência (teste de prova viva)",
    reviewed_by: "operator-admin",
    review_notes: "prova viva N1",
  });
  console.log("[8] REJECTED com motivo →", vOk.outcome);
  check("REJECTED com reason aceito", vOk.ok && vOk.outcome === "verdict_recorded");
  const cRej = await getCandidate(candidateId2);
  check("rejection_reason persistido", !!cRej.candidate?.rejection_reason);
  check("reviewed_by persistido", cRej.candidate?.reviewed_by === "operator-admin");
  check("status final REJECTED", cRej.candidate?.status === "REJECTED");
  check("funnel_stage final é FUNNEL_END", cRej.candidate?.funnel_stage === "FUNNEL_END");

  // 8. Fluxo aprovado no primeiro candidato: REVIEWING→APPROVED
  const vApp = await recordVerdict({
    candidate_id: candidateId,
    status: "APPROVED",
    review_notes: "prova viva N1 — aprovação para registro do vínculo",
    reviewed_by: "operator-admin",
  });
  console.log("[9] APPROVED →", vApp.outcome);
  check("APPROVED aceito", vApp.ok && vApp.outcome === "verdict_recorded");
  const cApp = await getCandidate(candidateId);
  check("status APPROVED", cApp.candidate?.status === "APPROVED");
  check("funnel_stage REVIEWED", cApp.candidate?.funnel_stage === "REVIEWED");

  // 9. promoteToProduct: só registra o vínculo (sem FK real, sem criar produto canônico)
  const promo = await promoteToProduct({ candidate_id: candidateId, promoted_product_id: "PROD-TESTE-N1-PROVA-VIVA" });
  console.log("[10] promoteToProduct →", promo.ok);
  const cPromo = await getCandidate(candidateId);
  check("promoted_product_id registrado", cPromo.candidate?.promoted_product_id === "PROD-TESTE-N1-PROVA-VIVA");
  check("promoted_at registrado", !!cPromo.candidate?.promoted_at);

  // 10. Listagem
  const list = await listCandidates({ status: "APPROVED", limit: 50 });
  console.log("[11] listCandidates(APPROVED) total:", list.total);
  check("listagem encontra o aprovado", list.candidates.some((c) => c.candidate_id === candidateId));

  // 11. Evidência bruta persistida
  const { data: raw } = await serviceClient
    .from("candidates")
    .select("evidence_hash, raw_snapshot_url, metadata, observed_price")
    .eq("candidate_id", candidateId)
    .limit(1)
    .single();
  console.log("[12] evidence_hash:", raw.evidence_hash, "| price:", raw.observed_price);
  check("evidência bruta persistida", raw.evidence_hash === "sha256:provavivan1" && raw.observed_price === 29.9);

  // 12. Cleanup integral + zero resíduos
  const d1 = await deleteCandidateForProof(candidateId);
  const d2 = await deleteCandidateForProof(candidateId2);
  console.log("[13] deleteCandidateForProof →", d1.deleted, d2.deleted);
  const { count } = await serviceClient
    .from("candidates")
    .select("*", { count: "exact", head: true });
  console.log("[14] linhas remanescentes em candidates:", count);
  check("deleteCandidateForProof ok", d1.ok && d2.ok && d1.deleted && d2.deleted);
  check("ZERO RESÍDUOS em production", count === 0);

  console.log("== N1 PROVA VIVA:", exitCode === 0 ? "CONCLUÍDA COM SUCESSO" : "FALHOU — VER CHECKS ACIMA", "==");
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("FALHA NA PROVA VIVA:", e);
  process.exit(1);
});
