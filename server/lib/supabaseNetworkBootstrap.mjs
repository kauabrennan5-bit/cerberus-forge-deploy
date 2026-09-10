import https from "node:https";

const rawSupabaseUrl = String(process.env.SUPABASE_URL || "").trim();
const rawTimeout = Number.parseInt(String(process.env.SUPABASE_HTTP_TIMEOUT_MS || ""), 10);
const timeoutMs = Number.isSafeInteger(rawTimeout)
  ? Math.min(60_000, Math.max(1_000, rawTimeout))
  : 15_000;

const NETWORK_DIAGNOSTIC_INTERVAL_MS = 30_000;
const lastDiagnosticAt = new Map();

function safeToken(value, fallback = "UNKNOWN", maxLength = 80) {
  const normalized = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9_.:-]{1,80}$/.test(normalized)
    ? normalized.slice(0, maxLength)
    : fallback;
}

function networkErrorCode(error) {
  if (!error || typeof error !== "object") return "UNKNOWN";
  return safeToken(error.code, "UNKNOWN");
}

function networkErrorSyscall(error) {
  if (!error || typeof error !== "object") return "UNKNOWN";
  return safeToken(error.syscall, "UNKNOWN");
}

function safeNetworkError(error) {
  const code = networkErrorCode(error);
  return new TypeError("fetch failed", {
    cause: code !== "UNKNOWN" ? { code } : undefined,
  });
}

function logNetworkFailure(error, phase) {
  const code = networkErrorCode(error);
  const syscall = networkErrorSyscall(error);
  const safePhase = safeToken(phase, "UNKNOWN", 40);
  const key = `${safePhase}:${code}:${syscall}`;
  const now = Date.now();
  const previous = lastDiagnosticAt.get(key) || 0;
  if (now - previous < NETWORK_DIAGNOSTIC_INTERVAL_MS) return;
  lastDiagnosticAt.set(key, now);

  // Intentionally excludes URL, hostname, query string, headers, request body,
  // keys and tokens. Only low-level network classification is emitted.
  console.error(`[SUPABASE-TRANSPORT] request_failed phase=${safePhase} code=${code} syscall=${syscall}`);
}

function appendHeaders(target, source) {
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) target.append(name, item);
    } else {
      target.append(name, String(value));
    }
  }
}

async function requestWithFreshIpv4Socket(request, expectedOrigin) {
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.origin !== expectedOrigin) {
    throw new TypeError("SUPABASE_FETCH_ORIGIN_MISMATCH");
  }

  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : Buffer.from(await request.arrayBuffer());

  return await new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(request.signal.reason || new DOMException("The operation was aborted", "AbortError"));
      return;
    }

    let settled = false;
    let phase = "LOOKUP";
    let timer;
    let nodeRequest;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      logNetworkFailure(error, phase);
      reject(safeNetworkError(error));
    };

    try {
      nodeRequest = https.request({
        protocol: "https:",
        hostname: target.hostname,
        port: target.port ? Number(target.port) : 443,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        family: 4,
        agent: false,
      }, (nodeResponse) => {
        phase = "RESPONSE_BODY";
        const chunks = [];
        nodeResponse.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        nodeResponse.on("error", finishReject);
        nodeResponse.on("end", () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const headers = new Headers();
          appendHeaders(headers, nodeResponse.headers);
          const status = nodeResponse.statusCode || 502;
          const responseBody = status === 204 || status === 205 || status === 304
            ? null
            : Buffer.concat(chunks);
          resolve(new Response(responseBody, {
            status,
            statusText: nodeResponse.statusMessage || "",
            headers,
          }));
        });
      });
    } catch (error) {
      phase = "REQUEST_SETUP";
      finishReject(error);
      return;
    }

    nodeRequest.on("socket", (socket) => {
      phase = "LOOKUP";
      socket.once("lookup", (error) => {
        phase = error ? "LOOKUP" : "TCP_CONNECT";
      });
      socket.once("connect", () => {
        phase = "TLS_HANDSHAKE";
      });
      socket.once("secureConnect", () => {
        phase = "WAITING_RESPONSE";
      });
    });

    const onAbort = () => nodeRequest.destroy(request.signal.reason instanceof Error
      ? request.signal.reason
      : Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }));
    request.signal.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      nodeRequest.destroy(Object.assign(new Error("Supabase request timed out"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    timer.unref?.();

    nodeRequest.on("error", finishReject);
    nodeRequest.on("close", () => request.signal.removeEventListener("abort", onAbort));

    if (body && body.length > 0) nodeRequest.write(body);
    nodeRequest.end();
  });
}

if (rawSupabaseUrl && typeof globalThis.fetch === "function") {
  try {
    const supabaseOrigin = new URL(rawSupabaseUrl).origin;
    const originalFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = async function supabaseSafeFetch(input, init) {
      const request = new Request(input, init);
      const target = new URL(request.url);
      if (target.origin !== supabaseOrigin) return originalFetch(request);
      return requestWithFreshIpv4Socket(request, supabaseOrigin);
    };

    console.log(`[SUPABASE-TRANSPORT] enabled mode=node-https-ipv4-fresh-socket timeout_ms=${timeoutMs}`);
  } catch {
    console.error("[SUPABASE-TRANSPORT] invalid SUPABASE_URL; custom transport not enabled");
  }
}
