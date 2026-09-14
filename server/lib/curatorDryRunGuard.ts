import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage<{ blockedAttempts: number }>();

export function isCuratorDryRun(): boolean {
  return context.getStore() !== undefined;
}

export function assertCuratorMutationAllowed(operation: string): void {
  const scope = context.getStore();
  if (!scope) return;
  scope.blockedAttempts += 1;
  throw new Error(`CONTINUOUS_V2_DRY_RUN_MUTATION_BLOCKED:${operation}`);
}

/** A swallowed adapter error still invalidates the entire dry-run proof. */
export async function withCuratorDryRun<T>(work: () => Promise<T>): Promise<T> {
  const scope = context.getStore() || { blockedAttempts: 0 };
  return context.run(scope, async () => {
    const result = await work();
    if (scope.blockedAttempts > 0) {
      throw new Error("CONTINUOUS_V2_DRY_RUN_BLOCKED_MUTATION_ATTEMPT");
    }
    return result;
  });
}

/** Only direct table reads are allowed: RPCs and Edge calls may mutate even via GET. */
export const curatorGuardedSupabaseFetch: typeof fetch = async (input, init) => {
  if (isCuratorDryRun()) {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method || request?.method || "GET").toUpperCase();
    const tableRead = /^\/rest\/v1\/[^/]+$/.test(url.pathname)
      && url.pathname !== "/rest/v1/rpc";
    if (!tableRead || !["GET", "HEAD"].includes(method)) {
      assertCuratorMutationAllowed("supabase_request");
    }
  }
  return globalThis.fetch(input, init);
};
