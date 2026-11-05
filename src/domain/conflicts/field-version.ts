export interface FieldVersion {
  lamportClock: number;
  actorDeviceId: string;
  eventId: string;
}

export function compareFieldVersions(a: FieldVersion, b: FieldVersion): number {
  if (a.lamportClock !== b.lamportClock) return a.lamportClock - b.lamportClock;
  const actorOrder = a.actorDeviceId.localeCompare(b.actorDeviceId);
  if (actorOrder !== 0) return actorOrder;
  return a.eventId.localeCompare(b.eventId);
}

export function shouldApplyField(current: FieldVersion | null, incoming: FieldVersion): boolean {
  return current === null || compareFieldVersions(incoming, current) > 0;
}
