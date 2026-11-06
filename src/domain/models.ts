import type { MemberRole, TaskPriority, TaskStatus } from '../../protocol/contracts';

export interface Member {
  deviceId: string;
  displayName: string;
  role: MemberRole;
  presence: 'ONLINE' | 'RECENT' | 'OFFLINE';
  initials: string;
}

export interface Task {
  id: string;
  channelId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeDeviceId: string | null;
  dueAt: string | null;
  archived: boolean;
  pending: boolean;
  updatedAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  kind: 'USER' | 'SYSTEM';
  authorDeviceId: string | null;
  body: string;
  createdAt: string;
  pending: boolean;
}

export interface Channel {
  id: string;
  name: string;
  description: string | null;
  currentUserDeviceId: string;
  leadDeviceId?: string;
  members: Member[];
}

export interface ChannelSummary {
  id: string;
  name: string;
  description: string | null;
  leadDeviceId?: string;
}

export interface WorkspaceSnapshot {
  channel: Channel | null;
  tasks: Task[];
  messages: Message[];
}
