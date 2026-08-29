import test from "node:test";
import assert from "node:assert/strict";
import {
  syncWeeklyBrevoProductionAudience,
  WeeklyBrevoAudienceSyncError,
} from "../server/services/newsletterWeeklyBrevoAudienceSync";

type LocalRow = { email: string; status: "subscribed" | "unsubscribed" | "suppressed"; marketingConsent: boolean };
type Contact = { email: string; emailBlacklisted?: boolean; listIds?: number[]; listUnsubscribed?: number[] };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockBrevo(input: {
  listId?: number;
  listExists?: boolean;
  contacts?: Contact[];
  known?: Contact[];
  ignoreRemovals?: boolean;
}) {
  const listId = input.listId || 9;
  let listExists = input.listExists !== false;
  const members = new Map((input.contacts || []).map(contact => [contact.email, structuredClone(contact)]));
  const known = new Map((input.known || input.contacts || []).map(contact => [contact.email, structuredClone(contact)]));
  const calls: Array<{ method: string; path: string }> = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const path = `${parsed.pathname}${parsed.search}`;
    const method = String(init?.method || "GET").toUpperCase();
    calls.push({ method, path });

    if (method === "GET" && parsed.pathname === "/v3/contacts/lists") {
      return jsonResponse(200, { lists: listExists ? [{ id: listId, name: "Cerberus Newsletter", folderId: 3 }] : [] });
    }
    if (method === "GET" && parsed.pathname === "/v3/contacts/folders") {
      return jsonResponse(200, { folders: [{ id: 3, name: "Cerberus" }] });
    }
    if (method === "POST" && parsed.pathname === "/v3/contacts/lists") {
      listExists = true;
      return jsonResponse(201, { id: listId });
    }
    if (method === "GET" && parsed.pathname === `/v3/contacts/lists/${listId}/contacts`) {
      return jsonResponse(200, { contacts: [...members.values()], count: members.size });
    }
    if (method === "GET" && parsed.pathname.startsWith("/v3/contacts/")) {
      const email = decodeURIComponent(parsed.pathname.slice("/v3/contacts/".length));
      const contact = known.get(email);
      return contact ? jsonResponse(200, contact) : jsonResponse(404, { code: "document_not_found" });
    }
    if (method === "POST" && parsed.pathname === "/v3/contacts") {
      const body = JSON.parse(String(init?.body || "{}"));
      const contact: Contact = { email: body.email, emailBlacklisted: false, listIds: body.listIds || [] };
      known.set(contact.email, contact);
      if ((contact.listIds || []).includes(listId)) members.set(contact.email, contact);
      return jsonResponse(201, { id: known.size + 100 });
    }
    if (method === "POST" && parsed.pathname === `/v3/contacts/lists/${listId}/contacts/add`) {
      const body = JSON.parse(String(init?.body || "{}"));
      for (const email of body.emails || []) {
        const contact = known.get(email) || { email };
        contact.listIds = [...new Set([...(contact.listIds || []), listId])];
        known.set(email, contact);
        members.set(email, contact);
      }
      return jsonResponse(201, { success: body.emails || [], failure: [] });
    }
    if (method === "POST" && parsed.pathname === `/v3/contacts/lists/${listId}/contacts/remove`) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (!input.ignoreRemovals) for (const email of body.emails || []) members.delete(email);
      return jsonResponse(201, { success: body.emails || [], failure: [] });
    }
    return jsonResponse(500, { code: "unexpected_mock_route", method, path });
  }) as typeof fetch;

  return { fetchImpl, calls, members, known };
}

function localDeps(rows: LocalRow[]) {
  const state = new Map(rows.map(row => [row.email, structuredClone(row)]));
  const events: string[] = [];
  let ready: any = null;
  let failed = 0;
  return {
    deps: {
      loadLocalSubscribers: async () => [...state.values()].map(row => structuredClone(row)),
      markLocalUnsubscribed: async (email: string) => {
        events.push(`unsub:${email}`);
        const row = state.get(email);
        if (row) row.status = "unsubscribed";
      },
      markLocalSuppressed: async (email: string) => {
        events.push(`suppress:${email}`);
        const row = state.get(email);
        if (row) row.status = "suppressed";
      },
      recordReady: async (value: any) => { ready = value; },
      recordFailed: async () => { failed += 1; },
    },
    events,
    readReady: () => ready,
    readFailed: () => failed,
  };
}

const env = { BREVO_API_KEY: "unit-test-key" } as NodeJS.ProcessEnv;

test("production audience cria/reutiliza lista e projeta exatamente os elegíveis sem envio", async () => {
  const brevo = mockBrevo({
    listExists: true,
    contacts: [],
    known: [{ email: "b@example.com", listIds: [] }],
  });
  const local = localDeps([
    { email: "a@example.com", status: "subscribed", marketingConsent: true },
    { email: "b@example.com", status: "subscribed", marketingConsent: true },
  ]);

  const result = await syncWeeklyBrevoProductionAudience({
    env,
    fetchImpl: brevo.fetchImpl,
    baseUrl: "https://api.brevo.test/v3",
    client: {} as any,
    deps: local.deps,
  });

  assert.equal(result.state, "ready");
  assert.equal(result.eligibleSubscribers, 2);
  assert.equal(result.brevoMembers, 2);
  assert.equal(result.contactsCreated, 1);
  assert.equal(result.contactsAssociated, 1);
  assert.deepEqual([...brevo.members.keys()].sort(), ["a@example.com", "b@example.com"]);
  assert.deepEqual(local.readReady(), { listId: 9, eligibleSubscribersCount: 2, brevoMembersCount: 2 });
  assert.equal(local.readFailed(), 0);
  assert.equal(brevo.calls.some(call => /emailCampaigns|sendNow|sendTest|smtp\/email/.test(call.path)), false);
});

test("production audience reconcilia unsubscribe nativo, blacklist e contatos estranhos sem reativar consentimento", async () => {
  const brevo = mockBrevo({
    contacts: [
      { email: "good@example.com", listIds: [9] },
      { email: "blocked@example.com", listIds: [9], emailBlacklisted: true },
      { email: "native@example.com", listIds: [9], listUnsubscribed: [9] },
      { email: "localoff@example.com", listIds: [9] },
      { email: "outsider@example.com", listIds: [9] },
    ],
  });
  const local = localDeps([
    { email: "good@example.com", status: "subscribed", marketingConsent: true },
    { email: "blocked@example.com", status: "subscribed", marketingConsent: true },
    { email: "native@example.com", status: "subscribed", marketingConsent: true },
    { email: "localoff@example.com", status: "unsubscribed", marketingConsent: true },
  ]);

  const result = await syncWeeklyBrevoProductionAudience({
    env,
    fetchImpl: brevo.fetchImpl,
    baseUrl: "https://api.brevo.test/v3",
    client: {} as any,
    deps: local.deps,
  });

  assert.equal(result.eligibleSubscribers, 1);
  assert.equal(result.brevoMembers, 1);
  assert.equal(result.locallySuppressedFromBrevo, 1);
  assert.equal(result.locallyUnsubscribedFromBrevo, 1);
  assert.deepEqual(local.events.sort(), ["suppress:blocked@example.com", "unsub:native@example.com"]);
  assert.deepEqual([...brevo.members.keys()], ["good@example.com"]);
  assert.equal(brevo.calls.some(call => call.method === "POST" && call.path === "/v3/contacts"), false);
});

test("membership divergente falha fechado e invalida verificação", async () => {
  const brevo = mockBrevo({
    contacts: [
      { email: "good@example.com", listIds: [9] },
      { email: "outsider@example.com", listIds: [9] },
    ],
    ignoreRemovals: true,
  });
  const local = localDeps([
    { email: "good@example.com", status: "subscribed", marketingConsent: true },
  ]);

  await assert.rejects(
    syncWeeklyBrevoProductionAudience({
      env,
      fetchImpl: brevo.fetchImpl,
      baseUrl: "https://api.brevo.test/v3",
      client: {} as any,
      deps: local.deps,
    }),
    (error: unknown) =>
      error instanceof WeeklyBrevoAudienceSyncError
      && error.code === "WEEKLY_AUDIENCE_FINAL_MEMBERSHIP_MISMATCH",
  );
  assert.equal(local.readReady(), null);
  assert.equal(local.readFailed(), 1);
  assert.equal(brevo.calls.some(call => /emailCampaigns|sendNow|sendTest|smtp\/email/.test(call.path)), false);
});
