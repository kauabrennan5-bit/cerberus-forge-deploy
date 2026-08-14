import fs from "fs";
import path from "path";
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
      : "O GitHub não confirmou a gravação versionada de products.json.",
    likelyCause: isAuthFailure
      ? "Token ausente, expirado, inválido ou sem permissão Contents: Read and write no repositório Cerberus."
      : "Falha de rede, conflito de arquivo, branch indisponível ou erro da API do GitHub.",
    impact: "A projeção pública não pode ser considerada publicada no commit atual.",
    recoverability: "ADMIN_APPROVAL",
    retryable: !isAuthFailure,
    httpStatus,
    cause: error,
  });
}

/**
 * Sincroniza somente a projeção local já gerada para GitHub/main. O retorno contém
 * o SHA do commit criado/atualizado; nunca converte falha em sucesso booleano.
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
        impact: "Nenhum commit do catálogo pode ser criado no GitHub/main.",
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
    const contentEncoded = Buffer.from(content).toString("base64");
    let sha: string | undefined;

    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: FILE_PATH,
        ref: "main",
      });
      if (!Array.isArray(data)) sha = data.sha;
    } catch (error: any) {
      if (error?.status !== 404) throw error;
    }

    const response = await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      message: `${message} [bot]`,
      content: contentEncoded,
      sha,
      branch: "main",
    });

    const commitSha = response.data.commit.sha;
    console.info(`[GitHub Sync] operation=${operationId} commit=${commitSha.slice(0, 7)} file=${FILE_PATH}`);
    return {
      success: true,
      operationId,
      commitSha,
      contentSha: response.data.content?.sha,
    };
  } catch (error) {
    const diagnostic = githubDiagnostic(operationId, error);
    console.error(`[GitHub Sync] operation=${operationId} code=${diagnostic.code} cause=${sanitizeOperationalText(error)}`);
    return { success: false, operationId, diagnostic };
  }
}
