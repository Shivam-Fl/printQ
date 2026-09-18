import { describe, expect, it } from 'vitest';
import { runsConversionWorker, runsMaintenanceWorkers, workerRoles } from './roles.js';

describe('Cloud Run worker roles', () => {
  it('keeps legacy combined mode while isolating conversion from maintenance', () => {
    expect(workerRoles).toEqual(['all', 'conversion', 'maintenance']);
    expect(runsConversionWorker('all')).toBe(true);
    expect(runsMaintenanceWorkers('all')).toBe(true);
    expect(runsConversionWorker('conversion')).toBe(true);
    expect(runsMaintenanceWorkers('conversion')).toBe(false);
    expect(runsConversionWorker('maintenance')).toBe(false);
    expect(runsMaintenanceWorkers('maintenance')).toBe(true);
  });
});
