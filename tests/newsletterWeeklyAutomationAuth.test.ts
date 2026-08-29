import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { authorizeWeeklyAutomationRequest } from "../server/services/newsletterWeeklyAutomationAuth";

const NOW_MS = Date.UTC(2026, 7, 29, 23, 30, 0);
const NOW = Math.floor(NOW_MS / 1000);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
const kid = "cerberus-test-kid";

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jwt(overrides: Record<string, unknown> = {}): string {
  const header = b64({ alg: "RS256", typ: "JWT", kid });
  const payload = b64({
    iss: "https://token.actions.githubusercontent.com",
    aud: "cerberus-weekly-automation",
    exp: NOW + 300,
    nbf: NOW - 10,
    iat: NOW - 10,
    repository: "kauabrennan5-bit/cerberus-forge-deploy",
    ref: "refs/heads/main",
    workflow_ref: "kauabrennan5-bit/cerberus-forge-deploy/.github/workflows/weekly-production-audience-sync.yml@refs/heads/main",
    event_name: "schedule",
    ...overrides,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

const jwksFetch = (async () => new Response(JSON.stringify({
  keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }],
}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

test("legacy automation token permanece compatível e não depende de OIDC", async () => {
  let fetchCalls = 0;
  const result = await authorizeWeeklyAutomationRequest({
    headers: { "x-cerberus-automation-token": "legacy-secret" },
    env: { CERBERUS_AUTOMATION_TOKEN: "legacy-secret" },
    fetchImpl: (async () => { fetchCalls += 1; throw new Error("unexpected"); }) as typeof fetch,
    nowMs: NOW_MS,
  });
  assert.deepEqual(result, { authorized: true, method: "legacy_token" });
  assert.equal(fetchCalls, 0);
});

test("GitHub OIDC válido autoriza somente workflow main permitido", async () => {
  const result = await authorizeWeeklyAutomationRequest({
    headers: { authorization: `Bearer ${jwt()}` },
    env: {},
    fetchImpl: jwksFetch,
    nowMs: NOW_MS,
  });
  assert.deepEqual(result, { authorized: true, method: "github_oidc" });
});

test("GitHub OIDC rejeita branch, workflow, audience e assinatura inválidos", async () => {
  for (const token of [
    jwt({ ref: "refs/heads/feature" }),
    jwt({ workflow_ref: "kauabrennan5-bit/cerberus-forge-deploy/.github/workflows/unknown.yml@refs/heads/main" }),
    jwt({ aud: "wrong-audience" }),
    `${jwt().slice(0, -2)}xx`,
  ]) {
    const result = await authorizeWeeklyAutomationRequest({
      headers: { authorization: `Bearer ${token}` },
      env: {},
      fetchImpl: jwksFetch,
      nowMs: NOW_MS,
    });
    assert.deepEqual(result, { authorized: false, method: "none" });
  }
});

test("GitHub OIDC aceita watchdog agendado e rejeita token expirado", async () => {
  const watchdog = await authorizeWeeklyAutomationRequest({
    headers: { authorization: `Bearer ${jwt({
      workflow_ref: "kauabrennan5-bit/cerberus-forge-deploy/.github/workflows/cerberus-watchdog.yml@refs/heads/main",
      event_name: "workflow_dispatch",
    })}` },
    env: {},
    fetchImpl: jwksFetch,
    nowMs: NOW_MS,
  });
  assert.equal(watchdog.authorized, true);

  const expired = await authorizeWeeklyAutomationRequest({
    headers: { authorization: `Bearer ${jwt({ exp: NOW - 60, iat: NOW - 600 })}` },
    env: {},
    fetchImpl: jwksFetch,
    nowMs: NOW_MS,
  });
  assert.equal(expired.authorized, false);
});
