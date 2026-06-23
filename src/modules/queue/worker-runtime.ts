export function isWorkerRuntime(): boolean {
  return process.env.WORKER_MODE === 'true' || process.env.NODE_ROLE === 'worker';
}
