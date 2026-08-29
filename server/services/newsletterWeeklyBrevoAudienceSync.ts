import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabase } from "../repositories/productsRepository";
import {
  buildSuppressionUpdate,
  isMarketingEligible,
  isValidNewsletterEmail,
  normalizeNewsletterEmail,
  type NewsletterStatus,
} from "./newsletterConsent";
import {
  recordWeeklyProductionSyncFailed,
  recordWeeklyProductionSyncReady,
} from "./newsletterWeeklyProductionConfig";

const DEFAULT_BASE_URL = "https://api.brevo.com/v3";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_LIST_NAME = "Cerberus Newsletter";
const DEFAULT_FOLDER_NAME = "Cerberus";
const PAGE_SIZE = 500;

export type WeeklyBrevoAudienceSyncResult = {
  provider: "BREVO";
  state: "ready";
  listId: number;
  listCreated: boolean;
  localSubscribers: number;
  eligibleSubscribers: number;
  brevoMembers: number;
  contactsCreated: number;
  contactsAssociated: number;
  contactsRemoved: number;
  locallyUnsubscribedFromBrevo: number;
  locallySuppressedFromBrevo: number;
};

export class WeeklyBrevoAudienceSyncError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WeeklyBrevoAudienceSyncError";
  }
}

type LocalSubscriber = {
  email: string;
  status: NewsletterStatus;
  marketingConsent: boolean;
};

type BrevoContact = {
  email?: string;
  emailBlacklisted?: boolean;
  listIds?: number[];
  listUnsubscribed?: number[];
};

type BrevoList = { id?: number; name?: string; folderId?: number };
type BrevoFolder = { id?: number; name?: string };

type AudienceSyncDeps = {
  loadLocalSubscribers: () => Promise<LocalSubscriber[]>;
  markLocalUnsubscribed: (email: string) => Promise<void>;
  markLocalSuppressed: (email: string) => Promise<void>;
  recordReady: (result: { listId: number; eligibleSubscribersCount: number; brevoMembersCount: number }) => Promise<void>;
  recordFailed: () => Promise<void>;
};

export type WeeklyBrevoAudienceSyncOptions = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  listName?: string;
  folderName?: string;
  client?: SupabaseClient;
  deps?: Partial<AudienceSyncDeps>;
};

/**
 * Mantém a lista de produção Brevo como projeção estrita do consentimento local.
 * Nunca apaga contatos globalmente, nunca remove blacklist e nunca envia campanha.
 */
export async function syncWeeklyBrevoProductionAudience(
  options: WeeklyBrevoAudienceSyncOptions = {},
): Promise<WeeklyBrevoAudienceSyncResult> {
  const env = options.env || process.env;
  const apiKey = (env.BREVO_API_KEY || "").trim();
  if (!apiKey) throw new WeeklyBrevoAudienceSyncError("WEEKLY_AUDIENCE_BREVO_API_KEY_MISSING", "Brevo API key ausente.");

  const client = options.client || requireSupabase();
  const deps = buildDeps(client, options.deps);
  const fetchImpl = options.fetchImpl || fetch;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  const listName = normalizeName(options.listName || env.BREVO_NEWSLETTER_LIST_NAME || DEFAULT_LIST_NAME);
  const folderName = normalizeName(options.folderName || DEFAULT_FOLDER_NAME);

  const request = createRequest({ apiKey, baseUrl, timeoutMs, fetchImpl });
  try {
    const localInitial = await deps.loadLocalSubscribers();
    const list = await ensureProductionList(request, listName, folderName);
    const listId = list.listId;
    const initialMembers = await loadListContacts(request, listId);
    const memberByEmail = new Map<string, BrevoContact>();
    for (const contact of initialMembers) {
      const email = normalizeNewsletterEmail(contact.email);
      if (email) memberByEmail.set(email, contact);
    }
    const localByEmail = new Map(localInitial.map(row => [row.email, row]));

    const remove = new Set<string>();
    const addExisting = new Set<string>();
    let contactsCreated = 0;
    let locallyUnsubscribedFromBrevo = 0;
    let locallySuppressedFromBrevo = 0;

    for (const [email, member] of memberByEmail) {
      const local = localByEmail.get(email);
      if (!local || !isMarketingEligible({ status: local.status, marketing_consent: local.marketingConsent })) {
        remove.add(email);
        continue;
      }
      if (member.emailBlacklisted === true) {
        await deps.markLocalSuppressed(email);
        locallySuppressedFromBrevo += 1;
        remove.add(email);
        continue;
      }
      if (normalizeIds(member.listUnsubscribed).includes(listId)) {
        await deps.markLocalUnsubscribed(email);
        locallyUnsubscribedFromBrevo += 1;
        remove.add(email);
      }
    }

    for (const local of localInitial) {
      if (!isMarketingEligible({ status: local.status, marketing_consent: local.marketingConsent })) continue;
      if (remove.has(local.email) || memberByEmail.has(local.email)) continue;

      const lookup = await request("GET", `/contacts/${encodeURIComponent(local.email)}`);
      if (lookup.status === 404) {
        const created = await request("POST", "/contacts", {
          email: local.email,
          listIds: [listId],
        });
        if (created.status !== 201) throw httpError("CONTACT_CREATE", created.status);
        contactsCreated += 1;
        continue;
      }
      if (lookup.status !== 200) throw httpError("CONTACT_LOOKUP", lookup.status);
      const contact = lookup.body as BrevoContact;
      if (contact.emailBlacklisted === true) {
        await deps.markLocalSuppressed(local.email);
        locallySuppressedFromBrevo += 1;
        continue;
      }
      if (normalizeIds(contact.listUnsubscribed).includes(listId)) {
        await deps.markLocalUnsubscribed(local.email);
        locallyUnsubscribedFromBrevo += 1;
        continue;
      }
      if (!normalizeIds(contact.listIds).includes(listId)) addExisting.add(local.email);
    }

    let contactsAssociated = 0;
    for (const emails of chunk([...addExisting], 100)) {
      const added = await request("POST", `/contacts/lists/${listId}/contacts/add`, { emails });
      if (added.status !== 201) throw httpError("CONTACT_ASSOCIATE", added.status);
      contactsAssociated += emails.length;
    }

    let contactsRemoved = 0;
    for (const emails of chunk([...remove], 100)) {
      if (emails.length === 0) continue;
      const removed = await request("POST", `/contacts/lists/${listId}/contacts/remove`, { emails });
      if (removed.status !== 201) throw httpError("CONTACT_REMOVE", removed.status);
      contactsRemoved += emails.length;
    }

    const localFinal = await deps.loadLocalSubscribers();
    const expected = new Set(localFinal
      .filter(row => isMarketingEligible({ status: row.status, marketing_consent: row.marketingConsent }))
      .map(row => row.email));
    const finalContacts = await loadListContacts(request, listId);
    const actual = new Set(finalContacts
      .map(contact => normalizeNewsletterEmail(contact.email))
      .filter(Boolean));

    if (!sameSet(expected, actual)) {
      throw new WeeklyBrevoAudienceSyncError(
        "WEEKLY_AUDIENCE_FINAL_MEMBERSHIP_MISMATCH",
        "A lista Brevo não corresponde exatamente aos assinantes elegíveis locais.",
      );
    }

    await deps.recordReady({
      listId,
      eligibleSubscribersCount: expected.size,
      brevoMembersCount: actual.size,
    });

    return {
      provider: "BREVO",
      state: "ready",
      listId,
      listCreated: list.listCreated,
      localSubscribers: localFinal.length,
      eligibleSubscribers: expected.size,
      brevoMembers: actual.size,
      contactsCreated,
      contactsAssociated,
      contactsRemoved,
      locallyUnsubscribedFromBrevo,
      locallySuppressedFromBrevo,
    };
  } catch (error) {
    try { await deps.recordFailed(); } catch { /* original failure remains authoritative */ }
    if (error instanceof WeeklyBrevoAudienceSyncError) throw error;
    throw new WeeklyBrevoAudienceSyncError("WEEKLY_AUDIENCE_SYNC_FAILED", "Falha ao reconciliar a lista de produção Brevo.");
  }
}

function buildDeps(client: SupabaseClient, overrides: Partial<AudienceSyncDeps> = {}): AudienceSyncDeps {
  return {
    loadLocalSubscribers: overrides.loadLocalSubscribers || (() => loadLocalSubscribers(client)),
    markLocalUnsubscribed: overrides.markLocalUnsubscribed || (email => markLocalUnsubscribed(client, email)),
    markLocalSuppressed: overrides.markLocalSuppressed || (email => markLocalSuppressed(client, email)),
    recordReady: overrides.recordReady || (result => recordWeeklyProductionSyncReady({ ...result, client })),
    recordFailed: overrides.recordFailed || (() => recordWeeklyProductionSyncFailed({ client })),
  };
}

async function loadLocalSubscribers(client: SupabaseClient): Promise<LocalSubscriber[]> {
  const rows: LocalSubscriber[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("newsletter_subscribers")
      .select("email,status,marketing_consent")
      .order("email", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data || []) {
      const email = normalizeNewsletterEmail(row.email);
      if (!isValidNewsletterEmail(email)) continue;
      const status = String(row.status || "suppressed") as NewsletterStatus;
      rows.push({ email, status, marketingConsent: row.marketing_consent === true });
    }
    if ((data || []).length < pageSize) break;
  }
  return rows;
}

async function markLocalUnsubscribed(client: SupabaseClient, email: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await client
    .from("newsletter_subscribers")
    .update({
      status: "unsubscribed",
      unsubscribe_at: now,
      unsubscribe_source: "brevo_native_unsubscribe",
      unsubscribe_token_hash: null,
      unsubscribe_token_expires_at: null,
      updated_at: now,
    })
    .eq("email", email)
    .eq("status", "subscribed");
  if (error) throw error;
}

async function markLocalSuppressed(client: SupabaseClient, email: string): Promise<void> {
  const { error } = await client
    .from("newsletter_subscribers")
    .update(buildSuppressionUpdate("brevo_email_blacklisted"))
    .eq("email", email)
    .eq("status", "subscribed");
  if (error) throw error;
}

function createRequest(input: { apiKey: string; baseUrl: string; timeoutMs: number; fetchImpl: typeof fetch }) {
  return async (
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const response = await input.fetchImpl(`${input.baseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "api-key": input.apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      if (text.trim()) {
        try {
          const candidate = JSON.parse(text);
          if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
        } catch {
          if (response.ok) throw new WeeklyBrevoAudienceSyncError("WEEKLY_AUDIENCE_INVALID_RESPONSE", "Brevo retornou resposta inválida.");
        }
      }
      return { status: response.status, body: parsed };
    } catch (error) {
      if (error instanceof WeeklyBrevoAudienceSyncError) throw error;
      if (error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") {
        throw new WeeklyBrevoAudienceSyncError("WEEKLY_AUDIENCE_TIMEOUT", "Timeout durante reconciliação Brevo.");
      }
      throw new WeeklyBrevoAudienceSyncError("WEEKLY_AUDIENCE_NETWORK_ERROR", "Falha de rede durante reconciliação Brevo.");
    } finally {
      clearTimeout(timeout);
    }
  };
}

type Request = ReturnType<typeof createRequest>;

async function ensureProductionList(request: Request, listName: string, folderName: string): Promise<{ listId: number; listCreated: boolean }> {
  const listsResponse = await request("GET", "/contacts/lists?limit=50&offset=0&sort=desc");
  if (listsResponse.status !== 200) throw httpError("LIST_LOOKUP", listsResponse.status);
  const lists = Array.isArray(listsResponse.body.lists) ? listsResponse.body.lists as BrevoList[] : [];
  const existing = positiveId(lists.find(item => item.name === listName)?.id);
  if (existing) return { listId: existing, listCreated: false };

  const foldersResponse = await request("GET", "/contacts/folders?limit=50&offset=0&sort=desc");
  if (foldersResponse.status !== 200) throw httpError("FOLDER_LOOKUP", foldersResponse.status);
  const folders = Array.isArray(foldersResponse.body.folders) ? foldersResponse.body.folders as BrevoFolder[] : [];
  let folderId = positiveId(folders.find(item => item.name === folderName)?.id) || positiveId(folders[0]?.id);
  if (!folderId) {
    const createdFolder = await request("POST", "/contacts/folders", { name: folderName });
    if (createdFolder.status !== 201) throw httpError("FOLDER_CREATE", createdFolder.status);
    folderId = positiveId(createdFolder.body.id);
  }
  if (!folderId) throw new WeeklyBrevoAudienceSyncError("WEEKLY_AUDIENCE_FOLDER_ID_MISSING", "Brevo não confirmou a pasta de contatos.");

  const createdList = await request("POST", "/contacts/lists", { folderId, name: listName });
  if (createdList.status !== 201) throw httpError("LIST_CREATE", createdList.status);
  const listId = positiveId(createdList.body.id);
  if (!listId) throw new WeeklyBrevoAudienceSyncError("WEEKLY_AUDIENCE_LIST_ID_MISSING", "Brevo não confirmou a lista de produção.");
  return { listId, listCreated: true };
}

async function loadListContacts(request: Request, listId: number): Promise<BrevoContact[]> {
  const contacts: BrevoContact[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const response = await request("GET", `/contacts/lists/${listId}/contacts?limit=${PAGE_SIZE}&offset=${offset}&sort=asc`);
    if (response.status !== 200) throw httpError("LIST_CONTACTS_LOOKUP", response.status);
    const page = Array.isArray(response.body.contacts) ? response.body.contacts as BrevoContact[] : [];
    contacts.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return contacts;
}

function httpError(operation: string, status: number): WeeklyBrevoAudienceSyncError {
  const safeStatus = Number.isSafeInteger(status) ? status : 0;
  return new WeeklyBrevoAudienceSyncError(
    `WEEKLY_AUDIENCE_${operation}_HTTP_${safeStatus}`,
    `Brevo rejeitou a operação ${operation}.`,
  );
}

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(positiveId).filter((item): item is number => item !== null);
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120) || DEFAULT_LIST_NAME;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
