import { describe, expect, it } from 'vitest';
import type { NodicEvent } from '../protocol/contracts';
import {
  calculateContiguousSummary,
  chunkEvents,
  computeMissingRangesForPeer,
  selectEventsForRanges,
} from '../src/domain/sync/sync-engine';

function mockEvent(author: string, seq: number, clock = seq): NodicEvent {
  return {
    protocolVersion: 1,
    id: `evt-${author}-${seq}`,
    channelId: 'chan-1',
    authorDeviceId: author,
    authorSequence: seq,
    lamportClock: clock,
    type: 'TASK_CREATED',
    keyVersion: 1,
    createdAt: new Date().toISOString(),
    payloadVersion: 1,
    payload: { title: `Task ${seq}` },
    signature: 'sig',
  };
}

describe('Sync Engine & Vector Range Calculation', () => {
  it('computes highest contiguous sequence per author stopping at gaps', () => {
    const events = [
      { authorDeviceId: 'dev-1', authorSequence: 1 },
      { authorDeviceId: 'dev-1', authorSequence: 2 },
      { authorDeviceId: 'dev-1', authorSequence: 3 },
      { authorDeviceId: 'dev-1', authorSequence: 5 }, // gap: 4 is missing
      { authorDeviceId: 'dev-2', authorSequence: 2 }, // gap: 1 is missing
      { authorDeviceId: 'dev-3', authorSequence: 1 },
    ];

    const summary = calculateContiguousSummary(events);
    expect(summary['dev-1']).toBe(3);
    expect(summary['dev-2']).toBe(0);
    expect(summary['dev-3']).toBe(1);
    expect(summary['dev-unknown']).toBeUndefined();
  });

  it('computes missing ranges that Local needs to send to Peer', () => {
    const localSummary = {
      'dev-lead': 10,
      'dev-member': 5,
      'dev-guest': 2,
    };

    const peerSummary = {
      'dev-lead': 6,  // missing 7..10
      'dev-member': 5, // up to date
      // dev-guest is missing completely: 1..2
    };

    const ranges = computeMissingRangesForPeer(localSummary, peerSummary);

    expect(ranges).toHaveLength(2);
    expect(ranges).toContainEqual({
      authorDeviceId: 'dev-lead',
      fromSequence: 7,
      toSequence: 10,
    });
    expect(ranges).toContainEqual({
      authorDeviceId: 'dev-guest',
      fromSequence: 1,
      toSequence: 2,
    });
  });

  it('selects and orders events matching missing ranges within batch limits', () => {
    const allEvents = [
      mockEvent('dev-lead', 1, 1),
      mockEvent('dev-lead', 2, 2),
      mockEvent('dev-lead', 3, 5),
      mockEvent('dev-lead', 4, 6),
      mockEvent('dev-member', 1, 3),
      mockEvent('dev-member', 2, 4),
    ];

    const ranges = [
      { authorDeviceId: 'dev-lead', fromSequence: 2, toSequence: 4 },
      { authorDeviceId: 'dev-member', fromSequence: 2, toSequence: 2 },
    ];

    const selected = selectEventsForRanges(allEvents, ranges, 10);

    expect(selected).toHaveLength(4);
    // Verified correct IDs selected
    const ids = selected.map((e) => e.id);
    expect(ids).toEqual([
      'evt-dev-lead-2',   // clock 2
      'evt-dev-member-2', // clock 4
      'evt-dev-lead-3',   // clock 5
      'evt-dev-lead-4',   // clock 6
    ]);
  });

  it('chunks large event lists into bounded batches of at most 100', () => {
    const manyEvents = Array.from({ length: 250 }, (_, i) => mockEvent('dev-1', i + 1));
    const batches = chunkEvents(manyEvents, 100);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toHaveLength(100);
    expect(batches[2]).toHaveLength(50);
  });
});
