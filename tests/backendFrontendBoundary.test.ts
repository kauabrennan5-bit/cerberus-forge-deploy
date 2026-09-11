import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSource = fs.readFileSync("server.ts", "utf8");
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const buildSelector = fs.readFileSync("scripts/build-by-target.mjs", "utf8");
const cloudflareWorkflow = fs.readFileSync(".github/workflows/cloudflare-storefront-deploy.yml", "utf8");

test("production backend never serves the legacy SPA fallback", () => {
  assert.equal(serverSource.includes('res.sendFile(path.join(distPath, "index.html"))'), false);
  assert.equal(serverSource.includes('app.use(express.static(distPath'), false);
  assert.match(serverSource, /app\.get\("\*", redirectToPublicSite\)/);
});

test("human visual routes redirect to the canonical public site", () => {
  assert.match(serverSource, /PUBLIC_SITE_URL \|\| "https:\/\/cerberus-design-static\.onrender\.com"/);
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

test("frontend-only hosting build never emits the Node backend bundle", () => {
  assert.match(packageJson.scripts["build:frontend"], /generate-static-catalog\.js/);
  assert.match(packageJson.scripts["build:frontend"], /vite build/);
  assert.match(packageJson.scripts["build:frontend"], /generate-product-og-pages\.js/);
  assert.equal(packageJson.scripts["build:frontend"].includes("esbuild server.ts"), false);
});

test("Cloudflare Pages deployment publishes only the prebuilt static storefront", () => {
  assert.match(cloudflareWorkflow, /npm run build:frontend/);
  assert.match(cloudflareWorkflow, /CLOUDFLARE_PAGES_PROJECT: cerberus-finds/);
  assert.match(cloudflareWorkflow, /\/pages\/projects/);
  assert.match(cloudflareWorkflow, /production_branch/);
  assert.match(cloudflareWorkflow, /cloudflare\/wrangler-action@v4/);
  assert.match(cloudflareWorkflow, /wranglerVersion: "4"/);
  assert.match(cloudflareWorkflow, /pages deploy dist --project-name=/);
  assert.match(cloudflareWorkflow, /--branch=main/);
  assert.equal(cloudflareWorkflow.includes("command: deploy\n"), false);
  assert.equal(cloudflareWorkflow.includes("npm start"), false);
  assert.equal(cloudflareWorkflow.includes("build:backend"), false);
  assert.equal(cloudflareWorkflow.includes("workers/subdomain"), false);
});
