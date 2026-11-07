export interface ContentNotification {
  id: string;
  channel: 'nodic_foreground' | 'nodic_messages' | 'nodic_tasks' | 'nodic_membership';
  title: string;
  body: string;
  route: '/board' | '/chat' | '/members' | '/network';
  channelId?: string;
  eventId?: string;
  taskId?: string;
}

export class NotificationManager {
  private notifiedEventIds = new Set<string>();
  private maxHistorySize: number;

  constructor(maxHistorySize = 1000) {
    this.maxHistorySize = maxHistorySize;
  }

  shouldNotify(eventId: string): boolean {
    if (!eventId) return false;
    if (this.notifiedEventIds.has(eventId)) return false;
    if (this.notifiedEventIds.size >= this.maxHistorySize) {
      const oldest = this.notifiedEventIds.values().next().value;
      if (oldest) this.notifiedEventIds.delete(oldest);
    }
    this.notifiedEventIds.add(eventId);
    return true;
  }

  hasNotified(eventId: string): boolean {
    return this.notifiedEventIds.has(eventId);
  }

  evaluateEventNotification(options: {
    event: {
      id: string;
      type: string;
      channelId?: string;
      entityId?: string;
      authorDeviceId: string;
      payload: any;
    };
    currentDeviceId: string;
    senderDisplayName?: string;
    isAppInForeground?: boolean;
    activeRoute?: string;
  }): ContentNotification | null {
    const { event, currentDeviceId, senderDisplayName, isAppInForeground, activeRoute } = options;
    if (!event.id) return null;
    if (event.authorDeviceId === currentDeviceId) return null;
    if (!this.shouldNotify(event.id)) return null;

    const sender = senderDisplayName || 'Nodic member';
    const channelId = event.channelId;

    switch (event.type) {
      case 'MESSAGE_POSTED': {
        if (isAppInForeground && activeRoute === '/chat') {
          return null;
        }
        return {
          id: event.id,
          channel: 'nodic_messages',
          title: sender,
          body: event.payload?.text || 'Sent a message',
          route: '/chat',
          channelId,
          eventId: event.id,
        };
      }
      case 'TASK_CREATED': {
        const assignee = event.payload?.assigneeDeviceId;
        const title = event.payload?.title || 'Untitled task';
        const taskId = event.entityId || event.payload?.id;
        if (assignee === currentDeviceId) {
          return {
            id: event.id,
            channel: 'nodic_tasks',
            title: 'Task Assigned',
            body: `${sender} assigned you: '${title}'`,
            route: '/board',
            channelId,
            eventId: event.id,
            taskId,
          };
        }
        return null;
      }
      case 'TASK_MUTATED': {
        const status = event.payload?.status;
        const assignee = event.payload?.assigneeDeviceId;
        const title = event.payload?.title || 'task';
        const taskId = event.entityId || event.payload?.id;

        if (status === 'DONE') {
          return {
            id: event.id,
            channel: 'nodic_tasks',
            title: 'Task Completed',
            body: `${sender} completed: '${title}'`,
            route: '/board',
            channelId,
            eventId: event.id,
            taskId,
          };
        }

        if (assignee === currentDeviceId) {
          return {
            id: event.id,
            channel: 'nodic_tasks',
            title: 'Task Updated',
            body: `${sender} updated: '${title}'`,
            route: '/board',
            channelId,
            eventId: event.id,
            taskId,
          };
        }
        return null;
      }
      case 'MEMBER_ADDED':
      case 'MEMBER_JOINED': {
        const name = event.payload?.displayName || sender;
        return {
          id: event.id,
          channel: 'nodic_membership',
          title: 'New Member',
          body: `${name} joined the channel`,
          route: '/members',
          channelId,
          eventId: event.id,
        };
      }
      default:
        return null;
    }
  }

  evaluateJoinRequest(options: {
    requestId: string;
    channelId: string;
    applicantDisplayName: string;
  }): ContentNotification | null {
    const { requestId, channelId, applicantDisplayName } = options;
    if (!this.shouldNotify(requestId)) return null;
    return {
      id: requestId,
      channel: 'nodic_membership',
      title: 'Join Request',
      body: `${applicantDisplayName} requested to join channel`,
      route: '/members',
      channelId,
      eventId: requestId,
    };
  }

  clearHistory(): void {
    this.notifiedEventIds.clear();
  }
}
