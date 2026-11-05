import { describe, expect, it } from 'vitest';
import { canAuthorEvent, canChangeTaskStatus } from '../src/domain/permissions/permissions';

describe('permissions', () => {
  it('limits membership changes to the lead', () => {
    expect(canAuthorEvent('LEAD', 'MEMBER_ADDED')).toBe(true);
    expect(canAuthorEvent('CO_LEAD', 'MEMBER_ADDED')).toBe(false);
    expect(canAuthorEvent('MEMBER', 'MEMBER_ADDED')).toBe(false);
  });

  it('allows a co-lead to manage tasks', () => {
    expect(canAuthorEvent('CO_LEAD', 'TASK_FIELDS_UPDATED')).toBe(true);
  });

  it('allows an assignee to update their own task status', () => {
    expect(canChangeTaskStatus({ role: 'MEMBER', actorDeviceId: 'a', assigneeDeviceId: 'a' })).toBe(true);
    expect(canChangeTaskStatus({ role: 'MEMBER', actorDeviceId: 'a', assigneeDeviceId: 'b' })).toBe(false);
  });
});
