import { readFile, writeFile, mkdir } from "node:fs/promises";

const DEFAULT_HEALTH_URL = "https://cerberus-forge-deploy-backend.onrender.com/health";
const STATE_PATH = process.env.WATCHDOG_STATE_PATH || "state/watchdog-state.json";
const healthUrl = process.env.CERBERUS_HEALTH_URL || DEFAULT_HEALTH_URL;
const timeoutMs = Number.parseInt(process.env.WATCHDOG_TIMEOUT_MS || "10000", 10);
const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || "";

const now = new Date().toISOString();

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.status === "HEALTHY" || parsed.status === "DOWN")) return parsed;
  } catch {
    // A missing/invalid state starts a new observation; it is not a catalog source.
  }
  return { status: "HEALTHY", lastCheckedAt: null, lastHttpStatus: null, reason: null };
}

async function writeOutput(name, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  await writeFile(output, `${name}=${String(value).replaceAll("%", "%25").replaceAll("\n", "%0A")}\n`, { flag: "a" });
}

async function checkHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { "User-Agent": "cerberus-github-watchdog/1.0", Accept: "application/json" },
      signal: controller.signal,
    });
    const body = await response.text();
    if (response.status !== 200) {
      return { status: "DOWN", httpStatus: response.status, reason: `HTTP ${response.status}`, body: body.slice(0, 300) };
    }
    return { status: "HEALTHY", httpStatus: response.status, reason: "HTTP 200" };
  } catch (error) {
    const reason = error?.name === "AbortError" ? `timeout após ${timeoutMs}ms` : `erro de conexão: ${error?.message || String(error)}`;
    return { status: "DOWN", httpStatus: null, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegram(text) {
  if (!botToken || !chatId) {
    throw new Error("WATCHDOG_TELEGRAM_SECRETS_MISSING");
  }
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
const current = await checkHealth();
const transition = `${previous.status}->${current.status}`;
const shouldAlert = transition === "HEALTHY->DOWN" || transition === "DOWN->HEALTHY";
const stateChanged = previous.status !== current.status;
const state = stateChanged || !previous.lastCheckedAt
  ? {
      status: current.status,
      lastCheckedAt: now,
      lastHttpStatus: current.httpStatus,
      reason: current.reason,
    }
  : previous;

await writeOutput("status", current.status);
await writeOutput("transition", transition);
await writeOutput("should_alert", shouldAlert ? "true" : "false");

console.log(`[WATCHDOG] url=${healthUrl} status=${current.status} http=${current.httpStatus ?? "none"} reason=${current.reason}`);
console.log(`[WATCHDOG] transition=${transition} alert=${shouldAlert ? "yes" : "no"}`);

let alertConfirmed = true;
if (shouldAlert) {
  const message = current.status === "DOWN"
    ? `🚨 CERBERUS WATCHDOG\nBackend indisponível.\nURL: ${healthUrl}\nCausa: ${current.reason}\nHorário: ${now}`
    : `✅ CERBERUS WATCHDOG\nBackend recuperado.\nURL: ${healthUrl}\nResposta: HTTP 200\nHorário: ${now}`;
  try {
    await sendTelegram(message);
    console.log(`[WATCHDOG] alerta enviado para transição ${transition}`);
  } catch (error) {
    alertConfirmed = false;
    console.error(`[WATCHDOG] alerta não confirmado: ${error?.message || String(error)}`);
  }
}

if (alertConfirmed && (stateChanged || !previous.lastCheckedAt)) {
  await mkdir(STATE_PATH.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}
if (!alertConfirmed) process.exitCode = 1;
