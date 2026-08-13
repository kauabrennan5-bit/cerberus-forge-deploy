import { Octokit } from "@octokit/rest";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";


dotenv.config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = "kauabrennan5-bit";
const REPO_NAME = "cerberus-forge-deploy";
const FILE_PATH = "public/data/products.json";

const octokit = new Octokit({ auth: GITHUB_TOKEN });

/**
 * Sincroniza o arquivo products.json local com o repositório GitHub
 * Isso dispara o rebuild automático do Static Site no Render
 */
export async function syncCatalogToGitHub(message: string = "update: catalog products.json"): Promise<boolean> {
  if (!GITHUB_TOKEN) {
    console.error("❌ [GitHub Sync] GITHUB_TOKEN não configurado.");
    return false;
  }

  try {
    // Sincroniza o arquivo público gerado pelo exportador estático (public/data/products.json)
    const localPath = path.join(process.cwd(), "public", "data", "products.json");

    if (!fs.existsSync(localPath)) {
      console.error("❌ [GitHub Sync] Impossível sincronizar: products.json não gerado.");
      return false;
    }

    const content = fs.readFileSync(localPath, "utf-8");
    const contentEncoded = Buffer.from(content).toString("base64");

    // 1. Obter o SHA do arquivo atual no GitHub (necessário para update)
    let sha: string | undefined;
    try {
      const { data } = await octokit.repos.getContent({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: FILE_PATH,
      });
      if (!Array.isArray(data)) {
        sha = data.sha;
      }
    } catch (err: any) {
      if (err.status !== 404) throw err;
      console.log("ℹ️ [GitHub Sync] Arquivo ainda não existe no repo, será criado.");
    }

    // 2. Criar ou atualizar o arquivo no repo
    console.log(`[GitHub Sync] Enviando commit para ${REPO_OWNER}/${REPO_NAME}...`);
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: FILE_PATH,
      message: `${message} [bot]`,
      content: contentEncoded,
      sha: sha,
      branch: "master"
    });

    console.log("✅ [GitHub Sync] Catálogo sincronizado com sucesso no GitHub!");
    return true;
  } catch (err: any) {
    console.error("❌ [GitHub Sync] Erro ao sincronizar com GitHub:", err.message);
    return false;
  }
}
