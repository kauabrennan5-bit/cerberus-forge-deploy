import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { subscribeNewsletter } from '../src/services/api.ts';

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('subscribeNewsletter', () => {
  beforeEach(() => {
    globalThis.fetch = async () => jsonResponse(500, {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends explicit consent and returns success for HTTP 201', async () => {
    let requestBody: unknown;
    globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse(201, {
        success: true,
        message: 'Inscrição registrada.',
      });
    };

    assert.deepEqual(await subscribeNewsletter('valid@example.com', true), { success: true });
    assert.deepEqual(requestBody, { email: 'valid@example.com', marketingConsent: true });
  });

  it('treats HTTP 200 replay as a successful idempotent result', async () => {
    globalThis.fetch = async () => jsonResponse(200, {
      success: true,
      result: 'replayed',
      replayed: true,
    });

    assert.deepEqual(await subscribeNewsletter('valid@example.com', true), {
      success: true,
      result: 'replayed',
      replayed: true,
    });
  });

  it('returns the specific validation message for HTTP 400 INVALID_EMAIL', async () => {
    globalThis.fetch = async () => jsonResponse(400, {
      success: false,
      code: 'INVALID_EMAIL',
      error: 'Informe um e-mail válido.',
    });

    assert.deepEqual(await subscribeNewsletter('invalid', true), {
      success: false,
      error: 'E-mail inválido. Verifique e tente novamente.',
    });
  });

  it('returns the specific availability message for HTTP 503 NEWSLETTER_UNAVAILABLE', async () => {
    globalThis.fetch = async () => jsonResponse(503, {
      success: false,
      code: 'NEWSLETTER_UNAVAILABLE',
      error: 'Cadastro temporariamente indisponível.',
    });

    assert.deepEqual(await subscribeNewsletter('valid@example.com', true), {
      success: false,
      error: 'Serviço temporariamente indisponível. Tente novamente em instantes.',
    });
  });

  it('maps missing consent to an explicit user-facing error', async () => {
    globalThis.fetch = async () => jsonResponse(400, {
      success: false,
      code: 'CONSENT_REQUIRED',
      error: 'É necessário confirmar o consentimento.',
    });

    assert.deepEqual(await subscribeNewsletter('valid@example.com', false), {
      success: false,
      error: 'Confirme que deseja receber novas seleções, recomendações e ofertas.',
    });
  });

  it('does not mask reconsent-required contacts as a successful subscription', async () => {
    globalThis.fetch = async () => jsonResponse(409, {
      success: false,
      code: 'RECONSENT_REQUIRED',
      error: 'Este contato exige um fluxo explícito de reativação.',
    });

    assert.deepEqual(await subscribeNewsletter('valid@example.com', true), {
      success: false,
      error: 'Este contato está fora da lista de marketing. Uma reativação exigirá um fluxo explícito futuro.',
    });
  });

  it('returns an informative message for transport failures', async () => {
    globalThis.fetch = async () => {
      throw new Error('network unavailable');
    };

    assert.deepEqual(await subscribeNewsletter('valid@example.com', true), {
      success: false,
      error: 'Não foi possível conectar. Se o site acabou de carregar, aguarde alguns segundos e tente novamente.',
    });
  });
});
