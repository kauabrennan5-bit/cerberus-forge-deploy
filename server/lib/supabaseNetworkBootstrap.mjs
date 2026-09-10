import dns from "node:dns";
import https from "node:https";

const rawSupabaseUrl = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim();
const rawTimeout = Number.parseInt(String(process.env.SUPABASE_HTTP_TIMEOUT_MS || ""), 10);
const timeoutMs = Number.isSafeInteger(rawTimeout)
  ? Math.min(60_000, Math.max(1_000, rawTimeout))
  : 15_000;

const fallbackResolver = new dns.Resolver();
fallbackResolver.setServers(["1.1.1.1", "8.8.8.8"]);

function safeNetworkError(error) {
  const rawCode = error && typeof error === "object" ? String(error.code || "") : "";
  const code = /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : undefined;
  return new TypeError("fetch failed", { cause: code ? { code } : undefined });
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

function resilientIpv4Lookup(hostname, options, callback) {
  dns.lookup(hostname, { family: 4 }, (error, address, family) => {
    if (!error && address) {
      callback(null, address, family || 4);
      return;
    }

    const code = error && typeof error === "object" ? String(error.code || "") : "";
    if (code !== "ENOTFOUND" && code !== "EAI_AGAIN") {
      callback(error || Object.assign(new Error("DNS lookup failed"), { code: "EAI_FAIL" }));
      return;
    }

    fallbackResolver.resolve4(hostname, (fallbackError, addresses) => {
      const fallbackAddress = Array.isArray(addresses) ? addresses[0] : undefined;
      if (fallbackError || !fallbackAddress) {
        callback(fallbackError || error || Object.assign(new Error("DNS fallback failed"), { code: "ENOTFOUND" }));
        return;
      }

      console.warn(`[SUPABASE-TRANSPORT] dns_fallback host=${hostname} system_code=${code || "unknown"}`);
      callback(null, fallbackAddress, 4);
    });
  });
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
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(safeNetworkError(error));
    };

    const nodeRequest = https.request({
      protocol: "https:",
      hostname: target.hostname,
      port: target.port ? Number(target.port) : 443,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      family: 4,
      lookup: resilientIpv4Lookup,
      agent: false,
    }, (nodeResponse) => {
      const chunks = [];
      nodeResponse.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      nodeResponse.on("error", finishReject);
      nodeResponse.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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

    const onAbort = () => nodeRequest.destroy(request.signal.reason instanceof Error
      ? request.signal.reason
      : Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }));
    request.signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
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

    console.log(`[SUPABASE-TRANSPORT] enabled mode=node-https-ipv4-fresh-socket-dns-fallback timeout_ms=${timeoutMs}`);
  } catch {
    console.error("[SUPABASE-TRANSPORT] invalid SUPABASE_URL; custom transport not enabled");
  }
}
