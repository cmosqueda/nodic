import { describe, expect, it, beforeEach } from 'vitest';
import { NotificationManager } from '../src/domain/notifications/notification-manager';
import { nativeSync } from '../src/services/native-sync';

describe('Phase 4: Background Behavior & Local Notifications', () => {
  let manager: NotificationManager;
  const currentDeviceId = 'device-alice-123';

  beforeEach(() => {
    manager = new NotificationManager(100);
  });

  describe('Notification Deduplication (Rule 8.7)', () => {
    it('deduplicates notifications by event ID', () => {
      const eventId = 'ev-unique-101';
      expect(manager.shouldNotify(eventId)).toBe(true);
      expect(manager.hasNotified(eventId)).toBe(true);

      // Subsequent attempt with identical event ID is suppressed
      expect(manager.shouldNotify(eventId)).toBe(false);
    });

    it('allows different event IDs', () => {
      expect(manager.shouldNotify('ev-1')).toBe(true);
      expect(manager.shouldNotify('ev-2')).toBe(true);
      expect(manager.shouldNotify('ev-1')).toBe(false);
      expect(manager.shouldNotify('ev-2')).toBe(false);
    });

    it('enforces bounded history memory via LRU eviction', () => {
      const smallManager = new NotificationManager(3);
      smallManager.shouldNotify('ev-1');
      smallManager.shouldNotify('ev-2');
      smallManager.shouldNotify('ev-3');

      expect(smallManager.hasNotified('ev-1')).toBe(true);
      // Adding a 4th should evict ev-1
      smallManager.shouldNotify('ev-4');
      expect(smallManager.hasNotified('ev-1')).toBe(false);
      expect(smallManager.hasNotified('ev-4')).toBe(true);
    });
  });

  describe('Chat Notifications and Route Suppression (SPEC 8.7)', () => {
    it('generates a chat notification when screen is not visible or on another tab', () => {
      const event = {
        id: 'msg-event-1',
        type: 'MESSAGE_POSTED',
        channelId: 'ch-alpha',
        authorDeviceId: 'device-bob-456',
        payload: { text: 'Hello team on local Wi-Fi!' },
      };

      const notification = manager.evaluateEventNotification({
        event,
        currentDeviceId,
        senderDisplayName: 'Bob',
        isAppInForeground: true,
        activeRoute: '/board',
      });

      expect(notification).not.toBeNull();
      expect(notification?.channel).toBe('nodic_messages');
      expect(notification?.route).toBe('/chat');
      expect(notification?.title).toBe('Bob');
      expect(notification?.body).toBe('Hello team on local Wi-Fi!');
      expect(notification?.channelId).toBe('ch-alpha');
      expect(notification?.eventId).toBe('msg-event-1');
    });

    it('suppresses chat notification when app is in foreground and actively viewing /chat', () => {
      const event = {
        id: 'msg-event-2',
        type: 'MESSAGE_POSTED',
        channelId: 'ch-alpha',
        authorDeviceId: 'device-bob-456',
        payload: { text: 'Are you looking at chat?' },
      };

      const notification = manager.evaluateEventNotification({
        event,
        currentDeviceId,
        senderDisplayName: 'Bob',
        isAppInForeground: true,
        activeRoute: '/chat',
      });

      expect(notification).toBeNull();
    });

    it('does not suppress chat notification when app is in background even if last route was /chat', () => {
      const event = {
        id: 'msg-event-3',
        type: 'MESSAGE_POSTED',
        channelId: 'ch-alpha',
        authorDeviceId: 'device-bob-456',
        payload: { text: 'Background notification' },
      };

      const notification = manager.evaluateEventNotification({
        event,
        currentDeviceId,
        senderDisplayName: 'Bob',
        isAppInForeground: false,
        activeRoute: '/chat',
      });

      expect(notification).not.toBeNull();
      expect(notification?.route).toBe('/chat');
    });

    it('never notifies for own authored messages', () => {
      const event = {
        id: 'msg-event-own',
        type: 'MESSAGE_POSTED',
        channelId: 'ch-alpha',
        authorDeviceId: currentDeviceId,
        payload: { text: 'My own message' },
      };

      const notification = manager.evaluateEventNotification({
        event,
        currentDeviceId,
        senderDisplayName: 'Alice',
        isAppInForeground: false,
      });

      expect(notification).toBeNull();
    });
  });

  describe('Task Notifications (SPEC 8.7)', () => {
    it('notifies when a task is assigned to the current user with deep link to /board', () => {
      const event = {
        id: 'task-event-1',
        type: 'TASK_CREATED',
        channelId: 'ch-alpha',
        entityId: 'task-77',
        authorDeviceId: 'device-bob-456',
        payload: {
          id: 'task-77',
          title: 'Review network logs',
          assigneeDeviceId: currentDeviceId,
        },
      };

      const notification = manager.evaluateEventNotification({
        event,
        currentDeviceId,
        senderDisplayName: 'Bob',
      });

      expect(notification).not.toBeNull();
      expect(notification?.channel).toBe('nodic_tasks');
      expect(notification?.title).toBe('Task Assigned');
      expect(notification?.body).toContain("Bob assigned you: 'Review network logs'");
      expect(notification?.route).toBe('/board');
      expect(notification?.taskId).toBe('task-77');
    });

    it('does not notify if task is assigned to a different user', () => {
      const event = {
        id: 'task-event-other',
        type: 'TASK_CREATED',
        channelId: 'ch-alpha',
        entityId: 'task-88',
        authorDeviceId: 'device-bob-456',
        payload: {
          id: 'task-88',
          title: 'Task for Charlie',
          assigneeDeviceId: 'device-charlie-789',
        },
      };

      const notification = manager.evaluateEventNotification({
        event,
        currentDeviceId,
        senderDisplayName: 'Bob',
      });

      expect(notification).toBeNull();
    });

    it('notifies upon task completion (transition to DONE)', () => {
      const event = {
        id: 'task-event-done',
        type: 'TASK_MUTATED',
        channelId: 'ch-alpha',
        entityId: 'task-77',
        authorDeviceId: 'device-bob-456',
        payload: {
          id: 'task-77',
          title: 'Review network logs',
          status: 'DONE',
        },
      };

      const notification = manager.evaluateEventNotification({
        event,
        currentDeviceId,
        senderDisplayName: 'Bob',
      });

      expect(notification).not.toBeNull();
      expect(notification?.channel).toBe('nodic_tasks');
      expect(notification?.title).toBe('Task Completed');
      expect(notification?.body).toContain("Bob completed: 'Review network logs'");
      expect(notification?.route).toBe('/board');
    });
  });

  describe('Membership and Join Requests (SPEC 8.7)', () => {
    it('notifies lead device on incoming join request with deep link to /members', () => {
      const notification = manager.evaluateJoinRequest({
        requestId: 'join-req-999',
        channelId: 'ch-alpha',
        applicantDisplayName: 'David',
      });

      expect(notification).not.toBeNull();
      expect(notification?.channel).toBe('nodic_membership');
      expect(notification?.title).toBe('Join Request');
      expect(notification?.body).toBe('David requested to join channel');
      expect(notification?.route).toBe('/members');
      expect(notification?.channelId).toBe('ch-alpha');

      // Re-evaluating the same join request is deduplicated
      const dupe = manager.evaluateJoinRequest({
        requestId: 'join-req-999',
        channelId: 'ch-alpha',
        applicantDisplayName: 'David',
      });
      expect(dupe).toBeNull();
    });
  });

  describe('Battery Optimization Status Fallback', () => {
    it('returns web preview battery status when not running on native Android', async () => {
      const status = await nativeSync.getBatteryOptimizationStatus();
      expect(status.ignoringBatteryOptimizations).toBe(true);
      expect(status.canRequest).toBe(false);
    });

    it('handles requestIgnoreBatteryOptimizations gracefully on browser', async () => {
      const result = await nativeSync.requestIgnoreBatteryOptimizations();
      expect(result.launched).toBe(false);
    });
  });
});
