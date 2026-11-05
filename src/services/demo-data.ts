import type { WorkspaceSnapshot } from '../domain/models';

const now = new Date();
const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();

export const demoWorkspace: WorkspaceSnapshot = {
  channel: {
    id: 'operations-alpha',
    name: 'Operations Alpha',
    description: 'Department operations and weekly delivery',
    currentUserDeviceId: 'dev-mara',
    members: [
      { deviceId: 'dev-mara', displayName: 'Mara', role: 'LEAD', presence: 'ONLINE', initials: 'MA' },
      { deviceId: 'dev-ian', displayName: 'Ian', role: 'CO_LEAD', presence: 'ONLINE', initials: 'IA' },
      { deviceId: 'dev-jo', displayName: 'Jo', role: 'MEMBER', presence: 'RECENT', initials: 'JO' },
      { deviceId: 'dev-nico', displayName: 'Nico', role: 'MEMBER', presence: 'ONLINE', initials: 'NI' },
    ],
  },
  tasks: [
    {
      id: 'task-1', channelId: 'operations-alpha', title: 'Reconcile Q4 supply counts',
      description: 'Compare physical stock with the department register.', status: 'TODO', priority: 'URGENT',
      assigneeDeviceId: 'dev-jo', dueAt: inDays(1), archived: false, pending: false, updatedAt: now.toISOString(),
    },
    {
      id: 'task-2', channelId: 'operations-alpha', title: 'Draft November rotation',
      description: null, status: 'IN_PROGRESS', priority: 'HIGH', assigneeDeviceId: 'dev-mara',
      dueAt: inDays(3), archived: false, pending: false, updatedAt: now.toISOString(),
    },
    {
      id: 'task-3', channelId: 'operations-alpha', title: 'Confirm printer maintenance window',
      description: null, status: 'BLOCKED', priority: 'MEDIUM', assigneeDeviceId: 'dev-nico',
      dueAt: inDays(4), archived: false, pending: true, updatedAt: now.toISOString(),
    },
    {
      id: 'task-4', channelId: 'operations-alpha', title: 'Archive October handover notes',
      description: null, status: 'DONE', priority: 'LOW', assigneeDeviceId: 'dev-ian',
      dueAt: null, archived: false, pending: false, updatedAt: now.toISOString(),
    },
  ],
  messages: [
    { id: 'msg-1', channelId: 'operations-alpha', kind: 'USER', authorDeviceId: 'dev-ian', body: 'The supplier confirmed delivery before 14:00.', createdAt: inDays(-0.08), pending: false },
    { id: 'msg-2', channelId: 'operations-alpha', kind: 'SYSTEM', authorDeviceId: null, body: 'Ian completed “Archive October handover notes”.', createdAt: inDays(-0.04), pending: false },
    { id: 'msg-3', channelId: 'operations-alpha', kind: 'USER', authorDeviceId: 'dev-jo', body: 'I am starting the supply count after lunch.', createdAt: inDays(-0.01), pending: false },
  ],
};
