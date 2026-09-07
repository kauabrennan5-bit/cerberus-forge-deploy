import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  searchShopeeProductsDDG,
  type ShopeeSearchHttpClient,
} from "../server/services/shopeeSearchProvider";

function client(status: number, data: unknown): ShopeeSearchHttpClient {
  return { get: async () => ({ status, data }) };
}

describe("searchShopeeProductsDDG", () => {
  it("retorna candidatos DDG estruturados sem promover o link a dado canônico", async () => {
    const redirected = encodeURIComponent("https://shopee.com.br/Luminaria-i.1530442944.23794344926");
    const result = await searchShopeeProductsDDG("luminária", 5, client(200, `
      <a class="result-link" href="//duckduckgo.com/l/?uddg=${redirected}">Título observado no DDG</a>
      <a class="result-link" href="https://example.com/fora">Ignorar</a>
    `));

    assert.equal(result.state, "DDG_OK");
    assert.equal(result.provider, "duckduckgo");
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(result.candidates[0], {
      url: "https://shopee.com.br/Luminaria-i.1530442944.23794344926",
      shopId: "1530442944",
      itemId: "23794344926",
      rawTitle: "Título observado no DDG",
    });
  });

  it("classifica desafio e HTTP de bloqueio como DDG_BLOCKED", async () => {
    const challenge = await searchShopeeProductsDDG("copo", 3, client(200, "<div id='anomaly-modal'>captcha</div>"));
    const blockedStatus = await searchShopeeProductsDDG("copo", 3, client(202, "aguarde"));

    assert.equal(challenge.state, "DDG_BLOCKED");
    assert.equal(blockedStatus.state, "DDG_BLOCKED");
    assert.deepEqual(challenge.candidates, []);
  });

  it("classifica resposta válida sem candidatos como DDG_NO_RESULTS", async () => {
    const result = await searchShopeeProductsDDG("termo inexistente", 3, client(200, "<html><body>sem resultados</body></html>"));
    assert.equal(result.state, "DDG_NO_RESULTS");
    assert.deepEqual(result.candidates, []);
  });

  it("classifica falha de rede como DDG_UNAVAILABLE", async () => {
    const result = await searchShopeeProductsDDG("copo", 3, {
      get: async () => { throw new Error("network down"); },
    });
    assert.equal(result.state, "DDG_UNAVAILABLE");
    assert.equal(result.httpStatus, null);
  });

  it("não contém ferramenta de busca Google, Gemini nem acoplamento com Telegram na camada web", () => {
    const sourcePath = fileURLToPath(new URL("../server/services/shopeeSearchProvider.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    const forbiddenGoogleTool = ["google", "Search", "Retrieval"].join("");
    assert.equal(source.includes(forbiddenGoogleTool), false);
    assert.doesNotMatch(source, /GoogleGenAI|@google\/genai/);
    assert.doesNotMatch(source, /from\s+["'][^"']*telegram/i);
  });
});
