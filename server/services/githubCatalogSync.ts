import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import {
  createOperationId,
  createOperationalDiagnostic,
  sanitizeOperationalText,
  type OperationalDiagnostic,
} from "./operationalDiagnostics";

dotenv.config();

const REPO_OWNER = "kauabrennan5-bit";
const REPO_NAME = "cerberus-forge-deploy";
const FILE_PATH = "public/data/products.json";
const BASE_BRANCH = "main";
const CATALOG_BRANCH_PREFIX = "catalog-sync/";
const DEFAULT_PROMOTION_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_PROMOTION_POLL_MS = 10_000;

export interface GitHubCatalogSyncResult {
  success: boolean;
  operationId: string;
  commitSha?: string;
  contentSha?: string;
  diagnostic?: OperationalDiagnostic;
}

type ContentFile = {
  sha: string;
  content?: string;
  encoding?: string;
};

function githubDiagnostic(operationId: string, error: unknown): OperationalDiagnostic {
  const candidate = error as { status?: number; message?: string };
  const httpStatus = candidate?.status;
  const isAuthFailure = httpStatus === 401 || httpStatus === 403 || /bad credentials|authentication|credential/i.test(candidate?.message || "");
  return createOperationalDiagnostic({
    operationId,
    operation: "CATALOG_SYNC",
    stage: isAuthFailure ? "GITHUB_AUTH" : "GITHUB_WRITE",
    dependency: "GitHub",
    code: isAuthFailure ? "GITHUB_AUTH_ERROR" : "GITHUB_SYNC_ERROR",
    message: isAuthFailure
      ? "A autenticação do GitHub recusou a sincronização do catálogo."
      : "O GitHub não confirmou a promoção protegida de products.json.",
    likelyCause: isAuthFailure
      ? "Token ausente, expirado, inválido ou sem permissão Contents para gravar a branch de catálogo no repositório Cerberus."
      : "Falha de rede, conflito com main, gate weekly-production-final não concluído, branch indisponível ou erro da API do GitHub.",
    impact: "A projeção pública não pode ser considerada publicada no commit atual.",
    recoverability: "ADMIN_APPROVAL",
    retryable: !isAuthFailure,
    httpStatus,
    cause: error,
  });
}

function positiveMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw || ""), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function catalogBranchName(content: string): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 20);
  return `${CATALOG_BRANCH_PREFIX}${digest}`;
}

function decodeGitHubContent(data: unknown): string | null {
  if (!data || Array.isArray(data) || typeof data !== "object") return null;
  const file = data as ContentFile;
  if (typeof file.content !== "string") return null;
  if (file.encoding === "base64") return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8");
  return file.content;
}

async function getBranchSha(octokit: Octokit, branch: string): Promise<string | null> {
  try {
    const { data } = await octokit.git.getRef({ owner: REPO_OWNER, repo: REPO_NAME, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function ensureCatalogBranch(octokit: Octokit, branch: string, baseSha: string): Promise<void> {
  const existingSha = await getBranchSha(octokit, branch);
  if (existingSha) {
    await octokit.git.deleteRef({ owner: REPO_OWNER, repo: REPO_NAME, ref: `heads/${branch}` });
  }
  await octokit.git.createRef({ owner: REPO_OWNER, repo: REPO_NAME, ref: `refs/heads/${branch}`, sha: baseSha });
}

async function updateCatalogBranch(octokit: Octokit, branch: string, content: string, message: string): Promise<{ contentSha?: string }> {
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      ref: branch,
    });
    if (!Array.isArray(data)) {
      sha = data.sha;
      const existing = decodeGitHubContent(data);
      if (existing === content) return { contentSha: data.sha };
    }
  } catch (error: any) {
    if (error?.status !== 404) throw error;
  }

  const response = await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: FILE_PATH,
    message: `${message} [bot]`,
    content: Buffer.from(content).toString("base64"),
    sha,
    branch,
  });
  return { contentSha: response.data.content?.sha };
}

async function waitForProtectedPromotion(
  octokit: Octokit,
  content: string,
): Promise<{ commitSha: string; contentSha?: string }> {
  const timeoutMs = positiveMs(
    process.env.GITHUB_CATALOG_PROMOTION_TIMEOUT_MS || process.env.GITHUB_CATALOG_PR_TIMEOUT_MS,
    DEFAULT_PROMOTION_TIMEOUT_MS,
    60_000,
    35 * 60_000,
  );
  const pollMs = positiveMs(
    process.env.GITHUB_CATALOG_PROMOTION_POLL_MS || process.env.GITHUB_CATALOG_PR_POLL_MS,
    DEFAULT_PROMOTION_POLL_MS,
    3_000,
    30_000,
  );
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const commitSha = await getBranchSha(octokit, BASE_BRANCH);
    if (!commitSha) throw new Error("GITHUB_MAIN_REF_MISSING");

    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      ref: BASE_BRANCH,
    });
    if (!Array.isArray(data) && decodeGitHubContent(data) === content) {
      return { commitSha, contentSha: data.sha };
    }
    await sleep(pollMs);
  }

  throw new Error("CATALOG_PROTECTED_PROMOTION_TIMEOUT");
}

/**
 * Sincroniza a projeção local usando uma branch de catálogo content-addressed.
 * O backend nunca escreve diretamente em `main` e não precisa de permissão de
 * Pull Requests: a branch dispara o gate `weekly-production-final`, e o próprio
 * GitHub Actions promove exatamente o SHA validado para `main` apenas se a
 * proteção aceitar o fast-forward. O retorno só é sucesso quando `main` contém
 * exatamente o conteúdo exportado.
 */
export async function syncCatalogToGitHub(
  message = "update: catalog products.json",
  options: { operationId?: string } = {},
): Promise<GitHubCatalogSyncResult> {
  const operationId = options.operationId || createOperationId("SYNC");
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return {
      success: false,
      operationId,
      diagnostic: createOperationalDiagnostic({
        operationId,
        operation: "CATALOG_SYNC",
        stage: "GITHUB_AUTH",
        dependency: "GitHub",
        code: "GITHUB_AUTH_ERROR",
        message: "GITHUB_TOKEN não está configurado no processo do backend.",
        likelyCause: "A credencial de sincronização não foi configurada ou não foi carregada após reinício.",
        impact: "Nenhuma branch protegida de catálogo pode ser criada no GitHub.",
        recoverability: "ADMIN_APPROVAL",
        retryable: false,
      }),
    };
  }

  const localPath = path.join(process.cwd(), "public", "data", "products.json");
  if (!fs.existsSync(localPath)) {
    return {
      success: false,
      operationId,
      diagnostic: createOperationalDiagnostic({
        operationId,
        operation: "CATALOG_SYNC",
        stage: "CATALOG_EXPORT",
        dependency: "Exportador",
        code: "CATALOG_GENERATION_ERROR",
        message: "products.json não foi encontrado após a exportação local.",
        likelyCause: "A geração do catálogo não produziu o artefato esperado em public/data/products.json.",
        impact: "Não existe projeção local versionável para o Static Site.",
        recoverability: "AUTO",
        retryable: true,
      }),
    };
  }

  try {
    const octokit = new Octokit({ auth: token });
    const content = fs.readFileSync(localPath, "utf-8");
    const baseSha = await getBranchSha(octokit, BASE_BRANCH);
    if (!baseSha) throw new Error("GITHUB_MAIN_REF_MISSING");

    const { data: mainData } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      ref: BASE_BRANCH,
    });
    if (!Array.isArray(mainData) && decodeGitHubContent(mainData) === content) {
      console.info(`[GitHub Sync] operation=${operationId} noop main=${baseSha.slice(0, 7)} file=${FILE_PATH}`);
      return { success: true, operationId, commitSha: baseSha, contentSha: mainData.sha };
    }

    const branch = catalogBranchName(content);
    await ensureCatalogBranch(octokit, branch, baseSha);
    const updated = await updateCatalogBranch(octokit, branch, content, message);
    const promoted = await waitForProtectedPromotion(octokit, content);

    try {
      await octokit.git.deleteRef({ owner: REPO_OWNER, repo: REPO_NAME, ref: `heads/${branch}` });
    } catch (cleanupError) {
      console.warn(`[GitHub Sync] operation=${operationId} branch_cleanup_failed reason=${sanitizeOperationalText(cleanupError)}`);
    }

    console.info(`[GitHub Sync] operation=${operationId} protected_promotion=${promoted.commitSha.slice(0, 7)} file=${FILE_PATH}`);
    return {
      success: true,
      operationId,
      commitSha: promoted.commitSha,
      contentSha: promoted.contentSha || updated.contentSha,
    };
  } catch (error) {
    const diagnostic = githubDiagnostic(operationId, error);
    console.error(`[GitHub Sync] operation=${operationId} code=${diagnostic.code} cause=${sanitizeOperationalText(error)}`);
    return { success: false, operationId, diagnostic };
  }
}

export const githubCatalogSyncInternals = {
  catalogBranchName,
  decodeGitHubContent,
};
