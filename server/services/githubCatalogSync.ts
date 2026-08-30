import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
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
const PRODUCTION_BRANCH = "main";
const REQUIRED_CHECK = "weekly-production-final";
const DEFAULT_CHECK_TIMEOUT_MS = 25 * 60 * 1000;
const CHECK_POLL_INTERVAL_MS = 5_000;

export interface GitHubCatalogSyncResult {
  success: boolean;
  operationId: string;
  commitSha?: string;
  contentSha?: string;
  diagnostic?: OperationalDiagnostic;
}

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
      : "O GitHub não confirmou a gravação versionada e protegida de products.json.",
    likelyCause: isAuthFailure
      ? "Token ausente, expirado, inválido ou sem permissão Contents/Pull requests no repositório Cerberus."
      : "Falha ao criar a branch/PR de catálogo, check obrigatório não aprovado, main avançou durante a validação, conflito de merge ou erro da API do GitHub.",
    impact: "A projeção pública não pode ser considerada publicada no commit atual.",
    recoverability: "ADMIN_APPROVAL",
    retryable: !isAuthFailure,
    httpStatus,
    cause: error,
  });
}

function normalizeCheckTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CHECK_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(parsed), 60_000), 30 * 60 * 1000);
}

function catalogBranchName(operationId: string): string {
  const safeOperation = operationId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "sync";
  return `catalog-sync/${safeOperation}-${randomUUID().slice(0, 8)}`;
}

async function waitForRequiredCheck(octokit: Octokit, headSha: string): Promise<void> {
  const timeoutMs = normalizeCheckTimeoutMs(process.env.GITHUB_CATALOG_PR_CHECK_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { data } = await octokit.rest.checks.listForRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: headSha,
      check_name: REQUIRED_CHECK,
      per_page: 100,
    });
    const matching = data.check_runs.filter(run => run.name === REQUIRED_CHECK);
    if (matching.some(run => run.status === "completed" && run.conclusion === "success")) return;

    const terminalFailure = matching.find(run => run.status === "completed" && run.conclusion && run.conclusion !== "success");
    if (terminalFailure) {
      throw new Error(`GITHUB_REQUIRED_CHECK_FAILED:${REQUIRED_CHECK}:${terminalFailure.conclusion}`);
    }

    await new Promise(resolve => setTimeout(resolve, CHECK_POLL_INTERVAL_MS));
  }

  throw new Error(`GITHUB_REQUIRED_CHECK_TIMEOUT:${REQUIRED_CHECK}`);
}

async function bestEffortClosePullRequest(octokit: Octokit, pullNumber: number | undefined): Promise<void> {
  if (!pullNumber) return;
  try {
    await octokit.rest.pulls.update({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number: pullNumber,
      state: "closed",
    });
  } catch (error) {
    console.warn(`[GitHub Sync] cleanup=close_pr reason=${sanitizeOperationalText(error)}`);
  }
}

async function bestEffortDeleteBranch(octokit: Octokit, branch: string | undefined): Promise<void> {
  if (!branch) return;
  try {
    await octokit.rest.git.deleteRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${branch}`,
    });
  } catch (error) {
    const candidate = error as { status?: number };
    if (candidate?.status !== 404) {
      console.warn(`[GitHub Sync] cleanup=delete_branch reason=${sanitizeOperationalText(error)}`);
    }
  }
}

/**
 * Sincroniza a projeção local já gerada respeitando a proteção de main:
 * branch efêmera -> PR -> weekly-production-final -> merge com SHA esperado.
 * O retorno contém o SHA promovido; falhas fecham o fluxo sem bypass de proteção.
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
        impact: "Nenhuma promoção protegida do catálogo pode ser criada no GitHub/main.",
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

  const octokit = new Octokit({ auth: token });
  let branchName: string | undefined;
  let pullNumber: number | undefined;
  let merged = false;

  try {
    const content = fs.readFileSync(localPath, "utf-8");
    const contentEncoded = Buffer.from(content).toString("base64");

    const baseRef = await octokit.rest.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${PRODUCTION_BRANCH}`,
    });
    const baseSha = baseRef.data.object.sha;

    let existingContentSha: string | undefined;
    let existingContent: string | undefined;
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: FILE_PATH,
        ref: PRODUCTION_BRANCH,
      });
      if (!Array.isArray(data) && data.type === "file") {
        existingContentSha = data.sha;
        if (typeof data.content === "string" && data.encoding === "base64") {
          existingContent = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
        }
      }
    } catch (error: any) {
      if (error?.status !== 404) throw error;
    }

    if (existingContent === content) {
      console.info(`[GitHub Sync] operation=${operationId} unchanged=true commit=${baseSha.slice(0, 7)} file=${FILE_PATH}`);
      return {
        success: true,
        operationId,
        commitSha: baseSha,
        contentSha: existingContentSha,
      };
    }

    branchName = catalogBranchName(operationId);
    await octokit.rest.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    });

    const writeResponse = await octokit.rest.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      message: `${message} [bot]`,
      content: contentEncoded,
      sha: existingContentSha,
      branch: branchName,
    });
    const headSha = writeResponse.data.commit.sha;
    if (!headSha) throw new Error("GITHUB_CATALOG_BRANCH_COMMIT_MISSING");

    const pull = await octokit.rest.pulls.create({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      title: `${message} [bot]`,
      head: branchName,
      base: PRODUCTION_BRANCH,
      body: [
        "Automated catalog projection promotion.",
        "",
        `Operation: ${operationId}`,
        `Required check: ${REQUIRED_CHECK}`,
        "",
        "This PR is generated by the backend so the catalog respects main branch protection.",
      ].join("\n"),
      maintainer_can_modify: false,
    });
    pullNumber = pull.data.number;

    await waitForRequiredCheck(octokit, headSha);

    const currentBaseRef = await octokit.rest.git.getRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${PRODUCTION_BRANCH}`,
    });
    if (currentBaseRef.data.object.sha !== baseSha) {
      throw new Error(`GITHUB_STALE_BASE:${baseSha.slice(0, 12)}:${currentBaseRef.data.object.sha.slice(0, 12)}`);
    }

    const merge = await octokit.rest.pulls.merge({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number: pullNumber,
      merge_method: "squash",
      commit_title: `${message} [bot]`,
      commit_message: `Automated protected catalog promotion.\n\nOperation: ${operationId}`,
      sha: headSha,
    });
    if (!merge.data.merged || !merge.data.sha) {
      throw new Error(`GITHUB_CATALOG_PR_NOT_MERGED:${sanitizeOperationalText(merge.data.message || "merge rejected")}`);
    }
    merged = true;

    console.info(`[GitHub Sync] operation=${operationId} pr=${pullNumber} commit=${merge.data.sha.slice(0, 7)} file=${FILE_PATH}`);
    return {
      success: true,
      operationId,
      commitSha: merge.data.sha,
      contentSha: writeResponse.data.content?.sha,
    };
  } catch (error) {
    const diagnostic = githubDiagnostic(operationId, error);
    console.error(`[GitHub Sync] operation=${operationId} code=${diagnostic.code} cause=${sanitizeOperationalText(error)}`);
    if (!merged) await bestEffortClosePullRequest(octokit, pullNumber);
    return { success: false, operationId, diagnostic };
  } finally {
    await bestEffortDeleteBranch(octokit, branchName);
  }
}
