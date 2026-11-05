import type { MemberRole, NodicEvent, TaskPriority, TaskStatus } from '../../../protocol/contracts';
import { shouldApplyField, type FieldVersion } from '../conflicts/field-version';
import type { Channel, Member, Message, Task } from '../models';

export interface MaterializedState {
  channel: Channel;
  tasks: Map<string, Task>;
  taskFieldVersions: Map<string, Map<string, FieldVersion>>; // taskId -> (fieldName -> FieldVersion)
  messages: Message[];
  members: Map<string, Member>;
}

export interface ReducerResult {
  updatedTasks: Task[];
  updatedMessages: Message[];
  updatedMembers: Member[];
  generatedSystemMessage?: Message;
}

export function createInitialMaterializedState(channel: Channel): MaterializedState {
  const memberMap = new Map<string, Member>();
  channel.members.forEach((m) => memberMap.set(m.deviceId, m));
  return {
    channel,
    tasks: new Map(),
    taskFieldVersions: new Map(),
    messages: [],
    members: memberMap,
  };
}

export function applyEventToState(
  state: MaterializedState,
  event: NodicEvent,
): ReducerResult {
  const result: ReducerResult = {
    updatedTasks: [],
    updatedMessages: [],
    updatedMembers: [],
  };

  const author = state.members.get(event.authorDeviceId);
  const authorName = author?.displayName ?? event.authorDeviceId.slice(0, 8);

  switch (event.type) {
    case 'CHANNEL_CREATED': {
      const payload = event.payload as { name?: string; description?: string };
      state.channel.name = payload.name ?? state.channel.name;
      state.channel.description = payload.description ?? null;
      if (!state.members.has(event.authorDeviceId)) {
        const lead: Member = {
          deviceId: event.authorDeviceId,
          displayName: authorName,
          role: 'LEAD',
          presence: 'ONLINE',
          initials: authorName.slice(0, 2).toUpperCase(),
        };
        state.members.set(lead.deviceId, lead);
        result.updatedMembers.push(lead);
      }
      break;
    }

    case 'MEMBER_ADDED': {
      const payload = event.payload as {
        deviceId: string;
        displayName: string;
        role?: MemberRole;
      };
      const member: Member = {
        deviceId: payload.deviceId,
        displayName: payload.displayName,
        role: payload.role ?? 'MEMBER',
        presence: 'RECENT',
        initials: payload.displayName.slice(0, 2).toUpperCase(),
      };
      state.members.set(member.deviceId, member);
      result.updatedMembers.push(member);
      break;
    }

    case 'MEMBER_ROLE_CHANGED': {
      const payload = event.payload as { deviceId: string; role: MemberRole };
      const existing = state.members.get(payload.deviceId);
      if (existing) {
        existing.role = payload.role;
        result.updatedMembers.push(existing);
      }
      break;
    }

    case 'MEMBER_REMOVED': {
      const payload = event.payload as { deviceId: string };
      const existing = state.members.get(payload.deviceId);
      if (existing) {
        existing.presence = 'OFFLINE';
        state.members.delete(payload.deviceId);
        result.updatedMembers.push(existing);
      }
      break;
    }

    case 'TASK_CREATED': {
      const payload = event.payload as {
        id: string;
        title: string;
        description?: string;
        status?: TaskStatus;
        priority?: TaskPriority;
        assigneeDeviceId?: string;
        dueAt?: string;
      };

      const taskId = payload.id;
      const initialStatus = payload.status ?? 'TODO';
      const initialPriority = payload.priority ?? 'MEDIUM';

      const task: Task = {
        id: taskId,
        channelId: event.channelId,
        title: payload.title,
        description: payload.description ?? null,
        status: initialStatus,
        priority: initialPriority,
        assigneeDeviceId: payload.assigneeDeviceId ?? null,
        dueAt: payload.dueAt ?? null,
        archived: false,
        pending: false,
        updatedAt: event.createdAt,
      };

      const fieldVersions = new Map<string, FieldVersion>();
      const initialVersion: FieldVersion = {
        lamportClock: event.lamportClock,
        actorDeviceId: event.authorDeviceId,
        eventId: event.id,
      };

      fieldVersions.set('title', initialVersion);
      fieldVersions.set('description', initialVersion);
      fieldVersions.set('status', initialVersion);
      fieldVersions.set('priority', initialVersion);
      fieldVersions.set('assigneeDeviceId', initialVersion);
      fieldVersions.set('dueAt', initialVersion);

      state.tasks.set(taskId, task);
      state.taskFieldVersions.set(taskId, fieldVersions);
      result.updatedTasks.push(task);
      break;
    }

    case 'TASK_STATUS_CHANGED': {
      const taskId = event.entityId ?? (event.payload as { taskId?: string }).taskId;
      if (!taskId) break;

      const task = state.tasks.get(taskId);
      if (!task) break;

      let fieldVersions = state.taskFieldVersions.get(taskId);
      if (!fieldVersions) {
        fieldVersions = new Map();
        state.taskFieldVersions.set(taskId, fieldVersions);
      }

      const currentVersion = fieldVersions.get('status') ?? null;
      const incomingVersion: FieldVersion = {
        lamportClock: event.lamportClock,
        actorDeviceId: event.authorDeviceId,
        eventId: event.id,
      };

      if (shouldApplyField(currentVersion, incomingVersion)) {
        const payload = event.payload as { status: TaskStatus };
        const previousStatus = task.status;
        task.status = payload.status;
        task.updatedAt = event.createdAt;
        fieldVersions.set('status', incomingVersion);
        result.updatedTasks.push(task);

        // SPEC 8.5.9: The first accepted transition into DONE MUST generate one deterministic system chat item
        if (payload.status === 'DONE' && previousStatus !== 'DONE') {
          const systemMsg: Message = {
            id: `sys-done-${event.id}`,
            channelId: event.channelId,
            kind: 'SYSTEM',
            authorDeviceId: event.authorDeviceId,
            body: `${authorName} completed "${task.title}".`,
            createdAt: event.createdAt,
            pending: false,
          };
          state.messages.push(systemMsg);
          result.generatedSystemMessage = systemMsg;
          result.updatedMessages.push(systemMsg);
        }
      }
      break;
    }

    case 'TASK_FIELDS_UPDATED': {
      const taskId = event.entityId ?? (event.payload as { taskId?: string }).taskId;
      if (!taskId) break;

      const task = state.tasks.get(taskId);
      if (!task) break;

      let fieldVersions = state.taskFieldVersions.get(taskId);
      if (!fieldVersions) {
        fieldVersions = new Map();
        state.taskFieldVersions.set(taskId, fieldVersions);
      }

      const incomingVersion: FieldVersion = {
        lamportClock: event.lamportClock,
        actorDeviceId: event.authorDeviceId,
        eventId: event.id,
      };

      const payload = event.payload as {
        fields: {
          title?: string;
          description?: string;
          priority?: TaskPriority;
          assigneeDeviceId?: string | null;
          dueAt?: string | null;
        };
      };

      let changed = false;

      if (payload.fields.title !== undefined) {
        const cur = fieldVersions.get('title') ?? null;
        if (shouldApplyField(cur, incomingVersion)) {
          task.title = payload.fields.title;
          fieldVersions.set('title', incomingVersion);
          changed = true;
        }
      }

      if (payload.fields.description !== undefined) {
        const cur = fieldVersions.get('description') ?? null;
        if (shouldApplyField(cur, incomingVersion)) {
          task.description = payload.fields.description;
          fieldVersions.set('description', incomingVersion);
          changed = true;
        }
      }

      if (payload.fields.priority !== undefined) {
        const cur = fieldVersions.get('priority') ?? null;
        if (shouldApplyField(cur, incomingVersion)) {
          task.priority = payload.fields.priority;
          fieldVersions.set('priority', incomingVersion);
          changed = true;
        }
      }

      if (payload.fields.assigneeDeviceId !== undefined) {
        const cur = fieldVersions.get('assigneeDeviceId') ?? null;
        if (shouldApplyField(cur, incomingVersion)) {
          task.assigneeDeviceId = payload.fields.assigneeDeviceId;
          fieldVersions.set('assigneeDeviceId', incomingVersion);
          changed = true;
        }
      }

      if (payload.fields.dueAt !== undefined) {
        const cur = fieldVersions.get('dueAt') ?? null;
        if (shouldApplyField(cur, incomingVersion)) {
          task.dueAt = payload.fields.dueAt;
          fieldVersions.set('dueAt', incomingVersion);
          changed = true;
        }
      }

      if (changed) {
        task.updatedAt = event.createdAt;
        result.updatedTasks.push(task);
      }
      break;
    }

    case 'TASK_ARCHIVED': {
      const taskId = event.entityId ?? (event.payload as { taskId?: string }).taskId;
      if (!taskId) break;

      const task = state.tasks.get(taskId);
      if (!task) break;

      task.archived = true;
      task.updatedAt = event.createdAt;
      result.updatedTasks.push(task);
      break;
    }

    case 'CHAT_MESSAGE_SENT': {
      const payload = event.payload as { messageId?: string; body: string };
      const message: Message = {
        id: payload.messageId ?? event.id,
        channelId: event.channelId,
        kind: 'USER',
        authorDeviceId: event.authorDeviceId,
        body: payload.body,
        createdAt: event.createdAt,
        pending: false,
      };
      // Duplicate suppression by message ID
      if (!state.messages.some((m) => m.id === message.id)) {
        state.messages.push(message);
        result.updatedMessages.push(message);
      }
      break;
    }
  }

  return result;
}
