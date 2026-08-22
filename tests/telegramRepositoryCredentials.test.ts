import assert from "node:assert/strict";
import test from "node:test";

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY"] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;
let importSequence = 0;

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function loadRepositoryWithEnv(values: {
  url?: string;
  serviceRoleKey?: string;
  genericKey?: string;
}) {
  setEnv("SUPABASE_URL", values.url);
  setEnv("SUPABASE_SERVICE_ROLE_KEY", values.serviceRoleKey);
  setEnv("SUPABASE_KEY", values.genericKey);

  const moduleUrl = new URL("../server/repositories/telegramRepository.ts", import.meta.url);
  moduleUrl.searchParams.set("credential-test", String(importSequence++));
  return import(moduleUrl.href);
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) setEnv(key, originalEnv[key]);
}

test.afterEach(restoreEnv);

test("cria o cliente quando SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY existem", async () => {
  const repository = await loadRepositoryWithEnv({
    url: "https://example.supabase.co",
    serviceRoleKey: "service-role-test-fixture",
    genericKey: "generic-public-test-fixture",
  });

  assert.ok(repository.supabase, "o cliente Supabase deve ser criado com Service Role");
});

test("não usa SUPABASE_KEY quando SUPABASE_SERVICE_ROLE_KEY está ausente", async () => {
  const repository = await loadRepositoryWithEnv({
    url: "https://example.supabase.co",
    genericKey: "generic-public-test-fixture",
  });

  assert.equal(
    repository.supabase,
    null,
    "o cliente deve ficar indisponível em vez de usar a chave genérica",
  );
});

test("mantém o cliente indisponível quando nenhuma credencial existe", async () => {
  const repository = await loadRepositoryWithEnv({
    url: "https://example.supabase.co",
  });

  assert.equal(repository.supabase, null);
});
