import type { NodicEvent, SyncSummary } from '../../../protocol/contracts';

export interface MissingRange {
  authorDeviceId: string;
  fromSequence: number;
  toSequence: number;
}

export const MAX_BATCH_EVENTS = 100;
export const MAX_FRAME_BYTES = 262_144; // 256 KiB

/**
 * Computes the highest contiguous sequence (starting from 1) for each author.
 * If author has [1, 2, 3, 5], highest contiguous is 3 (seq 4 is a gap).
 */
export function calculateContiguousSummary(events: Array<{ authorDeviceId: string; authorSequence: number }>): Record<string, number> {
  const sequencesByAuthor = new Map<string, Set<number>>();

  for (const event of events) {
    let set = sequencesByAuthor.get(event.authorDeviceId);
    if (!set) {
      set = new Set<number>();
      sequencesByAuthor.set(event.authorDeviceId, set);
    }
    set.add(event.authorSequence);
  }

  const result: Record<string, number> = {};

  for (const [author, seqSet] of sequencesByAuthor.entries()) {
    let contiguous = 0;
    while (seqSet.has(contiguous + 1)) {
      contiguous += 1;
    }
    result[author] = contiguous;
  }

  return result;
}

/**
 * Compares local summary with peer summary to determine what events Local has that Peer is missing.
 */
export function computeMissingRangesForPeer(
  localSummary: Record<string, number>,
  peerSummary: Record<string, number>,
): MissingRange[] {
  const ranges: MissingRange[] = [];

  for (const [author, localContiguous] of Object.entries(localSummary)) {
    const peerContiguous = peerSummary[author] ?? 0;
    if (localContiguous > peerContiguous) {
      ranges.push({
        authorDeviceId: author,
        fromSequence: peerContiguous + 1,
        toSequence: localContiguous,
      });
    }
  }

  return ranges;
}

/**
 * Selects events from local storage matching the missing ranges for a peer,
 * bounded by MAX_BATCH_EVENTS and ordered by Lamport clock and sequence.
 */
export function selectEventsForRanges(
  allEvents: NodicEvent[],
  ranges: MissingRange[],
  limit = MAX_BATCH_EVENTS,
): NodicEvent[] {
  const rangeMap = new Map<string, { from: number; to: number }>();
  for (const r of ranges) {
    rangeMap.set(r.authorDeviceId, { from: r.fromSequence, to: r.toSequence });
  }

  const selected = allEvents.filter((ev) => {
    const target = rangeMap.get(ev.authorDeviceId);
    if (!target) return false;
    return ev.authorSequence >= target.from && ev.authorSequence <= target.to;
  });

  // Sort deterministically: Lamport clock first, then authorSequence
  selected.sort((a, b) => {
    if (a.lamportClock !== b.lamportClock) return a.lamportClock - b.lamportClock;
    return a.authorSequence - b.authorSequence;
  });

  return selected.slice(0, limit);
}

/**
 * Chunks events into batches of at most batchSize.
 */
export function chunkEvents(events: NodicEvent[], batchSize = MAX_BATCH_EVENTS): NodicEvent[][] {
  const batches: NodicEvent[][] = [];
  for (let i = 0; i < events.length; i += batchSize) {
    batches.push(events.slice(i, i + batchSize));
  }
  return batches;
}
