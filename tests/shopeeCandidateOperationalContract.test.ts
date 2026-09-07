import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const command = fs.readFileSync("server/services/shopeeCommandRanked.ts", "utf8");
const qualification = fs.readFileSync("server/services/shopeeCandidateQualification.ts", "utf8");

describe("ranked /shopee structural safety contract", () => {
  it("preserves provider productLink and never constructs a product URL from ids", () => {
    assert.match(command, /validateOfficialProductLink\(lookup\.productLink, candidate\.shopId, candidate\.itemId\)/);
    assert.match(command, /normalizedUrl:\s*officialProductLink/);
    assert.doesNotMatch(command, /`https:\/\/shopee\.com\.br\/product\/\$\{/);
  });

  it("uses official Affiliate imageUrl as the primary term-mode visual evidence", () => {
    assert.match(command, /acquisition\.imageUrl\s*\|\|\s*lookup\.imageUrl/);
    assert.match(command, /qualifyImage\(candidate\.imageUrl, candidate\.name\)/);
    assert.match(command, /imagemPrincipal:\s*officialImageUrl/);
  });

  it("validates DDG identities only with exact API operations, never keyword search", () => {
    assert.match(command, /lookupProduct\(\{\s*shopId:\s*candidate\.shopId,\s*itemId:\s*candidate\.itemId\s*\}\)/);
    assert.match(command, /acquireAffiliateLink\(\{\s*shopId:\s*candidate\.shopId,\s*itemId:\s*candidate\.itemId\s*\}\)/);
    assert.doesNotMatch(command, /searchShopeeOffersWithRetry|\.searchOffers\(/);
  });

  it("retains explicit human approval callbacks and authoritative preflight boundary", () => {
    assert.match(command, /confirm_pub:/);
    assert.match(command, /status:\s*"pending"/);
    assert.doesNotMatch(command, /publish\s*\(/);
  });

  it("does not repair or transform image bytes in manual qualification", () => {
    assert.match(qualification, /allowRepair:\s*false/);
    assert.doesNotMatch(qualification, /\.resize\s*\(/);
    assert.doesNotMatch(qualification, /\.composite\s*\(/);
    assert.doesNotMatch(qualification, /\.toFormat\s*\(/);
  });

  it("logs masked image diagnostics without URL or product identity fields", () => {
    assert.match(qualification, /candidateIndex/);
    assert.match(qualification, /httpStatus/);
    assert.match(qualification, /mimeType/);
    assert.match(qualification, /dimensions/);
    const diagnosticBody = qualification.slice(qualification.indexOf("export function safeShopeeImageDiagnostic"));
    assert.doesNotMatch(diagnosticBody, /productLink|affiliateUrl|shopId|itemId/);
  });
});
