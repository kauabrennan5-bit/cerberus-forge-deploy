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

test("semantic discovery fica totalmente inerte sem provider configurado", async () => {
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

test("query expansion mantém OpenAI como primário mesmo com Gemini configurado", async () => {
  autonomousCuratorSemanticDiscoveryInternals.clearQueryExpansionCache();
  let openAICalls = 0;
  let geminiCalls = 0;
  const result = await expandAutonomousCuratorQueries(
    profileForCategory("Móveis"),
    ["mesa lateral vintage"],
    {
      env: {
        OPENAI_API_KEY: "test-openai",
        GEMINI_API_KEY: "test-gemini",
        GEMINI_AUTONOMOUS_DISCOVERY_ENABLED: "true",
      },
      budget: allowBudget,
      fetchImpl: (async () => {
        openAICalls += 1;
        return openAIResponse({ queries: ["mesa tubular cromada"] });
      }) as typeof fetch,
      geminiGenerate: async () => {
        geminiCalls += 1;
        return { text: JSON.stringify({ queries: ["mesa globo acrilico"] }) };
      },
    },
  );
  assert.deepEqual(result, ["mesa tubular cromada"]);
  assert.equal(openAICalls, 1);
  assert.equal(geminiCalls, 0);
});

test("query expansion cai para Gemini quando OpenAI está sem quota e preserva sanitização", async () => {
  autonomousCuratorSemanticDiscoveryInternals.clearQueryExpansionCache();
  let openAICalls = 0;
  let geminiCalls = 0;
  let geminiRequest: any = null;
  const result = await expandAutonomousCuratorQueries(
    profileForCategory("Decoração"),
    ["decoracao bauhaus"],
    {
      env: {
        OPENAI_API_KEY: "test-openai",
        GEMINI_API_KEY: "test-gemini",
        OPENAI_AUTONOMOUS_DISCOVERY_MAX_ATTEMPTS: "1",
        GEMINI_AUTONOMOUS_DISCOVERY_ENABLED: "true",
        GEMINI_AUTONOMOUS_DISCOVERY_MODEL: "gemini-3.1-flash-lite",
      },
      budget: allowBudget,
      fetchImpl: (async () => {
        openAICalls += 1;
        return new Response(JSON.stringify({
          error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" },
        }), { status: 429, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      geminiGenerate: async (request) => {
        geminiCalls += 1;
        geminiRequest = request;
        return {
          text: JSON.stringify({
            queries: [
              "escultura geometrica acrilica",
              "vaso cromado anos 70",
              "https://example.com invalida",
              "escultura geometrica acrilica",
              "decoracao bauhaus",
            ],
          }),
        };
      },
    },
  );

  assert.equal(openAICalls, 1);
  assert.equal(geminiCalls, 1);
  assert.equal(geminiRequest.model, "gemini-3.1-flash-lite");
  assert.equal(geminiRequest.config.responseMimeType, "application/json");
  assert.ok(geminiRequest.config.responseSchema);
  assert.deepEqual(result, ["escultura geometrica acrilica", "vaso cromado anos 70"]);
});

test("query expansion tenta modelo Gemini secundário após indisponibilidade temporária do primário", async () => {
  autonomousCuratorSemanticDiscoveryInternals.clearQueryExpansionCache();
  const models: string[] = [];
  const result = await expandAutonomousCuratorQueries(
    profileForCategory("Tecnologia"),
    ["radio retro madeira"],
    {
      env: {
        GEMINI_API_KEY: "test-gemini",
        GEMINI_AUTONOMOUS_DISCOVERY_ENABLED: "true",
        GEMINI_AUTONOMOUS_DISCOVERY_MODEL: "gemini-3.1-flash-lite",
        GEMINI_AUTONOMOUS_DISCOVERY_FALLBACK_MODEL: "gemini-3.5-flash-lite",
      },
      budget: allowBudget,
      geminiGenerate: async (request) => {
        models.push(String(request.model));
        if (request.model === "gemini-3.1-flash-lite") throw new Error("503 high demand");
        return { text: JSON.stringify({ queries: ["radio portatil alca vintage"] }) };
      },
    },
  );
  assert.deepEqual(models, ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
  assert.deepEqual(result, ["radio portatil alca vintage"]);
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

test("semantic ranking cai para Gemini após quota da OpenAI sem inventar IDs", async () => {
  let geminiRequest: any = null;
  const result = await rankAutonomousCuratorCandidates(
    profileForCategory("Móveis"),
    [
      {
        identityKey: "1:2",
        name: "Mesa lateral tubular cromada",
        query: "mesa lateral vintage",
        page: 1,
        price: 180,
        imageUrl: null,
        lexicalScore: 110,
      },
      {
        identityKey: "3:4",
        name: "Mesa de apoio redonda",
        query: "mesa apoio retro",
        page: 1,
        price: 150,
        imageUrl: null,
        lexicalScore: 80,
      },
    ],
    {
      env: {
        OPENAI_API_KEY: "test-openai",
        GEMINI_API_KEY: "test-gemini",
        OPENAI_AUTONOMOUS_DISCOVERY_MAX_ATTEMPTS: "1",
        GEMINI_AUTONOMOUS_DISCOVERY_ENABLED: "true",
        GEMINI_AUTONOMOUS_DISCOVERY_MODEL: "gemini-3.1-flash-lite",
      },
      budget: allowBudget,
      fetchImpl: (async () => new Response(JSON.stringify({
        error: { message: "quota exhausted", type: "insufficient_quota", code: "insufficient_quota" },
      }), { status: 429, headers: { "content-type": "application/json" } })) as typeof fetch,
      geminiGenerate: async (request) => {
        geminiRequest = request;
        return { text: JSON.stringify({
          decisions: [
            {
              identityKey: "1:2",
              fitScore: 94,
              categoryFit: 97,
              worthEnriching: true,
              confidence: "HIGH",
              signals: ["tubular", "cromado"],
              reason: "Forma e material coerentes.",
            },
            {
              identityKey: "999:999",
              fitScore: 100,
              categoryFit: 100,
              worthEnriching: true,
              confidence: "HIGH",
              signals: ["inventado"],
              reason: "deve ser descartado",
            },
          ],
        }) };
      },
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.model, "gemini-3.1-flash-lite");
  assert.deepEqual(result.decisions.map(item => item.identityKey), ["1:2"]);
  assert.equal(geminiRequest.config.responseMimeType, "application/json");
  assert.equal(geminiRequest.config.responseSchema.properties.decisions.items.properties.identityKey.enum, undefined);
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

test("orçamento esgotado não chama provider nem inventa decisão", async () => {
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
