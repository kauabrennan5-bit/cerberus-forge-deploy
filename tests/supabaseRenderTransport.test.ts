import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("production start preloads the dedicated Supabase transport", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.scripts.start, /--import \.\/server\/lib\/supabaseNetworkBootstrap\.mjs/);
});

test("Supabase transport is scoped to configured origin and avoids Undici socket reuse", async () => {
  const source = await readFile(new URL("../server/lib/supabaseNetworkBootstrap.mjs", import.meta.url), "utf8");
  assert.match(source, /target\.origin !== supabaseOrigin/);
  assert.match(source, /family: 4/);
  assert.match(source, /agent: false/);
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
    env: { ...process.env, SUPABASE_URL: "" },
  });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.doesNotMatch(disabled.stdout, /supabaseSafeFetch$/);
});
