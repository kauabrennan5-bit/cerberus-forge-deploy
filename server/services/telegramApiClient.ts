const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

export function getTelegramBotToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
}

function getTelegramApiBase(): string {
  return `https://api.telegram.org/bot${getTelegramBotToken()}`;
}

/**
 * Cliente HTTP mínimo da Bot API.
 * Não conhece comandos, catálogo, reviews ou regras comerciais.
 */
export async function telegramApiFetch(
  method: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${getTelegramApiBase()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
