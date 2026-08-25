import { createConfiguredNewsletterProvider, getNewsletterProviderConfigStatus } from "./newsletterProvider";
import { createNewsletterOutboxWorker } from "./newsletterOutboxWorker";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 300_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let tickInFlight = false;

function isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NEWSLETTER_OUTBOX_WORKER_ENABLED;
  return value === "1" || value === "true";
}

function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.NEWSLETTER_OUTBOX_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Number.isFinite(parsed) ? Math.floor(parsed) : DEFAULT_POLL_INTERVAL_MS));
}

export function startNewsletterOutboxWorker(): boolean {
  if (running) return false;
  if (!isEnabled()) {
    console.info("[NEWSLETTER-OUTBOX] worker.off NEWSLETTER_OUTBOX_WORKER_ENABLED não está habilitado.");
    return false;
  }

  const config = getNewsletterProviderConfigStatus();
  if (!config.configured) {
    console.warn("[NEWSLETTER-OUTBOX] worker.blocked provider não configurado; nenhum item será processado.");
    return false;
  }

  let provider;
  try {
    provider = createConfiguredNewsletterProvider();
  } catch {
    console.warn("[NEWSLETTER-OUTBOX] worker.blocked configuração do provider inválida; nenhum item será processado.");
    return false;
  }

  const worker = createNewsletterOutboxWorker(provider, {
    logger: (event, fields) => console.info(`[NEWSLETTER-OUTBOX] ${event} ${JSON.stringify(fields)}`),
  });
  const interval = pollIntervalMs();
  running = true;
  timer = setInterval(() => {
    void runTick(worker.processOnce);
  }, interval);
  console.info(`[NEWSLETTER-OUTBOX] worker.on pollIntervalMs=${interval}`);
  void runTick(worker.processOnce);
  return true;
}

export function stopNewsletterOutboxWorker(): boolean {
  if (!running) return false;
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  console.info("[NEWSLETTER-OUTBOX] worker.off");
  return true;
}

export function isNewsletterOutboxWorkerRunning(): boolean {
  return running;
}

async function runTick(processOnce: () => Promise<{ outcome: string; providerCalled: boolean }>): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const result = await processOnce();
    if (result.outcome !== "idle") {
      console.info(`[NEWSLETTER-OUTBOX] worker.tick outcome=${result.outcome} provider_called=${result.providerCalled}`);
    }
  } catch {
    console.error("[NEWSLETTER-OUTBOX] worker.tick_failed");
  } finally {
    tickInFlight = false;
  }
}
