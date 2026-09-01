import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { probeOfficialShopeeImage } from "../server/services/shopeeCandidateQualification";

const URL = "https://down-br.img.susercontent.com/file/abcdefghijklmnopqrstuvwx";

async function png(width = 600, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 220, g: 220, b: 220 } } }).png().toBuffer();
}

function response(body: Buffer, options: { status?: number; contentType?: string | null; url?: string } = {}): Response {
  const headers = new Headers();
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "image/png");
  const res = new Response(body, { status: options.status ?? 200, headers });
  Object.defineProperty(res, "url", { value: options.url ?? URL });
  return res;
}

describe("official Shopee image probe", () => {
  it("accepts valid HTTPS Shopee CDN raster image", async () => {
    const body = await png();
    const result = await probeOfficialShopeeImage(URL, { fetchImpl: async () => response(body) });
    assert.equal(result.ok, true);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.width, 600);
    assert.equal(result.height, 600);
  });

  it("follows a controlled redirect and accepts the final official Shopee CDN host", async () => {
    const body = await png();
    let redirect = "";
    const result = await probeOfficialShopeeImage(URL, {
      fetchImpl: async (_url, init) => {
        redirect = String((init as any)?.redirect || "");
        return response(body, { url: "https://cf.shopee.com.br/file/abcdefghijklmnopqrstuvwx" });
      },
    });
    assert.equal(redirect, "follow");
    assert.equal(result.ok, true);
  });

  it("does not false-negative when CDN omits MIME but bytes identify a supported image", async () => {
    const body = await png();
    const result = await probeOfficialShopeeImage(URL, { fetchImpl: async () => response(body, { contentType: null }) });
    assert.equal(result.ok, true);
    assert.equal(result.mimeType, "image/png");
  });

  it("hard rejects excessively small image", async () => {
    const body = await png(120, 120);
    const result = await probeOfficialShopeeImage(URL, { fetchImpl: async () => response(body) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "IMAGE_TOO_SMALL");
  });

  it("hard rejects placeholder URL before network", async () => {
    let called = false;
    const result = await probeOfficialShopeeImage("https://down-br.img.susercontent.com/file/placeholder", { fetchImpl: async () => { called = true; throw new Error("should not call"); } });
    assert.equal(result.ok, false);
    assert.equal(called, false);
    assert.equal(result.reason, "IMAGE_PLACEHOLDER");
  });

  it("hard rejects redirect to a non-Shopee image host", async () => {
    const body = await png();
    const result = await probeOfficialShopeeImage(URL, { fetchImpl: async () => response(body, { url: "https://images.example.com/product.png" }) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "IMAGE_REDIRECT_HOST_INVALID");
  });
});
