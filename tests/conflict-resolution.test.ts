import { describe, expect, it } from 'vitest';
import { compareFieldVersions, shouldApplyField } from '../src/domain/conflicts/field-version';

describe('field conflict resolution', () => {
  it('prefers the greatest Lamport clock', () => {
    expect(compareFieldVersions(
      { lamportClock: 8, actorDeviceId: 'a', eventId: '1' },
      { lamportClock: 7, actorDeviceId: 'z', eventId: '9' },
    )).toBeGreaterThan(0);
  });

  it('breaks equal-clock ties deterministically', () => {
    const current = { lamportClock: 8, actorDeviceId: 'device-a', eventId: 'event-z' };
    const incoming = { lamportClock: 8, actorDeviceId: 'device-b', eventId: 'event-a' };
    expect(shouldApplyField(current, incoming)).toBe(true);
  });

  it('accepts the first field version', () => {
    expect(shouldApplyField(null, { lamportClock: 1, actorDeviceId: 'a', eventId: '1' })).toBe(true);
  });
});
