import { describe, expect, it } from 'vitest';
import type { NodicEvent } from '../protocol/contracts';
import { applyEventToState, createInitialMaterializedState } from '../src/domain/reducers/event-reducer';
import type { Channel } from '../src/domain/models';

function mockEvent(overrides: Partial<NodicEvent>): NodicEvent {
  return {
    protocolVersion: 1,
    id: crypto.randomUUID(),
    channelId: 'chan-1',
    authorDeviceId: 'device-lead',
    authorSequence: 1,
    lamportClock: 1,
    type: 'TASK_CREATED',
    keyVersion: 1,
    createdAt: new Date().toISOString(),
    payloadVersion: 1,
    payload: {},
    signature: 'mock-sig',
    ...overrides,
  };
}

describe('Event Reducers & Projection Pipeline', () => {
  const initialChannel: Channel = {
    id: 'chan-1',
    name: 'Ops Alpha',
    description: 'Main ops',
    currentUserDeviceId: 'device-lead',
    members: [
      { deviceId: 'device-lead', displayName: 'Lead User', role: 'LEAD', presence: 'ONLINE', initials: 'LU' },
      { deviceId: 'device-member', displayName: 'Member One', role: 'MEMBER', presence: 'ONLINE', initials: 'MO' },
    ],
  };

  it('handles TASK_CREATED event properly', () => {
    const state = createInitialMaterializedState(initialChannel);
    const event = mockEvent({
      type: 'TASK_CREATED',
      payload: {
        id: 'task-100',
        title: 'Fix server room wiring',
        description: 'Rack 4 needs cable ties',
        status: 'TODO',
        priority: 'HIGH',
        assigneeDeviceId: 'device-member',
      },
    });

    const result = applyEventToState(state, event);
    expect(result.updatedTasks).toHaveLength(1);
    expect(state.tasks.get('task-100')?.title).toBe('Fix server room wiring');
    expect(state.tasks.get('task-100')?.status).toBe('TODO');
    expect(state.tasks.get('task-100')?.priority).toBe('HIGH');
  });

  it('generates deterministic system message upon first transition to DONE', () => {
    const state = createInitialMaterializedState(initialChannel);
    // Create task
    applyEventToState(state, mockEvent({
      type: 'TASK_CREATED',
      payload: { id: 'task-200', title: 'Deploy patch', status: 'IN_PROGRESS' },
    }));

    // Status changed to DONE
    const doneEvent = mockEvent({
      id: 'event-done-1',
      type: 'TASK_STATUS_CHANGED',
      entityId: 'task-200',
      authorDeviceId: 'device-member',
      lamportClock: 2,
      payload: { status: 'DONE' },
    });

    const result = applyEventToState(state, doneEvent);
    expect(state.tasks.get('task-200')?.status).toBe('DONE');
    expect(result.generatedSystemMessage).toBeDefined();
    expect(result.generatedSystemMessage?.body).toBe('Member One completed "Deploy patch".');
    expect(state.messages).toContainEqual(result.generatedSystemMessage);
  });

  it('resolves conflicting status updates deterministically using Lamport clocks', () => {
    const state = createInitialMaterializedState(initialChannel);
    applyEventToState(state, mockEvent({
      type: 'TASK_CREATED',
      payload: { id: 'task-300', title: 'Audit logs', status: 'TODO' },
    }));

    // Concurrent edit 1: lower clock
    const eventLowClock = mockEvent({
      type: 'TASK_STATUS_CHANGED',
      entityId: 'task-300',
      lamportClock: 5,
      payload: { status: 'IN_PROGRESS' },
    });

    // Concurrent edit 2: higher clock
    const eventHighClock = mockEvent({
      type: 'TASK_STATUS_CHANGED',
      entityId: 'task-300',
      lamportClock: 8,
      payload: { status: 'BLOCKED' },
    });

    // Apply high clock first
    applyEventToState(state, eventHighClock);
    expect(state.tasks.get('task-300')?.status).toBe('BLOCKED');

    // Apply low clock later (should lose and NOT overwrite)
    applyEventToState(state, eventLowClock);
    expect(state.tasks.get('task-300')?.status).toBe('BLOCKED');
  });

  it('adds and updates members', () => {
    const state = createInitialMaterializedState(initialChannel);
    const addMemberEvent = mockEvent({
      type: 'MEMBER_ADDED',
      payload: { deviceId: 'device-new', displayName: 'Dr. Jane', role: 'MEMBER' },
    });

    applyEventToState(state, addMemberEvent);
    expect(state.members.get('device-new')?.displayName).toBe('Dr. Jane');
    expect(state.members.get('device-new')?.role).toBe('MEMBER');

    const roleChangeEvent = mockEvent({
      type: 'MEMBER_ROLE_CHANGED',
      payload: { deviceId: 'device-new', role: 'CO_LEAD' },
    });

    applyEventToState(state, roleChangeEvent);
    expect(state.members.get('device-new')?.role).toBe('CO_LEAD');
  });

  it('suppresses duplicate chat messages by ID', () => {
    const state = createInitialMaterializedState(initialChannel);
    const chatEvent = mockEvent({
      id: 'msg-evt-1',
      type: 'CHAT_MESSAGE_SENT',
      payload: { messageId: 'msg-unique-1', body: 'Hello LAN' },
    });

    applyEventToState(state, chatEvent);
    expect(state.messages).toHaveLength(1);

    // Apply exact same message event again
    applyEventToState(state, chatEvent);
    expect(state.messages).toHaveLength(1);
  });
});
