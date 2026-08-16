/**
 * Bloco 17 — Testes do Cockpit Comercial (render-only).
 *
 * Regras cobertas:
 *   - COCKPIT = INFORMAÇÃO, NÃO AUTORIDADE: nenhuma função do cockpit
 *     executa variante, produto, Telegram, agente ou executor.
 *   - /experiments e /decisions leem apenas o registry formal.
 *   - /agents exibe o estado REAL do registry (EXECUTOR_NOT_CONNECTED).
 *   - /recommendations marca toda saída como SUGESTÃO.
 *   - Ausência de dados NUNCA vira fato negativo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setExperimentClientForTests } from "../server/repositories/experimentRepository";
import * as commercialCockpit from "../server/services/commercialCockpit";

// Cliente Supabase falso: responde a qualquer select com rows controladas.
function promiseClient(rows: unknown[]): any {
  const result = { data: rows, count: rows.length };
  // thenable: o resultado final da cadeia (not/order/limit) precisa ser
  // aguardável como Promise, porque o repository faz `await client.from(...)...`.
  const thenable = Promise.resolve(result) as unknown;
  const branch = () => Object.assign(thenable, {
    eq: branch,
    gte: branch,
    lte: branch,
    not: branch,
    order: branch,
    limit: branch,
  });
  return {
    from: () => ({
      select: () => branch(),
    }),
  };
}

test("B17 cockpit: renderOpportunities SEM cliques → LOW com base exibida (ausência ≠ fato negativo)", async () => {
  setExperimentClientForTests(null);
  const text = await commercialCockpit.renderOpportunities("7d");
  assert.match(text, /AUSÊNCIA DE DADOS/);
  assert.match(text, /LOW/);
  assert.doesNotMatch(text, /Confiança: alta/i);
});

test("B17 cockpit: renderDecisions SEM registry → sem opinião como decisão", async () => {
  setExperimentClientForTests(null);
  const text = await commercialCockpit.renderDecisions();
  assert.match(text, /DECISÕES/);
  assert.match(text, /indisponível|Nenhuma decisão formal/);
  assert.doesNotMatch(text, /SCALE|MAINTAIN|KILL/);
});

test("B17 cockpit: renderExperiments SEM registry → fail-closed sem execução", async () => {
  setExperimentClientForTests(null);
  const text = await commercialCockpit.renderExperiments();
  assert.match(text, /indisponível|Nenhum experimento/);
  assert.doesNotMatch(text, /DECISÃO/); // nada é executado sem registry
});

test("B17 cockpit: renderAgents exibe EXECUTOR_NOT_CONNECTED (estado real, sem inferência)", async () => {
  const text = await commercialCockpit.renderAgents();
  assert.match(text, /EXECUTOR_NOT_CONNECTED/);
  assert.match(text, /AGENT != EXECUTION/);
});

test("B17 cockpit: renderRecommendations SEM artefatos → ausência ≠ negativo", async () => {
  setExperimentClientForTests(null);
  const text = await commercialCockpit.renderRecommendations();
  assert.match(text, /SUGESTÃO/);
  assert.match(text, /nenhuma recomendação|indisponível/i);
  assert.match(text, /ausência de registro ≠ ausência de oportunidade/i);
});

test("B17 cockpit: renderPriority SEM registry → regras de indisponibilidade (sem inferência)", async () => {
  setExperimentClientForTests(null);
  const text = await commercialCockpit.renderPriority();
  assert.match(text, /COCKPIT COMERCIAL/);
  assert.match(text, /COCKPIT = INFORMAÇÃO|não executa ação/);
});

test("B17 cockpit: /risks SEM incidentes e SEM artefatos → ausência ≠ fato negativo", async () => {
  setExperimentClientForTests(null);
  const text = await commercialCockpit.renderRisks();
  assert.match(text, /RISCOS E INCONSISTÊNCIAS/);
  assert.match(text, /ausência de registro ≠ ausência de problema|Ausência de dado capturado/);
});

test("B17 cockpit: experiment com decisão formal registrada → exibida com base documentada", async () => {
  const client = promiseClient([
    {
      experiment_id: "EXP-TEST-COCKPIT",
      experiment_key: "key-test-cockpit",
      schema_version: "1.0",
      hypothesis: "Teste de cockpit",
      variant_a_label: "A",
      variant_b_label: "B",
      target_population: "produtos de teste",
      success_metric: "cli",
      metric_definition: "base de cliques",
      min_sample_size: 100,
      sample_size: 10,
      status: "RUNNING",
      start_date: new Date().toISOString(),
      planned_end_date: new Date(Date.now() + 86400000 * 7).toISOString(),
      decision: "INCONCLUSIVE",
      decision_basis: "registro formal de teste — base documentada",
      decided_by: "operator-admin",
      statistical_rigor_version: "statistical_rigor_v1",
    },
  ]);
  setExperimentClientForTests(client);
  const text = await commercialCockpit.renderDecisions();
  assert.match(text, /INCONCLUSIVE/);
  assert.match(text, /EXP-TEST-COCKPIT/);
  const expText = await commercialCockpit.renderExperiments();
  assert.match(expText, /EXP-TEST-COCKPIT/);
  assert.match(expText, /10\b.*100|amostra.*mínimo/i);
});

test("B17 cockpit: decisão prematura permanece bloqueada mesmo com registro parcial", async () => {
  // Mesma simulação acima: amostra 10 < mínimo 100 e período NÃO encerrado.
  // O cockpit deve declarar explicitamente que decisão NÃO é permitida.
  const client = promiseClient([
    {
      experiment_id: "EXP-PREMATURO",
      experiment_key: "key-prematuro",
      schema_version: "1.0",
      hypothesis: "Teste de gate prematuro",
      variant_a_label: "A",
      variant_b_label: "B",
      target_population: "produtos de teste",
      success_metric: "cli",
      metric_definition: "base de cliques",
      min_sample_size: 100,
      sample_size: 10,
      status: "RUNNING",
      start_date: new Date().toISOString(),
      planned_end_date: new Date(Date.now() + 86400000 * 7).toISOString(),
      decision: null,
      decision_basis: null,
      decided_by: null,
      statistical_rigor_version: "statistical_rigor_v1",
    },
  ]);
  setExperimentClientForTests(client);
  const text = await commercialCockpit.renderExperiments();
  assert.match(text, /NÃO PERMITIDA/);
  assert.doesNotMatch(text, /AINDA NÃO PERMITIDA[\s\S]*JÁ É PERMITIDA/);
});
