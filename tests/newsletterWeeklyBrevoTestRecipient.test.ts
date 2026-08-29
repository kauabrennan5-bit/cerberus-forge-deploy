import test from "node:test";
import assert from "node:assert/strict";
import {
  createWeeklyBrevoMarketingProvider,
  getWeeklyBrevoErrorDetails,
} from "../server/services/newsletterWeeklyBrevoProvider";
import {
  ensureWeeklyBrevoTestRecipient,
  WeeklyBrevoTestRecipientSetupError,
} from "../server/services/newsletterWeeklyBrevoTestRecipient";

function jsonResponse(status: number, body: Record<string, unknown> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("sendTest classifica recipient issues sem expor email da resposta Brevo", async () => {
  const cases = [
    { field: "unexistingEmails", expected: "not_found" },
    { field: "withoutListEmails", expected: "without_list" },
    { field: "blackListedEmails", expected: "blacklisted" },
  ] as const;

  for (const entry of cases) {
    const provider = createWeeklyBrevoMarketingProvider({
      apiKey: "test-key",
      senderEmail: "newsletter@cerberus.example.com",
      fetchImpl: async () => jsonResponse(400, {
        code: "invalid_parameter",
        message: "The email could not be sent to all recipients",
        [entry.field]: ["private-test-address@example.com"],
      }),
    });

    try {
      await provider.sendTest("1", ["private-test-address@example.com"]);
      assert.fail("sendTest deveria falhar");
    } catch (error) {
      const details = getWeeklyBrevoErrorDetails(error);
      assert.ok(details);
      assert.equal(details.kind, "http");
      assert.equal(details.status, 400);
      assert.equal(details.providerCode, "invalid_parameter");
      assert.equal(details.testRecipientIssue, entry.expected);
      assert.doesNotMatch(JSON.stringify(details), /private-test-address@example\.com/);
    }
  }
});

test("ensure cria lista dedicada e contato de teste quando ambos não existem", async () => {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  let verified = false;
  const result = await ensureWeeklyBrevoTestRecipient({
    env: {
      BREVO_API_KEY: "test-key",
      NEWSLETTER_TEST_EMAIL: "only-test@example.com",
      NEWSLETTER_WEEKLY_ENABLED: "false",
    },
    fetchImpl: async (input, init) => {
      const method = String(init?.method || "GET");
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      if (method === "GET" && url.endsWith("/contacts/only-test%40example.com")) {
        if (!verified) return jsonResponse(404, { code: "document_not_found" });
        return jsonResponse(200, { emailBlacklisted: false, listIds: [9] });
      }
      if (method === "GET" && url.includes("/contacts/lists?")) return jsonResponse(200, { lists: [] });
      if (method === "GET" && url.includes("/contacts/folders?")) return jsonResponse(200, { folders: [{ id: 3, name: "Cerberus" }] });
      if (method === "POST" && url.endsWith("/contacts/lists")) return jsonResponse(201, { id: 9 });
      if (method === "POST" && url.endsWith("/contacts")) {
        assert.deepEqual(body, {
          email: "only-test@example.com",
          listIds: [9],
          emailBlacklisted: false,
        });
        verified = true;
        return jsonResponse(201, { id: 20 });
      }
      throw new Error(`UNEXPECTED_REQUEST:${method}:${url}`);
    },
  });

  assert.equal(result.state, "ready");
  assert.equal(result.contactCreated, true);
  assert.equal(result.listCreated, true);
  assert.equal(result.listId, 9);
  assert.equal(result.associated, true);
  assert.equal(result.blacklisted, false);
  assert.doesNotMatch(JSON.stringify(result), /only-test@example\.com/);
  assert.equal(calls.some(call => call.url.includes("/emailCampaigns")), false);
});

test("ensure associa contato existente à lista dedicada sem recriar contato", async () => {
  let associated = false;
  let createContactCalls = 0;
  const result = await ensureWeeklyBrevoTestRecipient({
    env: {
      BREVO_API_KEY: "test-key",
      NEWSLETTER_TEST_EMAIL: "only-test@example.com",
      NEWSLETTER_WEEKLY_ENABLED: "false",
    },
    fetchImpl: async (input, init) => {
      const method = String(init?.method || "GET");
      const url = String(input);
      if (method === "GET" && url.endsWith("/contacts/only-test%40example.com")) {
        return jsonResponse(200, { emailBlacklisted: false, listIds: associated ? [2, 9] : [2] });
      }
      if (method === "GET" && url.includes("/contacts/lists?")) {
        return jsonResponse(200, { lists: [{ id: 9, name: "Cerberus Weekly Test", folderId: 3 }] });
      }
      if (method === "POST" && url.endsWith("/contacts/lists/9/contacts/add")) {
        associated = true;
        return jsonResponse(201, { success: ["only-test@example.com"], failure: [] });
      }
      if (method === "POST" && url.endsWith("/contacts")) {
        createContactCalls += 1;
        return jsonResponse(201, { id: 20 });
      }
      throw new Error(`UNEXPECTED_REQUEST:${method}:${url}`);
    },
  });

  assert.equal(result.state, "ready");
  assert.equal(result.contactCreated, false);
  assert.equal(result.listCreated, false);
  assert.equal(result.listId, 9);
  assert.equal(createContactCalls, 0);
  assert.equal(associated, true);
});

test("ensure fail-closed não desbloqueia contato blacklisted", async () => {
  let calls = 0;
  await assert.rejects(
    ensureWeeklyBrevoTestRecipient({
      env: {
        BREVO_API_KEY: "test-key",
        NEWSLETTER_TEST_EMAIL: "only-test@example.com",
        NEWSLETTER_WEEKLY_ENABLED: "false",
      },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { emailBlacklisted: true, listIds: [] });
      },
    }),
    (error: unknown) => error instanceof WeeklyBrevoTestRecipientSetupError
      && error.code === "WEEKLY_BREVO_TEST_RECIPIENT_BLACKLISTED",
  );
  assert.equal(calls, 1);
});

test("ensure é bloqueado se weekly de produção estiver habilitada", async () => {
  let calls = 0;
  await assert.rejects(
    ensureWeeklyBrevoTestRecipient({
      env: {
        BREVO_API_KEY: "test-key",
        NEWSLETTER_TEST_EMAIL: "only-test@example.com",
        NEWSLETTER_WEEKLY_ENABLED: "true",
      },
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200);
      },
    }),
    (error: unknown) => error instanceof WeeklyBrevoTestRecipientSetupError
      && error.code === "WEEKLY_TEST_RECIPIENT_SETUP_PRODUCTION_ENABLED",
  );
  assert.equal(calls, 0);
});
