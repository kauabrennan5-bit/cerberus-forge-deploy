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

  it('returns success for HTTP 201', async () => {
    globalThis.fetch = async () => jsonResponse(201, {
      success: true,
      message: 'Inscrição registrada.',
    });

    assert.deepEqual(await subscribeNewsletter('valid@example.com'), { success: true });
  });

  it('returns the specific validation message for HTTP 400 INVALID_EMAIL', async () => {
    globalThis.fetch = async () => jsonResponse(400, {
      success: false,
      code: 'INVALID_EMAIL',
      error: 'Informe um e-mail válido.',
    });

    assert.deepEqual(await subscribeNewsletter('invalid'), {
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

    assert.deepEqual(await subscribeNewsletter('valid@example.com'), {
      success: false,
      error: 'Serviço temporariamente indisponível. Tente novamente em instantes.',
    });
  });

  it('returns an informative message for transport failures', async () => {
    globalThis.fetch = async () => {
      throw new Error('network unavailable');
    };

    assert.deepEqual(await subscribeNewsletter('valid@example.com'), {
      success: false,
      error: 'Não foi possível conectar. Se o site acabou de carregar, aguarde alguns segundos e tente novamente.',
    });
  });
});
