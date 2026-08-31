import test from "node:test";
import assert from "node:assert/strict";
import { profileForCategory } from "../server/services/autonomousCuratorProfiles";
import {
  expandAutonomousCuratorQueries,
  rankAutonomousCuratorCandidates,
  autonomousCuratorSemanticDiscoveryInternals,
} from "../server/services/autonomousCuratorSemanticDiscovery";

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

function openAIResponse(value: unknown): Response {
  return new Response(JSON.stringify({ output_text: JSON.stringify(value) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("semantic discovery fica totalmente inerte sem OPENAI_API_KEY", async () => {
  let calls = 0;
  const result = await rankAutonomousCuratorCandidates(
    profileForCategory("Iluminação"),
    [{
      identityKey: "10:20",
      name: "Abajur moderno de mesa",
      query: "luminaria retro",
      page: 1,
      price: 99,
      imageUrl: "https://cdn.example.test/a.jpg",
      lexicalScore: -1000,
    }],
    {
      env: {},
      budget: allowBudget,
      fetchImpl: (async () => {
        calls += 1;
        return openAIResponse({ decisions: [] });
      }) as typeof fetch,
    },
  );
  assert.equal(result.status, "disabled");
  assert.equal(calls, 0);
});

test("query expansion usa Luna, Structured Outputs e cache estável apesar da rotação", async () => {
  autonomousCuratorSemanticDiscoveryInternals.clearQueryExpansionCache();
  const profile = profileForCategory("Iluminação");
  const queriesA = ["luminaria bauhaus", "abajur cogumelo", "luminaria retro"];
  const queriesB = ["luminaria retro", "luminaria bauhaus", "abajur cogumelo"];
  let calls = 0;
  let capturedBody: any = null;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return openAIResponse({
      queries: [
        "abajur globo cromado",
        "luminaria esfera opalina",
        "https://example.com invalida",
        "abajur globo cromado",
      ],
    });
  }) as typeof fetch;

  const first = await expandAutonomousCuratorQueries(profile, queriesA, {
    env: { OPENAI_API_KEY: "test-key" },
    budget: allowBudget,
    fetchImpl,
  });
  const second = await expandAutonomousCuratorQueries(profile, queriesB, {
    env: { OPENAI_API_KEY: "test-key" },
    budget: allowBudget,
    fetchImpl,
  });

  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(first, ["abajur globo cromado", "luminaria esfera opalina"]);
  assert.equal(capturedBody.model, "gpt-5.6-luna");
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.text.format.type, "json_schema");
  assert.equal(capturedBody.text.format.strict, true);
});

test("semantic ranking restringe IDs aos candidatos reais e usa imagem só para resgate lexical", async () => {
  let capturedBody: any = null;
  const result = await rankAutonomousCuratorCandidates(
    profileForCategory("Iluminação"),
    [
      {
        identityKey: "10:20",
        name: "Abajur decorativo moderno modelo 216",
        query: "abajur globo cromado",
        page: 1,
        price: 120,
        imageUrl: "https://cdn.example.test/rescue.jpg",
        lexicalScore: -1000,
      },
      {
        identityKey: "30:40",
        name: "Abajur Cogumelo Bauhaus Cromado",
        query: "abajur cogumelo",
        page: 1,
        price: 220,
        imageUrl: "https://cdn.example.test/lexical.jpg",
        lexicalScore: 100,
      },
    ],
    {
      env: { OPENAI_API_KEY: "secret-test-key" },
      budget: allowBudget,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body || "{}"));
        return openAIResponse({
          decisions: [
            {
              identityKey: "10:20",
              fitScore: 91,
              categoryFit: 96,
              worthEnriching: true,
              confidence: "HIGH",
              signals: ["space age", "globo", "cromado"],
              reason: "Miniatura mostra forma escultórica coerente.",
            },
          ],
        });
      }) as typeof fetch,
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.decisions[0].identityKey, "10:20");
  const enumIds = capturedBody.text.format.schema.properties.decisions.items.properties.identityKey.enum;
  assert.deepEqual(enumIds, ["10:20", "30:40"]);
  const content = capturedBody.input[0].content;
  const imageParts = content.filter((part: any) => part.type === "input_image");
  assert.equal(imageParts.length, 1);
  assert.equal(imageParts[0].image_url, "https://cdn.example.test/rescue.jpg");
  assert.ok(!JSON.stringify(content).includes("https://cdn.example.test/lexical.jpg"));
});

test("resposta com ID que não pertence ao lote é descartada mesmo se o provider devolver", async () => {
  const result = await rankAutonomousCuratorCandidates(
    profileForCategory("Móveis"),
    [{
      identityKey: "1:2",
      name: "Mesa lateral metálica",
      query: "mesa apoio retro",
      page: 1,
      price: 180,
      imageUrl: null,
      lexicalScore: -1000,
    }],
    {
      env: { OPENAI_API_KEY: "test-key" },
      budget: allowBudget,
      fetchImpl: (async () => openAIResponse({
        decisions: [{
          identityKey: "999:999",
          fitScore: 100,
          categoryFit: 100,
          worthEnriching: true,
          confidence: "HIGH",
          signals: ["inventado"],
          reason: "não pode entrar",
        }],
      })) as typeof fetch,
    },
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(result.decisions, []);
});

test("orçamento esgotado não chama OpenAI nem inventa decisão", async () => {
  let calls = 0;
  const result = await rankAutonomousCuratorCandidates(
    profileForCategory("Decoração"),
    [{
      identityKey: "5:6",
      name: "Objeto decorativo",
      query: "decoracao vintage",
      page: 1,
      price: 80,
      imageUrl: null,
      lexicalScore: -1000,
    }],
    {
      env: { OPENAI_API_KEY: "test-key" },
      budget: denyBudget,
      fetchImpl: (async () => {
        calls += 1;
        return openAIResponse({ decisions: [] });
      }) as typeof fetch,
    },
  );
  assert.equal(result.status, "budget_exhausted");
  assert.equal(calls, 0);
  assert.deepEqual(result.decisions, []);
});

test("semantic ranking schema enumera somente identidades reais do lote", () => {
  const schema = autonomousCuratorSemanticDiscoveryInternals.semanticRankingSchema(["a:b", "c:d"]) as any;
  assert.deepEqual(schema.properties.decisions.items.properties.identityKey.enum, ["a:b", "c:d"]);
  assert.equal(schema.additionalProperties, false);
});
