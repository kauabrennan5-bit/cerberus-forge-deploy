import { isValidNewsletterEmail, normalizeNewsletterEmail } from "./newsletterConsent";

const DEFAULT_BASE_URL = "https://api.brevo.com/v3";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_TEST_LIST_NAME = "Cerberus Weekly Test";
const DEFAULT_FOLDER_NAME = "Cerberus";

export type WeeklyBrevoTestRecipientSetupResult = {
  provider: "BREVO";
  state: "ready";
  contactCreated: boolean;
  listCreated: boolean;
  listId: number;
  associated: true;
  blacklisted: false;
};

export class WeeklyBrevoTestRecipientSetupError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WeeklyBrevoTestRecipientSetupError";
  }
}

export type WeeklyBrevoTestRecipientSetupOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  listName?: string;
  folderName?: string;
};

type BrevoContact = {
  emailBlacklisted?: boolean;
  listIds?: number[];
};

type BrevoList = {
  id?: number;
  name?: string;
  folderId?: number;
};

type BrevoFolder = {
  id?: number;
  name?: string;
};

/**
 * Prepara exclusivamente o NEWSLETTER_TEST_EMAIL para /sendTest.
 * Não consulta subscribers do Cerberus, não cria recipients de campanha e
 * nunca chama /emailCampaigns ou /sendNow.
 */
export async function ensureWeeklyBrevoTestRecipient(
  options: WeeklyBrevoTestRecipientSetupOptions = {},
): Promise<WeeklyBrevoTestRecipientSetupResult> {
  const env = options.env || process.env;
  if (env.NEWSLETTER_WEEKLY_ENABLED === "true") {
    throw new WeeklyBrevoTestRecipientSetupError(
      "WEEKLY_TEST_RECIPIENT_SETUP_PRODUCTION_ENABLED",
      "A preparação do destinatário de teste exige produção semanal desabilitada.",
    );
  }

  const apiKey = (env.BREVO_API_KEY || "").trim();
  const testEmail = normalizeNewsletterEmail(env.NEWSLETTER_TEST_EMAIL);
  if (!apiKey || !testEmail || !isValidNewsletterEmail(testEmail)) {
    throw new WeeklyBrevoTestRecipientSetupError(
      "WEEKLY_TEST_RECIPIENT_SETUP_CONFIG_MISSING",
      "BREVO_API_KEY e NEWSLETTER_TEST_EMAIL válido são obrigatórios.",
    );
  }

  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const listName = (options.listName || env.BREVO_WEEKLY_TEST_LIST_NAME || DEFAULT_TEST_LIST_NAME).replace(/\s+/g, " ").trim();
  const folderName = (options.folderName || DEFAULT_FOLDER_NAME).replace(/\s+/g, " ").trim();

  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      if (text.trim()) {
        try {
          const value = JSON.parse(text);
          if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch {
          if (response.ok) {
            throw new WeeklyBrevoTestRecipientSetupError(
              "WEEKLY_TEST_RECIPIENT_SETUP_INVALID_RESPONSE",
              "Brevo retornou resposta inválida durante a preparação do contato de teste.",
            );
          }
        }
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof WeeklyBrevoTestRecipientSetupError) throw error;
      if (error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") {
        throw new WeeklyBrevoTestRecipientSetupError(
          "WEEKLY_TEST_RECIPIENT_SETUP_TIMEOUT",
          "Timeout ao preparar o contato de teste na Brevo.",
        );
      }
      throw new WeeklyBrevoTestRecipientSetupError(
        "WEEKLY_TEST_RECIPIENT_SETUP_NETWORK_ERROR",
        "Falha de rede ao preparar o contato de teste na Brevo.",
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  const contactPath = `/contacts/${encodeURIComponent(testEmail)}`;
  const initialContactResponse = await request("GET", contactPath);
  if (initialContactResponse.status !== 200 && initialContactResponse.status !== 404) {
    throw httpSetupError("CONTACT_LOOKUP", initialContactResponse.status);
  }
  const initialContact = initialContactResponse.status === 200
    ? initialContactResponse.body as BrevoContact
    : null;
  if (initialContact?.emailBlacklisted === true) {
    throw new WeeklyBrevoTestRecipientSetupError(
      "WEEKLY_BREVO_TEST_RECIPIENT_BLACKLISTED",
      "O destinatário de teste está bloqueado na Brevo e não será desbloqueado automaticamente.",
    );
  }

  const listsResponse = await request("GET", "/contacts/lists?limit=50&offset=0&sort=desc");
  if (listsResponse.status !== 200) throw httpSetupError("LIST_LOOKUP", listsResponse.status);
  const lists = Array.isArray(listsResponse.body.lists) ? listsResponse.body.lists as BrevoList[] : [];
  let listId = positiveId(lists.find(item => item.name === listName)?.id);
  let listCreated = false;

  if (!listId) {
    const foldersResponse = await request("GET", "/contacts/folders?limit=50&offset=0&sort=desc");
    if (foldersResponse.status !== 200) throw httpSetupError("FOLDER_LOOKUP", foldersResponse.status);
    const folders = Array.isArray(foldersResponse.body.folders) ? foldersResponse.body.folders as BrevoFolder[] : [];
    let folderId = positiveId(folders.find(item => item.name === folderName)?.id) || positiveId(folders[0]?.id);
    if (!folderId) {
      const createdFolder = await request("POST", "/contacts/folders", { name: folderName });
      if (createdFolder.status !== 201) throw httpSetupError("FOLDER_CREATE", createdFolder.status);
      folderId = positiveId(createdFolder.body.id);
      if (!folderId) {
        throw new WeeklyBrevoTestRecipientSetupError(
          "WEEKLY_TEST_RECIPIENT_SETUP_FOLDER_ID_MISSING",
          "Brevo não retornou a referência da pasta criada.",
        );
      }
    }
    const createdList = await request("POST", "/contacts/lists", { folderId, name: listName });
    if (createdList.status !== 201) throw httpSetupError("LIST_CREATE", createdList.status);
    listId = positiveId(createdList.body.id);
    if (!listId) {
      throw new WeeklyBrevoTestRecipientSetupError(
        "WEEKLY_TEST_RECIPIENT_SETUP_LIST_ID_MISSING",
        "Brevo não retornou a referência da lista de teste criada.",
      );
    }
    listCreated = true;
  }

  let contactCreated = false;
  if (!initialContact) {
    const createdContact = await request("POST", "/contacts", {
      email: testEmail,
      listIds: [listId],
      emailBlacklisted: false,
    });
    if (createdContact.status !== 201) throw httpSetupError("CONTACT_CREATE", createdContact.status);
    contactCreated = true;
  } else if (!normalizeIds(initialContact.listIds).includes(listId)) {
    const associated = await request("POST", `/contacts/lists/${listId}/contacts/add`, { emails: [testEmail] });
    if (associated.status !== 201) throw httpSetupError("CONTACT_ASSOCIATE", associated.status);
  }

  const verifiedResponse = await request("GET", contactPath);
  if (verifiedResponse.status !== 200) throw httpSetupError("CONTACT_VERIFY", verifiedResponse.status);
  const verified = verifiedResponse.body as BrevoContact;
  if (verified.emailBlacklisted === true) {
    throw new WeeklyBrevoTestRecipientSetupError(
      "WEEKLY_BREVO_TEST_RECIPIENT_BLACKLISTED",
      "O destinatário de teste está bloqueado na Brevo e não será desbloqueado automaticamente.",
    );
  }
  if (!normalizeIds(verified.listIds).includes(listId)) {
    throw new WeeklyBrevoTestRecipientSetupError(
      "WEEKLY_BREVO_TEST_RECIPIENT_LIST_NOT_CONFIRMED",
      "A associação do destinatário de teste à lista Brevo não pôde ser confirmada.",
    );
  }

  return {
    provider: "BREVO",
    state: "ready",
    contactCreated,
    listCreated,
    listId,
    associated: true,
    blacklisted: false,
  };
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values.map(positiveId).filter((value): value is number => value !== null);
}

function httpSetupError(operation: string, status: number): WeeklyBrevoTestRecipientSetupError {
  const normalizedStatus = Number.isSafeInteger(status) ? status : 0;
  return new WeeklyBrevoTestRecipientSetupError(
    `WEEKLY_TEST_RECIPIENT_SETUP_${operation}_HTTP_${normalizedStatus}`,
    `Brevo rejeitou a operação ${operation} durante a preparação do contato de teste.`,
  );
}
