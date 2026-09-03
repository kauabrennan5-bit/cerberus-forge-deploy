import assert from "node:assert/strict";
import test from "node:test";
import {
  isAbandonedAutonomousCuratorRun,
  recoverAbandonedAutonomousCuratorRuns,
} from "../server/services/autonomousCuratorRunRecovery";

test("stale running cycle without completion is abandoned, completed cycle is not", () => {
  const boot = Date.parse("2026-09-02T23:00:00.000Z");
  assert.equal(isAbandonedAutonomousCuratorRun({
    id: "run-1",
    status: "running",
    started_at: "2026-09-02T21:00:00.000Z",
    completed_at: null,
    metadata: {
      continuous_cycle_started_at: "2026-09-02T22:00:00.000Z",
      continuous_cycle_completed_at: null,
    },
  }, boot, 20), true);

  assert.equal(isAbandonedAutonomousCuratorRun({
    id: "run-2",
    status: "running",
    started_at: "2026-09-02T21:00:00.000Z",
    completed_at: null,
    metadata: {
      continuous_cycle_started_at: "2026-09-02T22:00:00.000Z",
      continuous_cycle_completed_at: "2026-09-02T22:05:00.000Z",
    },
  }, boot, 20), false);
});

function fakeClient() {
  const state = {
    runs: [{
      id: "orphan-run",
      status: "running",
      started_at: "2026-09-02T20:00:00.000Z",
      completed_at: null as string | null,
      interrupted_at: null as string | null,
      recovered_at: null as string | null,
      recovery_reason: null as string | null,
      previous_cycle_id: null as string | null,
      metadata: {
        continuous_cycle_id: "cycle-before-restart",
        continuous_cycle_started_at: "2026-09-02T20:05:00.000Z",
        continuous_cycle_completed_at: null,
      } as Record<string, unknown>,
    }],
    updates: 0,
  };

  const client = {
    from(table: string) {
      if (table === "products") {
        return { select: () => Promise.resolve({ data: [{ id: "p1", status: "published", ativo: true }], error: null }) };
      }
      if (table === "product_source_identities") {
        return {
          select: () => ({
            not: () => Promise.resolve({ data: [{ product_id: "p1" }], error: null }),
          }),
        };
      }
      if (table !== "autonomous_curator_runs") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              lt: () => ({
                order: () => ({
                  limit: async () => ({
                    data: state.runs.filter(run => run.status === "running" && run.completed_at === null),
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_field1: string, id: string) => ({
            eq: () => ({
              is: () => ({
                select: () => ({
                  maybeSingle: async () => {
                    const run = state.runs.find(item => item.id === id && item.status === "running" && item.completed_at === null);
                    if (!run) return { data: null, error: null };
                    Object.assign(run, patch);
                    state.updates += 1;
                    return { data: { id: run.id }, error: null };
                  },
                }),
              }),
            }),
          }),
        }),
      };
    },
  };
  return { client: client as any, state };
}

test("boot recovery closes an orphan exactly once and never replays publication", async () => {
  const { client, state } = fakeClient();
  const first = await recoverAbandonedAutonomousCuratorRuns({
    client,
    bootTime: new Date("2026-09-02T23:00:00.000Z"),
    staleMinutes: 20,
  });
  assert.equal(first.recovered, 1);
  assert.deepEqual(first.recoveredRunIds, ["orphan-run"]);
  assert.equal(state.updates, 1);
  assert.equal(state.runs[0].status, "recovered");
  assert.equal(state.runs[0].previous_cycle_id, "cycle-before-restart");
  assert.equal(state.runs[0].metadata.recovery_replayed_publication, false);
  assert.ok(state.runs[0].completed_at);
  assert.ok(state.runs[0].interrupted_at);
  assert.ok(state.runs[0].recovered_at);

  const second = await recoverAbandonedAutonomousCuratorRuns({
    client,
    bootTime: new Date("2026-09-02T23:01:00.000Z"),
    staleMinutes: 20,
  });
  assert.equal(second.recovered, 0);
  assert.equal(state.updates, 1, "second boot must not recover or republish the same run again");
});
