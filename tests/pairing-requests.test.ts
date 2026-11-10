import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodicRepository } from '../src/db/repository';
import { nativeSync } from '../src/services/native-sync';

async function pair() {
  localStorage.clear();
  const a = new NodicRepository();
  await a.init('Alice');
  const idA = await a.getIdentity();
  localStorage.clear();
  const b = new NodicRepository();
  await b.init('Bob');
  const idB = await b.getIdentity();
  // A discovers B nearby
  await a.savePeerIdentity({
    deviceId: idB.deviceId,
    displayName: 'Bob',
    publicSigningKey: idB.publicSigningKey,
    serviceName: null,
    host: '192.168.1.21',
    port: 41002,
    status: 'ONLINE',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  });
  const nodicB = `nodic-${idB.deviceId.slice(0, 8)}`;
  return { a, b, idA, idB, nodicB };
}

describe('Pairing request delivery and pooling', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('reports SEND_FAILED and rolls back when the request cannot be delivered', async () => {
    const { a, nodicB, idB } = await pair();
    vi.spyOn(nativeSync, 'sendPairingRequest').mockResolvedValue({ sent: false, requestId: 'x' });
    const [res] = await a.requestPairingByNodicIds(nodicB);
    expect(res.status).toBe('SEND_FAILED');
    const dev = (await a.listPairedDevices()).find((d) => d.deviceId === idB.deviceId);
    expect(dev?.pairingState).not.toBe('PENDING_OUTBOUND');
    const reqs = await a.listPairingRequests();
    expect(reqs.filter((r) => r.status === 'PENDING')).toHaveLength(0);
  });

  it('re-sends the same pending request instead of stacking duplicates', async () => {
    const { a, nodicB } = await pair();
    const spy = vi.spyOn(nativeSync, 'sendPairingRequest');
    const [first] = await a.requestPairingByNodicIds(nodicB);
    const [second] = await a.requestPairingByNodicIds(nodicB);
    expect(first.status).toBe('REQUEST_SENT');
    expect(second.request?.requestId).toBe(first.request?.requestId);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await a.listPairingRequests()).filter((r) => r.direction === 'OUTBOUND')).toHaveLength(1);
  });

  it('retryPendingOutboundPairings re-offers pending requests to nearby peers only', async () => {
    const { a, nodicB } = await pair();
    await a.requestPairingByNodicIds(nodicB);
    const spy = vi.spyOn(nativeSync, 'sendPairingRequest');
    expect(await a.retryPendingOutboundPairings()).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a duplicate of an answered request keeps its answer and never demotes a paired device', async () => {
    const { b, idA } = await pair();
    const payload = {
      requestId: 'req-1',
      fromDeviceId: idA.deviceId,
      fromDisplayName: 'Alice',
      fromPublicKey: idA.publicSigningKey,
      host: '192.168.1.20',
      port: 41001,
    };
    await b.receiveIncomingPairingRequest(payload);
    await b.respondToPairingRequest('req-1', true);
    await b.receiveIncomingPairingRequest(payload); // re-delivered
    const req = (await b.listPairingRequests()).find((r) => r.requestId === 'req-1');
    expect(req?.status).toBe('ACCEPTED');
    const dev = (await b.listPairedDevices()).find((d) => d.deviceId === idA.deviceId);
    expect(dev?.pairingState).toBe('PAIRED');

    // A brand new request from an already paired device must not demote it either
    await b.receiveIncomingPairingRequest({ ...payload, requestId: 'req-2' });
    expect((await b.listPairedDevices()).find((d) => d.deviceId === idA.deviceId)?.pairingState).toBe('PAIRED');
  });

  it('a newer inbound request supersedes older pending ones from the same device', async () => {
    const { b, idA } = await pair();
    const base = {
      fromDeviceId: idA.deviceId,
      fromDisplayName: 'Alice',
      fromPublicKey: idA.publicSigningKey,
      host: '192.168.1.20',
      port: 41001,
    };
    await b.receiveIncomingPairingRequest({ ...base, requestId: 'old' });
    await b.receiveIncomingPairingRequest({ ...base, requestId: 'new' });
    const pending = (await b.listPairingRequests()).filter((r) => r.status === 'PENDING');
    expect(pending.map((r) => r.requestId)).toEqual(['new']);
  });

  it('reports delivery failure when answering, but keeps the local decision', async () => {
    const { b, idA } = await pair();
    await b.receiveIncomingPairingRequest({
      requestId: 'r',
      fromDeviceId: idA.deviceId,
      fromDisplayName: 'Alice',
      fromPublicKey: idA.publicSigningKey,
      host: '192.168.1.20',
      port: 41001,
    });
    vi.spyOn(nativeSync, 'sendPairingResponse').mockResolvedValue({ sent: false, requestId: 'r', accepted: true });
    const res = await b.respondToPairingRequest('r', true);
    expect(res).toMatchObject({ accepted: true, delivered: false });
    expect((await b.listPairedDevices()).find((d) => d.deviceId === idA.deviceId)?.pairingState).toBe('PAIRED');
  });
});
