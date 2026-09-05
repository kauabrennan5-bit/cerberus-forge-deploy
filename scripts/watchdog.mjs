import { mkdir, readFile, writeFile } from "node:fs/promises";

const DEFAULT_HEALTH_URL = "https://cerberus-forge-deploy-backend.onrender.com/health";
const STATE_PATH = process.env.WATCHDOG_STATE_PATH || "state/watchdog-state.json";
const healthUrl = process.env.CERBERUS_HEALTH_URL || DEFAULT_HEALTH_URL;
const timeoutMs = Math.max(75_000, Number.parseInt(process.env.WATCHDOG_TIMEOUT_MS || "75000", 10));
const maxAttempts = Math.min(2, Math.max(1, Number.parseInt(process.env.WATCHDOG_MAX_ATTEMPTS || "2", 10)));
const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "";
const now = new Date().toISOString();

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (parsed && (parsed.status === "HEALTHY" || parsed.status === "DOWN")) return parsed;
  } catch {}
  return { status: "HEALTHY", lastCheckedAt: null, lastHttpStatus: null, reason: null, classification: null };
}

async function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await writeFile(output, `${name}=${String(value).replaceAll("%", "%25").replaceAll("\n", "%0A")}\n`, { flag: "a" });
}

async function checkHealth(attempt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { "User-Agent": "cerberus-github-watchdog/2.0", Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    if (response.status !== 200) return { status: "DOWN", attempt, httpStatus: response.status, timedOut: false, reason: `HTTP ${response.status}`, body: body.slice(0, 300) };
    return { status: "HEALTHY", attempt, httpStatus: 200, timedOut: false, reason: "HTTP 200" };
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    return { status: "DOWN", attempt, httpStatus: null, timedOut, reason: timedOut ? `timeout após ${timeoutMs}ms` : `erro de conexão: ${error?.message || String(error)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkWithBoundedRetry() {
  const first = await checkHealth(1);
  if (first.status === "HEALTHY" || maxAttempts === 1) return { ...first, classification: first.status === "HEALTHY" ? "HEALTHY" : "REAL_OUTAGE", attempts: 1 };
  const second = await checkHealth(2);
  if (second.status === "HEALTHY") {
    return { ...second, classification: first.timedOut ? "COLD_START_RECOVERED" : "TRANSIENT_RECOVERED", attempts: 2, firstFailure: first.reason };
  }
  return { ...second, classification: "REAL_OUTAGE", attempts: 2, firstFailure: first.reason };
}

async function sendTelegram(text) {
  if (!botToken || !chatId) throw new Error("WATCHDOG_TELEGRAM_SECRETS_MISSING");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(`TELEGRAM_ALERT_FAILED_HTTP_${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

const previous = await readState();
const current = await checkWithBoundedRetry();
const transition = `${previous.status}->${current.status}`;
const shouldAlert = transition === "HEALTHY->DOWN" || transition === "DOWN->HEALTHY";
const stateChanged = previous.status !== current.status;
const state = stateChanged || !previous.lastCheckedAt
  ? { status: current.status, lastCheckedAt: now, lastHttpStatus: current.httpStatus, reason: current.reason, classification: current.classification }
  : { ...previous, lastCheckedAt: now, lastHttpStatus: current.httpStatus, reason: current.reason, classification: current.classification };

await writeOutput("status", current.status);
await writeOutput("transition", transition);
await writeOutput("classification", current.classification);
await writeOutput("attempts", current.attempts);
await writeOutput("should_alert", shouldAlert ? "true" : "false");

console.log(`[WATCHDOG] url=${healthUrl} status=${current.status} http=${current.httpStatus ?? "none"} classification=${current.classification} attempts=${current.attempts} reason=${current.reason}`);
console.log(`[WATCHDOG] transition=${transition} alert=${shouldAlert ? "yes" : "no"}`);

let alertConfirmed = true;
if (shouldAlert) {
  const message = current.status === "DOWN"
    ? `🚨 CERBERUS WATCHDOG\nREAL_OUTAGE: backend indisponível após ${current.attempts} tentativas de ${timeoutMs}ms.\nURL: ${healthUrl}\nCausa: ${current.reason}\nHorário: ${now}`
    : `✅ CERBERUS WATCHDOG\n${current.classification}: backend recuperado.\nURL: ${healthUrl}\nResposta: HTTP 200 após ${current.attempts} tentativa(s).\nHorário: ${now}`;
  try {
    await sendTelegram(message);
    console.log(`[WATCHDOG] alerta enviado para transição ${transition}`);
  } catch (error) {
    alertConfirmed = false;
    console.error(`[WATCHDOG] alerta não confirmado: ${error?.message || String(error)}`);
  }
}

if (alertConfirmed) {
  await mkdir(STATE_PATH.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}
if (!alertConfirmed) process.exitCode = 1;
