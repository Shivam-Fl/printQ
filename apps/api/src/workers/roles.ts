export const workerRoles = ['all', 'conversion', 'maintenance'] as const;

export type WorkerRole = (typeof workerRoles)[number];

/**
 * `all` preserves the local/legacy combined process. Cloud Run deploys the
 * other two roles independently, so a LibreOffice failure cannot take API,
 * timers, or retention processing down with it.
 */
export function runsConversionWorker(role: WorkerRole): boolean {
  return role === 'all' || role === 'conversion';
}

export function runsMaintenanceWorkers(role: WorkerRole): boolean {
  return role === 'all' || role === 'maintenance';
}
