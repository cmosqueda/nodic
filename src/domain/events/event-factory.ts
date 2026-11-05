import type { EventType, NodicEvent } from '../../../protocol/contracts';

export interface EventClock {
  nextSequence(): number;
  tick(): number;
}

export function createUnsignedEvent(options: {
  channelId: string;
  authorDeviceId: string;
  type: EventType;
  entityId?: string;
  payload: Record<string, unknown>;
  clock: EventClock;
  now?: Date;
}): Omit<NodicEvent, 'signature'> {
  return {
    protocolVersion: 1,
    id: crypto.randomUUID(),
    channelId: options.channelId,
    authorDeviceId: options.authorDeviceId,
    authorSequence: options.clock.nextSequence(),
    lamportClock: options.clock.tick(),
    type: options.type,
    entityId: options.entityId,
    keyVersion: 1,
    createdAt: (options.now ?? new Date()).toISOString(),
    payloadVersion: 1,
    payload: options.payload,
  };
}
