import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Telegram V2 dedicated gate remains present and separate from global embedded contract", async () => {
  const workflow = await readFile(new URL("../.github/workflows/telegram-v2-gate.yml", import.meta.url), "utf8");
  const globalContract = await readFile(new URL("./telegramRequiredContract.test.ts", import.meta.url), "utf8");
  assert.match(workflow, /Telegram V2/i);
  assert.match(globalContract, /Telegram/i);
});
