import { describe, expect, it } from 'vitest';
import type { NodicEvent } from '../protocol/contracts';
import {
  calculateContiguousSummary,
  chunkEvents,
  computeMissingRangesForPeer,
  createAckFrame,
  createBatchFrame,
  createErrorFrame,
  createSummaryFrame,
  filterPeersForRelay,
  reconcileSummaries,
  selectEventsForRanges,
  triageIncomingBatch,
  validateEventEnvelope,
  MAX_FRAME_BYTES,
} from '../src/domain/sync/sync-engine';
import { NodicRepository } from '../src/db/repository';

function createMockEvent(
  authorDeviceId: string,
  authorSequence: number,
  lamportClock = authorSequence,
  overrides: Partial<NodicEvent> = {},
): NodicEvent {
  return {
    protocolVersion: 1,
    id: overrides.id ?? `evt-${authorDeviceId}-${authorSequence}`,
    channelId: overrides.channelId ?? 'chan-alpha',
    authorDeviceId,
    authorSequence,
    lamportClock,
    type: overrides.type ?? 'TASK_CREATED',
    keyVersion: 1,
    createdAt: new Date(1700000000000 + lamportClock * 1000).toISOString(),
    payloadVersion: 1,
    payload: overrides.payload ?? {
      id: `task-${authorDeviceId}-${authorSequence}`,
      title: `Task ${authorSequence} by ${authorDeviceId}`,
      status: 'TODO',
      priority: 'MEDIUM',
    },
    signature: `sig-${authorDeviceId}-${authorSequence}`,
    ...overrides,
  };
}

describe('Phase 2: Peer Synchronization Protocol', () => {
  describe('Wire Frame Validation & Generation', () => {
    it('creates and validates SUMMARY frame matching protocol schema', () => {
      const summaryFrame = createSummaryFrame('chan-alpha', {
        'dev-lead': 10,
        'dev-alice': 4,
      });

      expect(summaryFrame.kind).toBe('SUMMARY');
      expect(summaryFrame.summary.channelId).toBe('chan-alpha');
      expect(summaryFrame.summary.sequences['dev-lead']).toBe(10);
      expect(summaryFrame.summary.sequences['dev-alice']).toBe(4);
      expect(summaryFrame.requestId).toBeDefined();
    });

    it('creates and validates EVENT_BATCH frame matching protocol schema', () => {
      const ev1 = createMockEvent('dev-lead', 1);
      const ev2 = createMockEvent('dev-lead', 2);
      const batchFrame = createBatchFrame([ev1, ev2]);

      expect(batchFrame.kind).toBe('EVENT_BATCH');
      expect(batchFrame.events).toHaveLength(2);
      expect(batchFrame.events[0].id).toBe('evt-dev-lead-1');
    });

    it('rejects batch frame exceeding MAX_BATCH_EVENTS', () => {
      const oversized = Array.from({ length: 101 }, (_, i) => createMockEvent('dev-lead', i + 1));
      expect(() => createBatchFrame(oversized)).toThrow(/exceeds max limit/);
    });

    it('creates and validates ACK and ERROR frames', () => {
      const ackFrame = createAckFrame('chan-alpha', { 'dev-lead': 5 }, 'req-123');
      expect(ackFrame.kind).toBe('ACK');
      expect(ackFrame.requestId).toBe('req-123');
      expect(ackFrame.summary.sequences['dev-lead']).toBe(5);

      const errFrame = createErrorFrame('RATE_LIMITED', 'Too many requests from peer', 'req-456');
      expect(errFrame.kind).toBe('ERROR');
      expect(errFrame.code).toBe('RATE_LIMITED');
    });
  });

  describe('Envelope Validation & Limits', () => {
    it('accepts valid envelope', () => {
      const ev = createMockEvent('dev-lead', 1);
      const res = validateEventEnvelope(ev);
      expect(res.valid).toBe(true);
    });

    it('rejects non-object or null input', () => {
      expect(validateEventEnvelope(null).valid).toBe(false);
      expect(validateEventEnvelope('not an event').valid).toBe(false);
    });

    it('rejects unsupported protocol version', () => {
      const ev = createMockEvent('dev-lead', 1, 1, { protocolVersion: 2 as any });
      const res = validateEventEnvelope(ev);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toMatch(/protocolVersion/);
      }
    });

    it('rejects payload exceeding chat limit', () => {
      const longChat = 'A'.repeat(4001);
      const ev = createMockEvent('dev-lead', 1, 1, {
        type: 'CHAT_MESSAGE_SENT',
        payload: { body: longChat },
      });
      const res = validateEventEnvelope(ev);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.code).toBe('CHAT_LIMIT_EXCEEDED');
      }
    });

    it('rejects payload exceeding task title limit', () => {
      const longTitle = 'T'.repeat(201);
      const ev = createMockEvent('dev-lead', 1, 1, {
        type: 'TASK_CREATED',
        payload: { title: longTitle, status: 'TODO', priority: 'LOW' },
      });
      const res = validateEventEnvelope(ev);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.code).toBe('TITLE_LIMIT_EXCEEDED');
      }
    });
  });

  describe('Bidirectional Summary Reconciliation', () => {
    it('correctly calculates bidirectional missing ranges', () => {
      const localSummary = {
        'node-a': 5, // Local has 5, Peer has 2 -> Local owes Peer 3..5
        'node-b': 3, // Local has 3, Peer has 8 -> Peer owes Local 4..8
        'node-c': 4, // Local has 4, Peer has 4 -> in sync
      };
      const peerSummary = {
        'node-a': 2,
        'node-b': 8,
        'node-c': 4,
      };

      const result = reconcileSummaries(localSummary, peerSummary);

      expect(result.isInSync).toBe(false);
      expect(result.outgoingRanges).toEqual([
        { authorDeviceId: 'node-a', fromSequence: 3, toSequence: 5 },
      ]);
      expect(result.incomingRanges).toEqual([
        { authorDeviceId: 'node-b', fromSequence: 4, toSequence: 8 },
      ]);
    });

    it('identifies when peers are fully synchronized', () => {
      const summary = { 'node-a': 10, 'node-b': 5 };
      const result = reconcileSummaries(summary, summary);
      expect(result.isInSync).toBe(true);
      expect(result.outgoingRanges).toHaveLength(0);
      expect(result.incomingRanges).toHaveLength(0);
    });
  });

  describe('Incoming Batch Triage & Duplicate Suppression', () => {
    it('partitions batch into accepted, duplicates, and quarantined sequence reuses', () => {
      const existingIds = new Set<string>(['evt-dev-1-1']);
      const existingSeqs = new Map<string, string>([
        ['chan-alpha:dev-1:1', 'evt-dev-1-1'],
        ['chan-alpha:dev-1:2', 'evt-dev-1-2'],
      ]);

      const rawBatch = [
        // 1. Exact duplicate (should be duplicate no-op)
        createMockEvent('dev-1', 1, 1, { id: 'evt-dev-1-1' }),
        // 2. Sequence reuse with different event ID (should be quarantined)
        createMockEvent('dev-1', 2, 2, { id: 'evt-dev-1-2-conflict-attacker' }),
        // 3. Valid new event (should be accepted)
        createMockEvent('dev-1', 3, 3, { id: 'evt-dev-1-3' }),
      ];

      const triage = triageIncomingBatch(rawBatch, existingIds, existingSeqs);

      expect(triage.duplicates).toHaveLength(1);
      expect(triage.duplicates[0].id).toBe('evt-dev-1-1');

      expect(triage.quarantined).toHaveLength(1);
      expect(triage.quarantined[0].code).toBe('SEQUENCE_REUSED');

      expect(triage.accepted).toHaveLength(1);
      expect(triage.accepted[0].id).toBe('evt-dev-1-3');
    });
  });

  describe('Multi-Peer Relay Loop Prevention', () => {
    it('excludes immediate sender and local node from relay recipient list', () => {
      const allPeers = ['node-peer-a', 'node-peer-b', 'node-peer-c'];
      const sender = 'node-peer-a';
      const local = 'node-local';

      const relayRecipients = filterPeersForRelay(
        [...allPeers, local],
        sender,
        local,
      );

      // Should only relay to peer-b and peer-c
      expect(relayRecipients).toEqual(['node-peer-b', 'node-peer-c']);
      expect(relayRecipients).not.toContain('node-peer-a');
      expect(relayRecipients).not.toContain('node-local');
    });
  });

  describe('Repository End-to-End Duplicate Suppression & Multi-Node Convergence', () => {
    it('ignores exact duplicate events without error or duplicate state', async () => {
      const repo = new NodicRepository();
      await repo.init('Test Node');
      const { snapshot: ws } = await repo.createChannel('Sync Room', 'Phase 2 testing');

      const event = createMockEvent('remote-author', 1, 1, {
        channelId: ws.channel!.id,
        type: 'CHAT_MESSAGE_SENT',
        payload: { body: 'Hello LAN team!' },
      });

      // Apply first time
      const snap1 = await repo.applyEvent(event);
      expect(snap1.messages.filter((m) => m.id === event.id)).toHaveLength(1);

      // Apply second time (exact duplicate)
      const snap2 = await repo.applyEvent(event);
      expect(snap2.messages.filter((m) => m.id === event.id)).toHaveLength(1);

      // Apply third time
      const snap3 = await repo.applyEvent(event);
      expect(snap3.messages.filter((m) => m.id === event.id)).toHaveLength(1);
    });

    it('quarantines sequence reuse and prevents state corruption', async () => {
      const repo = new NodicRepository();
      await repo.init('Node Beta');
      const { snapshot: ws } = await repo.createChannel('Audit Room', 'Audit testing');

      const originalEvent = createMockEvent('author-x', 1, 1, {
        id: 'evt-original',
        channelId: ws.channel!.id,
        type: 'TASK_CREATED',
        payload: { id: 'task-1', title: 'Legitimate Task', status: 'TODO', priority: 'LOW' },
      });

      await repo.applyEvent(originalEvent);

      // Conflicting event reusing sequence 1 with different ID and title
      const conflictingEvent = createMockEvent('author-x', 1, 2, {
        id: 'evt-conflicting-malicious',
        channelId: ws.channel!.id,
        type: 'TASK_CREATED',
        payload: { id: 'task-1', title: 'Overwritten Malicious Title', status: 'DONE', priority: 'URGENT' },
      });

      const snapAfterConflict = await repo.applyEvent(conflictingEvent);

      // Original task is preserved unchanged
      const task = snapAfterConflict.tasks.find((t) => t.id === 'task-1');
      expect(task?.title).toBe('Legitimate Task');
      expect(task?.status).toBe('TODO');

      // The conflicting event was recorded into rejected events
      const rejected = await repo.listRejectedEvents();
      expect(rejected.some((r) => r.eventId === 'evt-conflicting-malicious')).toBe(true);
      expect(rejected.find((r) => r.eventId === 'evt-conflicting-malicious')?.reasonCode).toBe('SEQUENCE_REUSED');
    });

    it('reconciles vector summaries and transfers missing events between nodes', async () => {
      const repoA = new NodicRepository();
      await repoA.init('Node A');
      const { snapshot: wsA } = await repoA.createChannel('Convergence Channel', 'Reconciliation test');
      const channelId = wsA.channel!.id;

      // Node A creates 2 tasks locally
      await repoA.commitLocalEvent(
        channelId,
        'TASK_CREATED',
        { id: 'task-a1', title: 'Task A1', status: 'TODO', priority: 'HIGH' },
        'task-a1',
      );
      await repoA.commitLocalEvent(
        channelId,
        'TASK_CREATED',
        { id: 'task-a2', title: 'Task A2', status: 'TODO', priority: 'MEDIUM' },
        'task-a2',
      );

      const summaryA = await repoA.getSyncSummary(channelId);

      // Node B starts with empty channel
      const repoB = new NodicRepository();
      await repoB.init('Node B');
      const summaryB = await repoB.getSyncSummary(channelId);

      // Node A reconciles with Node B's empty summary
      const { eventsToSend } = await repoA.reconcileWithPeerSummary(channelId, 'node-b-id', summaryB);
      expect(eventsToSend.length).toBeGreaterThanOrEqual(2);

      // Node B applies the missing events
      const snapB = await repoB.applyBatch(eventsToSend);

      // Node B now has both tasks from Node A
      expect(snapB.tasks.map((t) => t.title)).toContain('Task A1');
      expect(snapB.tasks.map((t) => t.title)).toContain('Task A2');

      // Confirm Node B's contiguous summary now matches Node A
      const updatedSummaryB = await repoB.getSyncSummary(channelId);
      const diff = reconcileSummaries(summaryA, updatedSummaryB);
      expect(diff.isInSync).toBe(true);
    });
  });
});
