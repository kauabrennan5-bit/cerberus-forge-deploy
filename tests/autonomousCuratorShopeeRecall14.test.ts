import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShopeeImageReference } from "../server/commercial/affiliate/shopeeApiClient";
import { fetchProductDataFromUrl } from "../server/services/scraper";
import {
  AUTONOMOUS_CURATOR_PROFILE_VERSION,
  profileForCategory,
} from "../server/services/autonomousCuratorProfiles";
import { cheapProfileScore } from "../server/services/autonomousCuratorScoring";

test("profile 1.7 uses broad plus concrete Shopee-calibrated discovery anchors", () => {
  assert.equal(AUTONOMOUS_CURATOR_PROFILE_VERSION, "1.7");

  const lighting = profileForCategory("Iluminação");
  assert.ok(lighting.queries.includes("luminaria cogumelo cromada space age"));
  assert.ok(lighting.queries.includes("abajur cogumelo bauhaus"));
  assert.ok(lighting.queries.includes("luminaria bauhaus"));
  assert.ok(lighting.queries.includes("abajur cogumelo"));

  const technology = profileForCategory("Tecnologia");
  assert.ok(technology.queries.includes("radio bluetooth retro madeira vintage"));
  assert.ok(technology.queries.includes("radio retro portatil bluetooth madeira"));
  assert.equal(technology.queries.includes("tecnologia anos 70 design"), false);
});

test("iconic category archetypes outrank generic recall without weakening the final gates", () => {
  const lighting = profileForCategory("Iluminação");
  assert.ok(cheapProfileScore(lighting, "Luminária de Mesa Cogumelo Metálico Touch") > -1000);
  assert.ok(cheapProfileScore(lighting, "Luminária cromada moderna para mesa") > -1000);
  assert.ok(cheapProfileScore(lighting, "Luminária de Mesa Cogumelo Metálico Touch") > cheapProfileScore(lighting, "Luminária cromada moderna para mesa"));

  const technology = profileForCategory("Tecnologia");
  const iconic = cheapProfileScore(technology, "Rádio Retro Vintage Portátil Bluetooth Madeira");
  const genericRecall = cheapProfileScore(technology, "Cabo USB retro compacto");
  assert.ok(iconic > genericRecall);
  assert.equal(cheapProfileScore(technology, "Cabo USB simples"), -1000);
});

test("official Shopee image hashes normalize to the canonical Shopee CDN", () => {
  const hash = "br-11134207-7r98o-mcwa1l01rv2988";
  assert.equal(
    normalizeShopeeImageReference(hash),
    `https://down-br.img.susercontent.com/file/${hash}`,
  );
  assert.equal(
    normalizeShopeeImageReference(`${hash}_tn`),
    `https://down-br.img.susercontent.com/file/${hash}`,
  );
});

test("official full image URLs remain usable and invalid references fail closed", () => {
  const url = "https://down-br.img.susercontent.com/file/br-11134207-7r98o-mcwa1l01rv2988";
  assert.equal(normalizeShopeeImageReference(url), url);
  assert.equal(normalizeShopeeImageReference("x"), null);
  assert.equal(normalizeShopeeImageReference("javascript:alert(1)"), null);
  assert.equal(normalizeShopeeImageReference(null), null);
});

test("Shopee gallery parser recovers multiple hashes from normal JSON", async () => {
  const first = "br-11134207-7r98o-mcwa1l01rv2988";
  const second = "sg-11134201-8258u-mqvn863wq3gn92";
  const raw = `<script>window.__PDP__={"images":["${first}","${second}"]};</script>`;

  const result = await fetchProductDataFromUrl("", raw);
  assert.deepEqual(result.images, [
    `https://down-br.img.susercontent.com/file/${first}`,
    `https://down-br.img.susercontent.com/file/${second}`,
  ]);
});

test("Shopee gallery parser recovers escaped JSON hashes and removes thumbnail suffixes", async () => {
  const first = "br-11134207-7r98o-mcwa1l01rv2988";
  const second = "sg-11134201-8258u-mqvn863wq3gn92";
  const raw = `<script>window.__PDP__="{\\"image_list\\":[\\"${first}_tn\\",\\"${second}_b\\"]}";</script>`;

  const result = await fetchProductDataFromUrl("", raw);
  assert.deepEqual(result.images, [
    `https://down-br.img.susercontent.com/file/${first}`,
    `https://down-br.img.susercontent.com/file/${second}`,
  ]);
});

test("Shopee gallery parser ignores hash arrays under unrelated keys", async () => {
  const first = "br-11134207-7r98o-mcwa1l01rv2988";
  const second = "sg-11134201-8258u-mqvn863wq3gn92";
  const raw = `<script>window.__PDP__={"recommended":["${first}","${second}"]};</script>`;

  const result = await fetchProductDataFromUrl("", raw);
  assert.deepEqual(result.images, []);
});