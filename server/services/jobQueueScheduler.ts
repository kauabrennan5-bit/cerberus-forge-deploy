import {
  claimNextJob,
  heartbeat,
  JobQueueJob,
  releaseJob,
  JOB_SCHEMA_VERSION,
} from "../repositories/jobQueueRepository";

export const JOB_QUEUE_DEFAULTS = {
  pollIntervalMs: 30000,
  heartbeatEveryMs: 15000,
  enabled: false,
} as const;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let runningJobId: string | null = null;
let schedulerRunning = false;

function isJobQueueEnabled(): boolean {
  const configured = process.env.JOB_QUEUE_ENABLED;
  if (configured === undefined || configured === "") return JOB_QUEUE_DEFAULTS.enabled;
  return configured === "true" || configured === "1";
}

function dispatchJob(_job: JobQueueJob): { executed: false; error: string } {
  // Nenhum handler está autorizado neste bloco. Executar qualquer job aqui
  // violaria o controle humano de execução. O job retorna à fila ou esgota
  // tentativas e segue para DEAD_LETTER com o motivo explícito.
  return {
    executed: false,
    error: `Handler não autorizado para o tipo ${_job.type}. Nenhum job executa até autorização humana explícita. (JOB_SCHEMA_VERSION ${JOB_SCHEMA_VERSION})`,
  };
}

async function tick(): Promise<void> {
  try {
    const job = await claimNextJob();
    if (!job) return;
    runningJobId = job.jobId;
    console.info(`[JOB-QUEUE] job.claimed jobId=${job.jobId} type=${job.type} attempts=${job.attempts + 1}/${job.maxAttempts}`);
    const dispatch = dispatchJob(job);
    if (!dispatch.executed) {
      await releaseJob(job.jobId, "RETRYING", { error: dispatch.error });
      console.info(`[JOB-QUEUE] job.rejected jobId=${job.jobId} reason=${dispatch.error}`);
    }
  } catch (error) {
    console.error("[JOB-QUEUE] job.tick_failed", error instanceof Error ? error.message : String(error));
  } finally {
    runningJobId = null;
  }
}

async function heartbeats(): Promise<void> {
  if (!runningJobId) return;
  try {
    await heartbeat(runningJobId);
    console.info(`[JOB-QUEUE] job.heartbeat jobId=${runningJobId}`);
  } catch (error) {
    console.error("[JOB-QUEUE] job.heartbeat_failed", error instanceof Error ? error.message : String(error));
  }
}

export function startJobQueue(): boolean {
  if (schedulerRunning) return false;
  if (!isJobQueueEnabled()) {
    console.info("[JOB-QUEUE] scheduler.off JOB_QUEUE_ENABLED não é 'true'. Fila permanece dormente.");
    return false;
  }
  schedulerRunning = true;
  pollTimer = setInterval(tick, JOB_QUEUE_DEFAULTS.pollIntervalMs);
  heartbeatTimer = setInterval(heartbeats, JOB_QUEUE_DEFAULTS.heartbeatEveryMs);
  console.info("[JOB-QUEUE] scheduler.on pollIntervalMs=" + JOB_QUEUE_DEFAULTS.pollIntervalMs);
  return true;
}

export function stopJobQueue(): boolean {
  if (!schedulerRunning) return false;
  if (pollTimer) clearInterval(pollTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  pollTimer = null;
  heartbeatTimer = null;
  schedulerRunning = false;
  console.info("[JOB-QUEUE] scheduler.off");
  return true;
}

export function isSchedulerRunning(): boolean {
  return schedulerRunning;
}
