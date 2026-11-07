import {
  nodicEventSchema,
  peerFrameSchema,
  PROTOCOL_VERSION,
  type NodicEvent,
  type PeerFrame,
  type SyncSummary,
} from '../../../protocol/contracts';

export interface MissingRange {
  authorDeviceId: string;
  fromSequence: number;
  toSequence: number;
}

export const MAX_BATCH_EVENTS = 100;
export const MAX_FRAME_BYTES = 262_144; // 256 KiB
export const MAX_CHAT_LENGTH = 4000;
export const MAX_TASK_TITLE_LENGTH = 200;
export const MAX_TASK_DESC_LENGTH = 20_000;
export const MAX_DISPLAY_NAME_LENGTH = 80;

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

export interface SummaryReconciliationResult {
  outgoingRanges: MissingRange[];
  incomingRanges: MissingRange[];
  isInSync: boolean;
}

/**
 * Reconciles two summaries bidirectionally:
 * - outgoingRanges: events local has that peer is missing.
 * - incomingRanges: events peer has that local is missing.
 */
export function reconcileSummaries(
  localSummary: Record<string, number>,
  peerSummary: Record<string, number>,
): SummaryReconciliationResult {
  const outgoingRanges = computeMissingRangesForPeer(localSummary, peerSummary);
  const incomingRanges = computeMissingRangesForPeer(peerSummary, localSummary);
  return {
    outgoingRanges,
    incomingRanges,
    isInSync: outgoingRanges.length === 0 && incomingRanges.length === 0,
  };
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

export type EventValidationResult =
  | { valid: true; event: NodicEvent }
  | { valid: false; reason: string; code: string };

/**
 * Validates envelope size, protocol version, and schema according to SPEC 12.1 & 12.3.
 */
export function validateEventEnvelope(input: unknown): EventValidationResult {
  if (typeof input !== 'object' || input === null) {
    return { valid: false, reason: 'Event must be a non-null object', code: 'INVALID_OBJECT' };
  }

  const rawJson = JSON.stringify(input);
  if (new TextEncoder().encode(rawJson).length > MAX_FRAME_BYTES) {
    return { valid: false, reason: `Event exceeds maximum frame limit of ${MAX_FRAME_BYTES} bytes`, code: 'FRAME_LIMIT_EXCEEDED' };
  }

  const parsed = nodicEventSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return { valid: false, reason: `${firstIssue.path.join('.')}: ${firstIssue.message}`, code: 'SCHEMA_VIOLATION' };
  }

  const event = parsed.data;

  // Content limit checks per PROTOCOL.md
  if (event.type === 'CHAT_MESSAGE_SENT') {
    const body = (event.payload as { body?: string }).body;
    if (typeof body === 'string' && body.length > MAX_CHAT_LENGTH) {
      return { valid: false, reason: `Chat message exceeds ${MAX_CHAT_LENGTH} characters`, code: 'CHAT_LIMIT_EXCEEDED' };
    }
  }

  if (event.type === 'TASK_CREATED') {
    const title = (event.payload as { title?: string }).title;
    const desc = (event.payload as { description?: string }).description;
    if (typeof title === 'string' && title.length > MAX_TASK_TITLE_LENGTH) {
      return { valid: false, reason: `Task title exceeds ${MAX_TASK_TITLE_LENGTH} characters`, code: 'TITLE_LIMIT_EXCEEDED' };
    }
    if (typeof desc === 'string' && desc.length > MAX_TASK_DESC_LENGTH) {
      return { valid: false, reason: `Task description exceeds ${MAX_TASK_DESC_LENGTH} characters`, code: 'DESC_LIMIT_EXCEEDED' };
    }
  }

  return { valid: true, event };
}

export interface BatchTriageResult {
  accepted: NodicEvent[];
  duplicates: NodicEvent[];
  quarantined: Array<{ event: NodicEvent | unknown; reason: string; code: string }>;
}

/**
 * Triages an incoming event batch:
 * 1. Validates envelope & schema.
 * 2. Identifies exact duplicates (no-op).
 * 3. Identifies sequence reuse with conflicting IDs (quarantined).
 * 4. Accepts valid new events.
 */
export function triageIncomingBatch(
  rawEvents: unknown[],
  existingEventIds: Set<string>,
  existingSequenceMap: Map<string, string>, // key: `${channelId}:${authorDeviceId}:${authorSequence}` -> value: existingEventId
): BatchTriageResult {
  const accepted: NodicEvent[] = [];
  const duplicates: NodicEvent[] = [];
  const quarantined: Array<{ event: NodicEvent | unknown; reason: string; code: string }> = [];

  for (const raw of rawEvents) {
    const validation = validateEventEnvelope(raw);
    if (!validation.valid) {
      quarantined.push({ event: raw, reason: validation.reason, code: validation.code });
      continue;
    }

    const event = validation.event;

    // Rule 3: Exact duplicates are successful no-ops
    if (existingEventIds.has(event.id)) {
      duplicates.push(event);
      continue;
    }

    // Rule 7: Confirm author sequence has not been reused with different content
    const seqKey = `${event.channelId}:${event.authorDeviceId}:${event.authorSequence}`;
    const existingId = existingSequenceMap.get(seqKey);
    if (existingId && existingId !== event.id) {
      quarantined.push({
        event,
        reason: `Author sequence ${event.authorSequence} for author ${event.authorDeviceId} reused with different event id (existing: ${existingId})`,
        code: 'SEQUENCE_REUSED',
      });
      continue;
    }

    // Mark as seen in this batch
    existingEventIds.add(event.id);
    existingSequenceMap.set(seqKey, event.id);
    accepted.push(event);
  }

  return { accepted, duplicates, quarantined };
}

/**
 * Filter peers for relaying an event, excluding the original author and immediate sender
 * to prevent broadcast echo loops.
 */
export function filterPeersForRelay(
  connectedPeerDeviceIds: string[],
  senderPeerDeviceId: string,
  localDeviceId: string,
): string[] {
  return connectedPeerDeviceIds.filter(
    (id) => id !== senderPeerDeviceId && id !== localDeviceId,
  );
}

export type SummaryFrame = Extract<PeerFrame, { kind: 'SUMMARY' }>;
export type BatchFrame = Extract<PeerFrame, { kind: 'EVENT_BATCH' }>;
export type AckFrame = Extract<PeerFrame, { kind: 'ACK' }>;
export type ErrorFrame = Extract<PeerFrame, { kind: 'ERROR' }>;

// Wire Frame Helpers matching protocol/contracts.ts peerFrameSchema
export function createSummaryFrame(
  channelId: string,
  sequences: Record<string, number>,
  requestId = crypto.randomUUID(),
): SummaryFrame {
  const frame: PeerFrame = {
    kind: 'SUMMARY',
    requestId,
    summary: {
      channelId,
      sequences,
    },
  };
  return peerFrameSchema.parse(frame) as SummaryFrame;
}

export function createBatchFrame(
  events: NodicEvent[],
  requestId = crypto.randomUUID(),
): BatchFrame {
  if (events.length > MAX_BATCH_EVENTS) {
    throw new Error(`Batch size ${events.length} exceeds max limit of ${MAX_BATCH_EVENTS}`);
  }
  const frame: PeerFrame = {
    kind: 'EVENT_BATCH',
    requestId,
    events,
  };
  return peerFrameSchema.parse(frame) as BatchFrame;
}

export function createAckFrame(
  channelId: string,
  sequences: Record<string, number>,
  requestId: string,
): AckFrame {
  const frame: PeerFrame = {
    kind: 'ACK',
    requestId,
    summary: {
      channelId,
      sequences,
    },
  };
  return peerFrameSchema.parse(frame) as AckFrame;
}

export function createErrorFrame(
  code: string,
  message: string,
  requestId?: string,
): ErrorFrame {
  const frame: PeerFrame = {
    kind: 'ERROR',
    requestId,
    code,
    message,
  };
  return peerFrameSchema.parse(frame) as ErrorFrame;
}

