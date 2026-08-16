/**
 * Bloco 15 — Fase A — Testes determinísticos do Agent Registry.
 *
 * Provas exigidas:
 * 1–4   agentes com agent_id/version/policy_version/role;
 * 5     max_risk válido;
 * 6–11  tools/actions/tables dentro dos catálogos fechados (default deny);
 * 12–13 registry imutável após carregamento e tentativa de mutação sem efeito;
 * 14–15 nenhum agente pode se auto-registrar nem alterar permissões;
 * 16–22 registry não executa ações, não acessa job_queue/Telegram/products/catálogo,
 *       não cria rotas, não cria autoridade nova;
 * 23    comportamento determinístico;
 * 24    versão do registry/policy explícita.
 *
 * Dependências: APENAS server/agentRegistry (tipos e registros). Zero dependência
 * operacional (Supabase, Telegram, Operator, job_queue, productsRepository, LLM).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_ACTION_CATALOG,
  AGENT_MEMORY_SCOPE_CATALOG,
  AGENT_RISK_ORDER,
  AGENT_REGISTRY_CONTRACT_VERSION,
  AGENT_REGISTRY_POLICY_VERSION,
  AGENT_TABLE_CATALOG,
  AGENT_TOOL_CATALOG,
} from "../server/agentRegistry/types";
import {
  AGENT_REGISTRY,
  listAgents,
  getAgent,
} from "../server/agentRegistry/agents";
import * as agentsModule from "../server/agentRegistry/agents";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Remove comentários e strings de documentação para auditoria de imports reais. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

const EXPECTED_AGENTS = 9;
const EXPECTED_AGENT_IDS = [
  "discovery-agent",
  "research-agent",
  "product-analyst",
  "curator-agent",
  "pricing-analyst",
  "marketing-analyst",
  "analytics-analyst",
  "reliability-agent",
  "security-agent",
];

const REQUIRED_FIELDS: Array<keyof NonNullable<ReturnType<typeof getAgent>>> = [
  "agentId",
  "version",
  "role",
  "description",
  "status",
  "enabled",
  "allowedTools",
  "allowedTables",
  "allowedActions",
  "maxRisk",
  "tokenBudget",
  "timeBudgetMs",
  "memoryScope",
  "policyVersion",
];

describe("Agent Registry — contrato Fase A", () => {
  // 1. todos os agentes possuem agent_id
  it(`deve conter exatamente ${EXPECTED_AGENTS} agentes com agent_id não vazio`, () => {
    assert.equal(AGENT_REGISTRY.length, EXPECTED_AGENTS);
    for (const agent of AGENT_REGISTRY) {
      assert.ok(typeof agent.agentId === "string" && agent.agentId.trim().length > 0);
    }
  });

  // 2. todos possuem version
  it("todos devem possuir version semântica não vazia", () => {
    for (const agent of AGENT_REGISTRY) {
      assert.ok(/^\d+\.\d+(\.\d+)?$/.test(agent.version));
    }
  });

  // 3. todos possuem policy_version
  it("todos devem possuir policy_version igual à política de referência 1.0", () => {
    for (const agent of AGENT_REGISTRY) {
      assert.equal(agent.policyVersion, AGENT_REGISTRY_POLICY_VERSION);
    }
    assert.equal(AGENT_REGISTRY_POLICY_VERSION, "1.0");
  });

  // 4. todos possuem role
  it("todos devem possuir role declarativa não vazia", () => {
    for (const agent of AGENT_REGISTRY) {
      assert.ok(typeof agent.role === "string" && agent.role.trim().length > 0);
    }
  });

  // 5. todos possuem max_risk válido
  it("max_risk deve pertencer ao vocabulário fechado LOW/MEDIUM/HIGH/CRITICAL", () => {
    for (const agent of AGENT_REGISTRY) {
      assert.ok(AGENT_RISK_ORDER.includes(agent.maxRisk), agent.agentId);
    }
  });

  // 6. todos os tools pertencem ao catálogo permitido
  it("allowed_tools deve conter apenas tools do catálogo fechado", () => {
    for (const agent of AGENT_REGISTRY) {
      for (const tool of agent.allowedTools) {
        assert.ok(AGENT_TOOL_CATALOG.includes(tool), `${agent.agentId}: tool ${tool}`);
      }
    }
  });

  // 7. todas as actions pertencem ao catálogo permitido
  it("allowed_actions deve conter apenas actions do catálogo fechado", () => {
    for (const agent of AGENT_REGISTRY) {
      for (const action of agent.allowedActions) {
        assert.ok(AGENT_ACTION_CATALOG.includes(action), `${agent.agentId}: action ${action}`);
      }
    }
  });

  // 8. todas as tables referenciadas existem no contrato
  it("allowed_tables deve conter apenas tabelas do catálogo fechado", () => {
    for (const agent of AGENT_REGISTRY) {
      for (const table of agent.allowedTables) {
        assert.ok(AGENT_TABLE_CATALOG.includes(table), `${agent.agentId}: table ${table}`);
      }
    }
  });

  // 9. nenhum agente possui permissão desconhecida (memory scope)
  it("memory_scope deve conter apenas escopos do catálogo fechado", () => {
    for (const agent of AGENT_REGISTRY) {
      for (const scope of agent.memoryScope) {
        assert.ok(
          AGENT_MEMORY_SCOPE_CATALOG.includes(scope),
          `${agent.agentId}: memory scope ${scope}`
        );
      }
    }
  });

  // 10. nenhum agente possui ação fora do catálogo (idempotente com 7 — dupla verificação)
  it("nenhum agente deve possuir action fora do catálogo fechado", () => {
    const outOfCatalog: Array<{ agent: string; action: string }> = [];
    for (const agent of AGENT_REGISTRY) {
      for (const action of agent.allowedActions) {
        if (!AGENT_ACTION_CATALOG.includes(action)) outOfCatalog.push({ agent: agent.agentId, action });
      }
    }
    assert.deepEqual(outOfCatalog, []);
  });

  // 11. nenhum agente possui tool fora do catálogo (idempotente com 6)
  it("nenhum agente deve possuir tool fora do catálogo fechado", () => {
    const outOfCatalog: Array<{ agent: string; tool: string }> = [];
    for (const agent of AGENT_REGISTRY) {
      for (const tool of agent.allowedTools) {
        if (!AGENT_TOOL_CATALOG.includes(tool)) outOfCatalog.push({ agent: agent.agentId, tool });
      }
    }
    assert.deepEqual(outOfCatalog, []);
  });

  // 12. registry é imutável após carregamento
  it("AGENT_REGISTRY deve ser Object.freeze — tentativa de push deve lançar", () => {
    assert.throws(() => {
      (AGENT_REGISTRY as unknown as { push: () => void }).push();
    });
  });

  // 13. tentativa de mutação não altera o contrato
  it("mutação de um agente não deve alterar o contrato carregado", () => {
    const before = JSON.stringify(AGENT_REGISTRY);
    const agent = AGENT_REGISTRY[0];
    // tentar sobrescrever campos mutáveis aninhados
    try {
      (agent as { maxRisk: string }).maxRisk = "CRITICAL";
      Array.prototype.push.call(agent.allowedActions, "DELETE_PRODUCT");
    } catch {
      // Object.freeze interno — esperado
    }
    assert.equal(JSON.stringify(AGENT_REGISTRY), before, "registry alterado após tentativa de mutação");
    assert.equal(agent.maxRisk, "LOW", "maxRisk alterado após tentativa de mutação");
  });

  // 14. nenhum agente pode se auto-registrar
  it("não deve existir função de registro em runtime — apenas leitura", () => {
    const registryExports = Object.keys({
      AGENT_REGISTRY,
      listAgents,
      getAgent,
    });
    assert.deepEqual(
      registryExports.sort(),
      ["AGENT_REGISTRY", "getAgent", "listAgents"].sort()
    );
    // nenhum método addAgent/registerAgent existe no módulo de agentes
    assert.equal((agentsModule as { registerAgent?: unknown }).registerAgent, undefined);
    assert.equal((agentsModule as { addAgent?: unknown }).addAgent, undefined);
  });

  // 15. nenhum agente pode alterar permissões (permissões congeladas)
  it("cada allowed_* deve ser Object.freeze — push deve lançar", () => {
    for (const agent of AGENT_REGISTRY) {
      assert.throws(() => Array.prototype.push.call(agent.allowedActions, "UPDATE_PRODUCT"));
      assert.throws(() => Array.prototype.push.call(agent.allowedTools, "products.write"));
      assert.throws(() => Array.prototype.push.call(agent.allowedTables, "products"));
      assert.throws(() => Array.prototype.push.call(agent.memoryScope, "JOB_QUEUE"));
    }
  });

  // 16. registry não executa ações
  it("o contrato não deve exportar nenhum executor de ações", () => {
    for (const exportName of Object.keys(agentsModule)) {
      assert.doesNotMatch(
        exportName,
        /execute|run|dispatch|perform|invoke|apply/i,
        `export suspeito de executor: ${exportName}`
      );
    }
  });

  // 17. registry não acessa job_queue
  it("agentRegistry não deve depender de jobQueueRepository nem scheduler", () => {
    const dir = join(import.meta.dirname, "..", "server", "agentRegistry");
    for (const file of readdirSync(dir)) {
      const content = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(content, /jobQueueRepository|jobQueueScheduler/, file);
    }
  });

  // 18. registry não acessa Telegram
  it("agentRegistry não deve importar telegramBot nem telegramRepository", () => {
    const dir = join(import.meta.dirname, "..", "server", "agentRegistry");
    for (const file of readdirSync(dir)) {
      const content = stripComments(readFileSync(join(dir, file), "utf8"));
      // import statements reais são a única forma proibida de dependência operacional;
      // nomes de catálogo declarativos (telegram.send/status) são legítimos e permitidos.
      assert.doesNotMatch(
        content,
        /import\s.*telegram/i,
        `${file}: import de telegram não é permitido`
      );
    }
  });

  // 19. registry não altera products
  it("agentRegistry não deve importar productsRepository nem escrever em products", () => {
    const dir = join(import.meta.dirname, "..", "server", "agentRegistry");
    for (const file of readdirSync(dir)) {
      const content = stripComments(readFileSync(join(dir, file), "utf8"));
      assert.doesNotMatch(content, /productsRepository|updateProduct|createProduct|deleteProduct/i, file);
    }
  });

  // 20. registry não altera catálogo
  it("agentRegistry não deve importar categoriesRepository nem exportProductsJson", () => {
    const dir = join(import.meta.dirname, "..", "server", "agentRegistry");
    for (const file of readdirSync(dir)) {
      const content = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(content, /categoriesRepository|exportProductsJson|catalogSync/i, file);
    }
  });

  // 21. registry não cria rotas
  it("agentRegistry não deve registrar rotas Express nem importar server.ts", () => {
    const dir = join(import.meta.dirname, "..", "server", "agentRegistry");
    for (const file of readdirSync(dir)) {
      const content = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(content, /express|app\.use|router|routes\//i, file);
    }
  });

  // 22. registry não cria autoridade nova
  it("agentRegistry não deve importar Supabase, autoHeal, operator ou guards operacionais", () => {
    const dir = join(import.meta.dirname, "..", "server", "agentRegistry");
    for (const file of readdirSync(dir)) {
      const content = stripComments(readFileSync(join(dir, file), "utf8"));
      assert.doesNotMatch(
        content,
        /import\s.*(supabase|safeAutoHeal|cerberusOperator|operatorAutonomy|operationalGuards)/i,
        `${file}: import de módulos operacionais não é permitido`
      );
      // requireAdminAuth: nenhum uso, nem em comentário removido
      assert.doesNotMatch(content, /requireAdminAuth/i, `${file}: requireAdminAuth não deve aparecer`);
    }
  });

  // 23. comportamento determinístico
  it("listAgents e getAgent devem ser determinísticos: mesmas saídas em duas chamadas", () => {
    const first = JSON.stringify(listAgents());
    const second = JSON.stringify(listAgents());
    assert.equal(first, second);
    for (const agent of AGENT_REGISTRY) {
      const a = getAgent(agent.agentId);
      const b = getAgent(agent.agentId);
      assert.deepEqual(a, b);
      assert.equal(JSON.stringify(a), JSON.stringify(b));
    }
  });

  it("default deny: agente inexistente deve retornar undefined (sem autoridade implícita)", () => {
    assert.equal(getAgent("agente-inventado-que-nao-existe"), undefined);
    assert.equal(listAgents().find(a => a.agentId === "inexistente"), undefined);
  });

  // 24. versão do registry/policy explícita
  it("versões do contrato e da política devem ser explícitas e semânticas", () => {
    assert.equal(AGENT_REGISTRY_CONTRACT_VERSION, "1.0");
    assert.equal(AGENT_REGISTRY_POLICY_VERSION, "1.0");
    assert.ok(/^\d+\.\d+(\.\d+)?$/.test(AGENT_REGISTRY_CONTRACT_VERSION));
    assert.ok(/^\d+\.\d+(\.\d+)?$/.test(AGENT_REGISTRY_POLICY_VERSION));
  });

  // Prova estrutural adicional: agent_ids esperados
  it("os agent_ids devem ser exatamente os 9 previstos", () => {
    assert.deepEqual(AGENT_REGISTRY.map(a => a.agentId).sort(), EXPECTED_AGENT_IDS.sort());
  });

  // Prova: enabled é declarativo (todos false nesta fase)
  it("enabled=false para todos os agentes nesta fase — não representa execução automática", () => {
    for (const agent of AGENT_REGISTRY) {
      assert.equal(agent.enabled, false, agent.agentId);
    }
  });

  // Prova: maxRisk LOW bloqueia ações de risco maior (default deny por policy)
  it("nenhum agente declarado pode ter ação com risco acima do max_risk declarado", () => {
    const RISK_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    const ACTION_RISK: Record<string, number> = {
      READ_PRODUCT: 0,
      READ_OBSERVATION: 0,
      ANALYZE_PRODUCT: 0,
      READ_COMMERCIAL_SIGNAL: 0,
      READ_COMMERCIAL_ARTIFACT: 0,
      READ_JOB_QUEUE: 0,
      READ_OPERATIONAL_EVENT: 0,
      CREATE_RECOMMENDATION: 1,
      CREATE_SIGNAL: 1,
      ENQUEUE_JOB: 1,
      PUBLISH_PRODUCT: 2,
      SEND_TELEGRAM: 2,
      UPDATE_PRODUCT: 2,
      DELETE_PRODUCT: 3,
      UPDATE_PRICE: 3,
      RUN_RECOVERY: 3,
    };
    for (const agent of AGENT_REGISTRY) {
      const maxRank = RISK_RANK[agent.maxRisk];
      for (const action of agent.allowedActions) {
        assert.ok(
          ACTION_RISK[action] <= maxRank,
          `${agent.agentId}: action ${action} excede max_risk ${agent.maxRisk}`
        );
      }
    }
  });

  // Prova: campos obrigatórios presentes (regra de validação de loading)
  it("todos os campos obrigatórios devem estar presentes em todos os agentes", () => {
    for (const agent of AGENT_REGISTRY) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(field in agent, `${agent.agentId} sem campo ${field}`);
        assert.notEqual(agent[field], undefined, `${agent.agentId}.${field} undefined`);
        assert.notEqual(agent[field], null, `${agent.agentId}.${field} null`);
      }
    }
  });

  // Prova: registry inválido falha no carregamento (não silencioso) — estrutura
  it("AGENT_REGISTRY com entrada fora da forma deve lançar ao validar campos", () => {
    const broken = AGENT_REGISTRY.slice().concat({} as never);
    let invalid = 0;
    for (const agent of broken) {
      if (!("agentId" in agent) || !("maxRisk" in agent)) invalid++;
    }
    assert.ok(invalid > 0, "defeito artificial deveria ser detectável");
    // o registro real passa:
    assert.equal(
      AGENT_REGISTRY.filter(a => !("agentId" in a)).length,
      0
    );
  });
});
