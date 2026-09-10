import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("production start and catalog builds preload the dedicated Supabase transport", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.start, /--import \.\/server\/lib\/supabaseNetworkBootstrap\.mjs/);
  assert.match(pkg.scripts["build:full"], /--import \.\/server\/lib\/supabaseNetworkBootstrap\.mjs/);
  assert.match(pkg.scripts["build:backend"], /--import \.\/server\/lib\/supabaseNetworkBootstrap\.mjs/);
});

test("Supabase transport is scoped, uses fresh IPv4 sockets, and has a DNS resolver fallback", async () => {
  const source = await readFile(new URL("../server/lib/supabaseNetworkBootstrap.mjs", import.meta.url), "utf8");
  assert.match(source, /target\.origin !== supabaseOrigin/);
  assert.match(source, /family: 4/);
  assert.match(source, /agent: false/);
  assert.match(source, /lookup: resilientIpv4Lookup/);
  assert.match(source, /new dns\.Resolver\(\)/);
  assert.match(source, /setServers\(\["1\.1\.1\.1", "8\.8\.8\.8"\]\)/);
  assert.match(source, /ENOTFOUND/);
  assert.match(source, /EAI_AGAIN/);
  assert.match(source, /SUPABASE_FETCH_ORIGIN_MISMATCH/);
  assert.doesNotMatch(source, /retrying|for \(.*retry|setInterval/i);
});

test("preload replaces fetch only when Supabase is configured", () => {
  const bootstrap = fileURLToPath(new URL("../server/lib/supabaseNetworkBootstrap.mjs", import.meta.url));
  const probe = "process.stdout.write(globalThis.fetch.name)";
  const enabled = spawnSync(process.execPath, ["--import", bootstrap, "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, SUPABASE_URL: "https://project.supabase.co" },
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /supabaseSafeFetch$/);

  const disabled = spawnSync(process.execPath, ["--import", bootstrap, "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, SUPABASE_URL: "", VITE_SUPABASE_URL: "" },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.doesNotMatch(disabled.stdout, /supabaseSafeFetch$/);
});
