import type { EventType, MemberRole } from '../../../protocol/contracts';

const leadOnly = new Set<EventType>([
  'INVITATION_CREATED',
  'INVITATION_REVOKED',
  'MEMBER_ADDED',
  'MEMBER_REMOVED',
  'MEMBER_ROLE_CHANGED',
  'CHANNEL_KEY_ROTATED',
]);

const taskManagement = new Set<EventType>([
  'TASK_CREATED',
  'TASK_FIELDS_UPDATED',
  'TASK_ARCHIVED',
]);

export function canAuthorEvent(role: MemberRole, type: EventType): boolean {
  if (type === 'CHANNEL_CREATED') return role === 'LEAD';
  if (leadOnly.has(type)) return role === 'LEAD';
  if (taskManagement.has(type)) return role === 'LEAD' || role === 'CO_LEAD';
  return true;
}

export function canChangeTaskStatus(options: {
  role: MemberRole;
  actorDeviceId: string;
  assigneeDeviceId: string | null;
}): boolean {
  return (
    options.role === 'LEAD' ||
    options.role === 'CO_LEAD' ||
    options.actorDeviceId === options.assigneeDeviceId
  );
}
