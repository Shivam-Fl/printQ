import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api.js';
import { auditLabel, auditReason, campusErrorMessage, campusFormProblem, setupMissing } from './adminText.js';

describe('admin console copy', () => {
  it('shows human labels for audit actions', () => {
    expect(auditLabel({ action: 'shop.unpublished' })).toBe('Unpublished shop');
    expect(auditLabel({ action: 'campus.created', metadata: { active: true } })).toBe('Added campus');
    expect(auditLabel({ action: 'campus.updated', metadata: { active: false, changed: ['isActive'] } })).toBe('Deactivated campus');
    expect(auditLabel({ action: 'campus.updated', metadata: { active: true, changed: ['isActive'] } })).toBe('Activated campus');
    expect(auditLabel({ action: 'campus.updated', metadata: { active: true, changed: ['name'] } })).toBe('Edited campus');
    expect(auditLabel({ action: 'campus.updated', metadata: { active: false } })).toBe('Edited campus');
    expect(auditLabel({ action: 'shop.something_new' })).toBe('shop something new');
  });

  it('reads the reason from audit metadata', () => {
    expect(auditReason({ metadata: { reason: 'Fake listing' } })).toBe('Fake listing');
    expect(auditReason({ metadata: null })).toBeNull();
    expect(auditReason({})).toBeNull();
  });

  it('lists what a shop in setup still needs', () => {
    expect(setupMissing({ location: false, printerLinked: false, pcOnline: false })).toBe('location, printer, PC online');
    expect(setupMissing({ location: true, printerLinked: true, pcOnline: false })).toBe('PC online');
    expect(setupMissing({ location: true, printerLinked: true, pcOnline: true })).toBe('');
  });

  it('catches blank campus fields before sending', () => {
    expect(campusFormProblem('   ', 'Main Road')).toMatch(/campus name/);
    expect(campusFormProblem('IIT Delhi', '  ')).toMatch(/address/);
    expect(campusFormProblem('IIT Delhi', 'Hauz Khas')).toBeNull();
  });

  it('never shows raw validation text for campus saves', () => {
    const invalid = new ApiError(400, 'Name: Too small: expected string to have >=2 characters', {
      error: 'Validation failed', details: [{ path: 'name', message: 'Too small: expected string to have >=2 characters' }],
    });
    expect(campusErrorMessage(invalid)).toBe('Campus name should be 2 to 160 letters.');
    expect(campusErrorMessage(new ApiError(409, 'A campus called "IIT Delhi" already exists.'))).toBe('A campus called "IIT Delhi" already exists.');
    expect(campusErrorMessage(new ApiError(500, 'Internal server error'))).toBe('The campus could not be saved. Please try again.');
    expect(campusErrorMessage(new TypeError('Failed to fetch'))).toBe('The campus could not be saved. Please try again.');
  });
});
