import { createPublicKey, timingSafeEqual, verify } from "node:crypto";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const DEFAULT_AUDIENCE = "cerberus-weekly-automation";
const EXPECTED_REPOSITORY = "kauabrennan5-bit/cerberus-forge-deploy";
const EXPECTED_REF = "refs/heads/main";
const ALLOWED_WORKFLOW_REFS = new Set([
  `${EXPECTED_REPOSITORY}/.github/workflows/cerberus-watchdog.yml@${EXPECTED_REF}`,
  `${EXPECTED_REPOSITORY}/.github/workflows/weekly-production-audience-sync.yml@${EXPECTED_REF}`,
  `${EXPECTED_REPOSITORY}/.github/workflows/autonomous-curator.yml@${EXPECTED_REF}`,
  `${EXPECTED_REPOSITORY}/.github/workflows/openai-provider-canary.yml@${EXPECTED_REF}`,
  `${EXPECTED_REPOSITORY}/.github/workflows/operator-health.yml@${EXPECTED_REF}`,
  `${EXPECTED_REPOSITORY}/.github/workflows/daily-production-invariant.yml@${EXPECTED_REF}`,
  `${EXPECTED_REPOSITORY}/.github/workflows/production-smoke-test.yml@${EXPECTED_REF}`,
]);
const ALLOWED_EVENTS = new Set(["schedule", "workflow_dispatch", "push"]);

type HeaderSource = Record<string, string | string[] | undefined>;

type GithubOidcHeader = {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
};

type GithubOidcClaims = {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  iat?: unknown;
  repository?: unknown;
  ref?: unknown;
  workflow_ref?: unknown;
  event_name?: unknown;
};

export type WeeklyAutomationAuthResult =
  | { authorized: true; method: "legacy_token" | "github_oidc" }
  | { authorized: false; method: "none" };

export async function authorizeWeeklyAutomationRequest(input: {
  headers: HeaderSource;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<WeeklyAutomationAuthResult> {
  const env = input.env || process.env;
  const expectedLegacy = (env.CERBERUS_AUTOMATION_TOKEN || "").trim();
  const providedLegacy = firstHeader(input.headers["x-cerberus-automation-token"]).trim();
  if (expectedLegacy && constantTimeEqual(providedLegacy, expectedLegacy)) {
    return { authorized: true, method: "legacy_token" };
  }

  const authorization = firstHeader(input.headers.authorization).trim();
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  if (!match) return { authorized: false, method: "none" };

  try {
    const valid = await verifyGithubOidcToken(match[1], {
      audience: (env.CERBERUS_GITHUB_OIDC_AUDIENCE || DEFAULT_AUDIENCE).trim() || DEFAULT_AUDIENCE,
      fetchImpl: input.fetchImpl || fetch,
      nowMs: input.nowMs ?? Date.now(),
    });
    return valid
      ? { authorized: true, method: "github_oidc" }
      : { authorized: false, method: "none" };
  } catch {
    return { authorized: false, method: "none" };
  }
}

export async function verifyGithubOidcToken(
  token: string,
  options: { audience: string; fetchImpl: typeof fetch; nowMs: number },
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !part)) return false;

  const header = decodeJson<GithubOidcHeader>(parts[0]);
  const claims = decodeJson<GithubOidcClaims>(parts[1]);
  if (!header || !claims) return false;
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid.trim()) return false;
  if (header.typ !== undefined && header.typ !== "JWT") return false;

  if (claims.iss !== GITHUB_OIDC_ISSUER) return false;
  if (!audienceIncludes(claims.aud, options.audience)) return false;
  if (claims.repository !== EXPECTED_REPOSITORY) return false;
  if (claims.ref !== EXPECTED_REF) return false;
  if (typeof claims.workflow_ref !== "string" || !ALLOWED_WORKFLOW_REFS.has(claims.workflow_ref)) return false;
  if (typeof claims.event_name !== "string" || !ALLOWED_EVENTS.has(claims.event_name)) return false;

  const nowSeconds = Math.floor(options.nowMs / 1000);
  const exp = numericClaim(claims.exp);
  const nbf = numericClaim(claims.nbf);
  const iat = numericClaim(claims.iat);
  if (exp === null || iat === null) return false;
  if (exp < nowSeconds - 30 || exp > nowSeconds + 900) return false;
  if (nbf !== null && nbf > nowSeconds + 30) return false;
  if (iat > nowSeconds + 30 || iat < nowSeconds - 900) return false;

  const jwksResponse = await options.fetchImpl(GITHUB_OIDC_JWKS, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!jwksResponse.ok) return false;
  const jwks = await jwksResponse.json() as { keys?: Array<Record<string, unknown>> };
  const jwk = Array.isArray(jwks.keys)
    ? jwks.keys.find(candidate => candidate.kid === header.kid && candidate.kty === "RSA")
    : undefined;
  if (!jwk) return false;

  let publicKey;
  try {
    publicKey = createPublicKey({ key: jwk as any, format: "jwk" });
  } catch {
    return false;
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(parts[2], "base64url");
  } catch {
    return false;
  }
  if (signature.length === 0) return false;
  return verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    publicKey,
    signature,
  );
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function decodeJson<T>(part: string): T | null {
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
  } catch {
    return null;
  }
}

function audienceIncludes(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some(candidate => candidate === expected);
}

function numericClaim(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
