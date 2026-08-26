import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createBrevoNewsletterProvider,
  getNewsletterProviderConfigStatus,
  NewsletterProviderError,
} from "../server/services/newsletterProvider.ts";

describe("newsletter Brevo provider adapter", () => {
  it("sends one message version with a UUID idempotency key and returns messageId", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ messageId: "<provider-message-id>" }), { status: 201 });
    }) as typeof fetch;

    const provider = createBrevoNewsletterProvider({
      apiKey: "test-api-key-placeholder",
      senderEmail: "sender@example.com",
      fetchImpl,
    });
    const result = await provider.project({
      subscriberEmail: "recipient@example.com",
      eventType: "newsletter_subscribed",
      payload: { template_key: "cerberus-newsletter-signup" },
    }, "newsletter-signup-v1:event-1");

    assert.deepEqual(result, { status: "succeeded", providerReference: "<provider-message-id>" });
    assert.equal(capturedUrl, "https://api.brevo.com/v3/smtp/email");
    assert.equal(capturedInit?.method, "POST");
    assert.equal((capturedInit?.headers as Record<string, string>)["api-key"], "test-api-key-placeholder");
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.messageVersions.length, 1);
    assert.deepEqual(body.messageVersions[0].to, [{ email: "recipient@example.com" }]);
    assert.match(body.messageVersions[0].htmlContent, /Bem-vindo à/);
    assert.match(body.messageVersions[0].htmlContent, /Sua inscrição foi confirmada/);
    assert.match(body.messageVersions[0].htmlContent, /bgcolor="#0B0908"/);
    assert.match(body.messageVersions[0].htmlContent, /assets\/newsletter\/social\/instagram\.png/);
    assert.doesNotMatch(body.messageVersions[0].htmlContent, /socialMonogram|border-style:dashed|{{UNSUBSCRIBE_URL}}/);
    assert.equal(body.messageVersions[0].htmlContent.includes("{{UNSUBSCRIBE_URL}}"), false);
    assert.match(body.messageVersions[0].textContent, /confirmou sua inscrição/);
    assert.match(body.headers.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(JSON.stringify(body).includes("test-api-key-placeholder"), false);
  });

  it("sends campaign content through the same Brevo adapter with stable idempotency", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ messageIds: ["campaign-message-1"] }), { status: 201 });
    }) as typeof fetch;
    const provider = createBrevoNewsletterProvider({ apiKey: "campaign-test-key", senderEmail: "sender@example.com", fetchImpl });
    const result = await provider.sendCampaign({
      campaignId: "campaign-1",
      recipientId: "recipient-1",
      subscriberEmail: "recipient@example.com",
      subject: "Seleção editorial",
      htmlContent: "<p>Oferta</p><a href=\"https://example.test/api/newsletter/unsubscribe?token=fake\">Sair</a>",
      textContent: "Oferta\\nSair: https://example.test/api/newsletter/unsubscribe?token=fake",
      idempotencyKey: "campaign-recipient-v1:stable",
    });
    assert.deepEqual(result, { status: "succeeded", providerReference: "campaign-message-1" });
    const body = JSON.parse(String(capturedInit?.body));
    assert.equal(body.messageVersions[0].htmlContent.includes("api/newsletter/unsubscribe"), true);
    assert.equal(body.messageVersions[0].textContent.includes("api/newsletter/unsubscribe"), true);
    assert.equal(body.messageVersions[0].to[0].email, "recipient@example.com");
    assert.equal(body.headers.idempotencyKey, body.headers.idempotencyKey);
    assert.equal(JSON.stringify(body).includes("campaign-test-key"), false);
  });

  it("maps provider duplicate and transient/permanent HTTP failures without exposing response bodies", async () => {
    const duplicateFetch = (async () => new Response(JSON.stringify({ code: "duplicate_parameter" }), { status: 400 })) as typeof fetch;
    const duplicateProvider = createBrevoNewsletterProvider({ apiKey: "k", senderEmail: "sender@example.com", fetchImpl: duplicateFetch });
    assert.deepEqual(await duplicateProvider.project({ subscriberEmail: "recipient@example.com", eventType: "newsletter_subscribed", payload: {} }, "event-1"), { status: "duplicate", providerReference: undefined });

    const transientFetch = (async () => new Response("provider internal detail", { status: 503 })) as typeof fetch;
    const transientProvider = createBrevoNewsletterProvider({ apiKey: "k", senderEmail: "sender@example.com", fetchImpl: transientFetch });
    await assert.rejects(
      () => transientProvider.project({ subscriberEmail: "recipient@example.com", eventType: "newsletter_subscribed", payload: {} }, "event-2"),
      (error: unknown) => error instanceof NewsletterProviderError && error.kind === "transient_5xx" && error.code === "PROVIDER_HTTP_503" && error.message !== "provider internal detail",
    );

    const permanentFetch = (async () => new Response("secret response detail", { status: 400 })) as typeof fetch;
    const permanentProvider = createBrevoNewsletterProvider({ apiKey: "k", senderEmail: "sender@example.com", fetchImpl: permanentFetch });
    await assert.rejects(
      () => permanentProvider.project({ subscriberEmail: "recipient@example.com", eventType: "newsletter_subscribed", payload: {} }, "event-3"),
      (error: unknown) => error instanceof NewsletterProviderError && error.kind === "permanent_4xx" && error.code === "PROVIDER_HTTP_400" && error.message !== "secret response detail",
    );
  });

  it("maps aborts to a retryable timeout and reports configuration only as booleans", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
      return new Response("never", { status: 201 });
    }) as typeof fetch;
    const provider = createBrevoNewsletterProvider({ apiKey: "k", senderEmail: "sender@example.com", timeoutMs: 1_000, fetchImpl });
    await assert.rejects(
      () => provider.project({ subscriberEmail: "recipient@example.com", eventType: "newsletter_subscribed", payload: {} }, "event-4"),
      (error: unknown) => error instanceof NewsletterProviderError && error.kind === "timeout" && error.code === "PROVIDER_TIMEOUT",
    );

    assert.deepEqual(getNewsletterProviderConfigStatus({ BREVO_API_KEY: "present", NEWSLETTER_SENDER_EMAIL: "sender@example.com" }), {
      provider: "brevo",
      configured: true,
      apiKeyPresent: true,
      senderEmailPresent: true,
      senderNamePresent: true,
    });
    assert.equal(getNewsletterProviderConfigStatus({}).configured, false);
  });
});
