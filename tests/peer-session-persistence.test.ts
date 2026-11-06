import { beforeEach, describe, expect, it } from 'vitest';
import { NodicRepository } from '../src/db/repository';
import {
  peerIdentitySchema,
  peerSessionSchema,
  syncLogSchema,
} from '../protocol/contracts';

describe('Two-Peer Identity, Session, Log & Event Synchronization', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  });

  it('persists device identity, peer identities, sessions, and sync logs on both connected peer devices', async () => {
    // Peer A initialization
    const peerARepo = new NodicRepository();
    await peerARepo.init('Alice Lead');
    const idA = await peerARepo.getIdentity();
    expect(idA.displayName).toBe('Alice Lead');
    expect(idA.publicSigningKey).toMatch(/^p256:/);

    // Clear shared browser localStorage before initializing Peer B in the same JS environment
    if (typeof localStorage !== 'undefined') localStorage.clear();

    // Peer B initialization
    const peerBRepo = new NodicRepository();
    await peerBRepo.init('Bob Member');
    const idB = await peerBRepo.getIdentity();
    expect(idB.displayName).toBe('Bob Member');
    expect(idB.deviceId).not.toBe(idA.deviceId);
    expect(idB.publicSigningKey).toMatch(/^p256:/);

    // Simulate bidirectional HELLO / HELLO_ACK handshake between Peer A (192.168.1.10:41001) and Peer B (192.168.1.11:41002)
    const sessionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // Peer A saves Peer B's identity, outbound session, and handshake log
    const savedPeerOnA = await peerARepo.savePeerIdentity({
      deviceId: idB.deviceId,
      displayName: idB.displayName,
      publicSigningKey: idB.publicSigningKey,
      serviceName: `nodic-${idB.deviceId.slice(0, 8)}`,
      host: '192.168.1.11',
      port: 41002,
      status: 'ONLINE',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
    expect(peerIdentitySchema.parse(savedPeerOnA).deviceId).toBe(idB.deviceId);

    const savedSessionOnA = await peerARepo.savePeerSession({
      id: sessionId,
      peerDeviceId: idB.deviceId,
      peerDisplayName: idB.displayName,
      peerPublicKey: idB.publicSigningKey,
      peerAddress: '192.168.1.11',
      peerPort: 41002,
      direction: 'OUTBOUND',
      status: 'CONNECTED',
      startedAt: nowIso,
      lastActivityAt: nowIso,
      endedAt: null,
      eventsSent: 1,
      eventsReceived: 1,
    });
    expect(peerSessionSchema.parse(savedSessionOnA).direction).toBe('OUTBOUND');

    const logOnA = await peerARepo.recordSyncLog({
      level: 'INFO',
      category: 'SESSION',
      peerDeviceId: idB.deviceId,
      sessionId,
      message: `Outbound session established with ${idB.displayName}`,
      detailsJson: JSON.stringify({ peerDeviceId: idB.deviceId }),
    });
    expect(syncLogSchema.parse(logOnA).category).toBe('SESSION');

    // Peer B saves Peer A's identity, inbound session, and handshake log
    const savedPeerOnB = await peerBRepo.savePeerIdentity({
      deviceId: idA.deviceId,
      displayName: idA.displayName,
      publicSigningKey: idA.publicSigningKey,
      serviceName: `nodic-${idA.deviceId.slice(0, 8)}`,
      host: '192.168.1.10',
      port: 41001,
      status: 'ONLINE',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
    expect(peerIdentitySchema.parse(savedPeerOnB).deviceId).toBe(idA.deviceId);

    const savedSessionOnB = await peerBRepo.savePeerSession({
      id: sessionId,
      peerDeviceId: idA.deviceId,
      peerDisplayName: idA.displayName,
      peerPublicKey: idA.publicSigningKey,
      peerAddress: '192.168.1.10',
      peerPort: 41001,
      direction: 'INBOUND',
      status: 'CONNECTED',
      startedAt: nowIso,
      lastActivityAt: nowIso,
      endedAt: null,
      eventsSent: 1,
      eventsReceived: 1,
    });
    expect(peerSessionSchema.parse(savedSessionOnB).direction).toBe('INBOUND');

    await peerBRepo.recordSyncLog({
      level: 'INFO',
      category: 'SESSION',
      peerDeviceId: idA.deviceId,
      sessionId,
      message: `Inbound session established with ${idA.displayName}`,
      detailsJson: JSON.stringify({ peerDeviceId: idA.deviceId }),
    });

    // Verify both peers have each other's identity, session, and logs saved
    const peersOnA = await peerARepo.listPeerIdentities();
    const sessionsOnA = await peerARepo.listPeerSessions();
    const logsOnA = await peerARepo.listSyncLogs();
    expect(peersOnA).toHaveLength(1);
    expect(peersOnA[0].displayName).toBe('Bob Member');
    expect(sessionsOnA).toHaveLength(1);
    expect(sessionsOnA[0].id).toBe(sessionId);
    expect(logsOnA.some((l) => l.category === 'SESSION')).toBe(true);
    expect(logsOnA.some((l) => l.category === 'IDENTITY')).toBe(true);

    const peersOnB = await peerBRepo.listPeerIdentities();
    const sessionsOnB = await peerBRepo.listPeerSessions();
    const logsOnB = await peerBRepo.listSyncLogs();
    expect(peersOnB).toHaveLength(1);
    expect(peersOnB[0].displayName).toBe('Alice Lead');
    expect(sessionsOnB).toHaveLength(1);
    expect(sessionsOnB[0].id).toBe(sessionId);
    expect(logsOnB.some((l) => l.category === 'SESSION')).toBe(true);

    // Peer A creates a channel and task, Peer B joins and syncs
    const { genesisEvent, snapshot: snapA1 } = await peerARepo.createChannel(
      'Engineering Ops',
      'Core systems sync',
    );
    const channelId = snapA1.channel!.id;

    // Peer B joins channel and sends MEMBER_ADDED
    await peerBRepo.joinChannel(channelId);
    const { event: memberJoinEvent } = await peerBRepo.commitLocalEvent(
      channelId,
      'MEMBER_ADDED',
      {
        deviceId: idB.deviceId,
        displayName: idB.displayName,
        role: 'MEMBER',
        publicKey: idB.publicSigningKey,
      },
      idB.deviceId,
    );

    // Peer A receives Peer B's MEMBER_ADDED event
    const snapA2 = await peerARepo.applyEvent(memberJoinEvent);
    expect(snapA2.channel?.members).toHaveLength(2);
    expect(snapA2.channel?.members.map((m) => m.displayName)).toContain('Bob Member');

    // Peer A sends genesis and full channel batch to Peer B
    const snapB2 = await peerBRepo.applyEvent(genesisEvent);
    expect(snapB2.channel?.name).toBe('Engineering Ops');
    expect(snapB2.channel?.members).toHaveLength(2);
    expect(snapB2.channel?.members.map((m) => m.displayName)).toEqual(
      expect.arrayContaining(['Alice Lead', 'Bob Member']),
    );
  });
});
