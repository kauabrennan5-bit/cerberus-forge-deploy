import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSource = fs.readFileSync("server.ts", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const buildSelector = fs.readFileSync("scripts/build-by-target.mjs", "utf8");

test("production backend never serves the legacy SPA fallback", () => {
  assert.equal(serverSource.includes('res.sendFile(path.join(distPath, "index.html"))'), false);
  assert.equal(serverSource.includes('app.use(express.static(distPath'), false);
  assert.match(serverSource, /app\.get\("\*", redirectToPublicSite\)/);
});

test("human visual routes redirect to the canonical public site", () => {
  assert.match(serverSource, /PUBLIC_SITE_URL \|\| "https:\/\/cerberus-design-static\.onrender\.com"/);
  assert.equal(serverSource.includes("cerberus-design-preview.onrender.com"), false);
  assert.match(serverSource, /app\.get\("\/produto\/:slug"/);
  assert.match(serverSource, /if \(!isSocialCrawler\(req\.headers\["user-agent"\]\)\)/);
  assert.match(serverSource, /return redirectToPublicSite\(req, res\)/);
  assert.match(serverSource, /new URL\(req\.originalUrl \|\| req\.url \|\| "\/", `\$\{publicSiteBase\}\/`\)/);
});

test("crawler Open Graph and backend data/API surfaces remain backend-owned", () => {
  assert.match(serverSource, /meta property="og:title"/);
  assert.match(serverSource, /app\.get\("\/data\/\*"/);
  assert.match(serverSource, /path\.resolve\(process\.cwd\(\), "public", "data"\)/);
  assert.match(serverSource, /app\.all\(\["\/api", "\/api\/\*"\]/);
  assert.match(serverSource, /API_ROUTE_NOT_FOUND/);
  assert.match(serverSource, /app\.get\("\/health"/);
  assert.match(serverSource, /app\.post\(\["\/api\/telegram\/webhook", "\/api\/telegram-webhook"\]/);
});

test("Render backend build target skips Vite and frontend OG generation", () => {
  assert.equal(packageJson.scripts.build, "node scripts/build-by-target.mjs");
  assert.match(packageJson.scripts["build:backend"], /generate-static-catalog\.js/);
  assert.match(packageJson.scripts["build:backend"], /esbuild server\.ts/);
  assert.equal(packageJson.scripts["build:backend"].includes("vite build"), false);
  assert.equal(packageJson.scripts["build:backend"].includes("generate-product-og-pages"), false);
  assert.match(buildSelector, /CERBERUS_BUILD_TARGET/);
  assert.match(buildSelector, /target === 'backend' \? 'build:backend' : 'build:full'/);
});
