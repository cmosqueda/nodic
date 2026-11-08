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

  it('retains channel, Kanban tasks, chat messages, member list, and recoverable sessionId across app restarts when offline', async () => {
    // 1. Channel Lead creates channel, tasks, and chat messages
    const leadRepo1 = new NodicRepository();
    await leadRepo1.init('Alice Lead');
    const leadId = await leadRepo1.getIdentity();

    const { snapshot: createdSnap } = await leadRepo1.createChannel(
      'Release Command',
      'Offline-first mobile release coordination',
    );
    const channelId = createdSnap.channel!.id;
    const sessionId = createdSnap.channel!.sessionId!;
    expect(sessionId).toMatch(/^sess-/);

    const taskId = crypto.randomUUID();
    await leadRepo1.commitLocalEvent(
      channelId,
      'TASK_CREATED',
      {
        id: taskId,
        title: 'Verify APK LAN sync',
        description: 'Ensure Device A and Device B sync bidirectionally',
        status: 'TODO',
        priority: 'HIGH',
        assigneeDeviceId: leadId.deviceId,
      },
      taskId,
    );

    await leadRepo1.commitLocalEvent(
      channelId,
      'TASK_STATUS_CHANGED',
      { taskId, status: 'IN_PROGRESS' },
      taskId,
    );

    const msgId = crypto.randomUUID();
    await leadRepo1.commitLocalEvent(channelId, 'CHAT_MESSAGE_SENT', {
      messageId: msgId,
      body: 'Channel lead initialized board; standing by for team.',
    });

    // 2. Simulate app closed & removed from Recents (completely new NodicRepository instance, offline)
    const leadRepoAfterRestart = new NodicRepository();
    const restoredSnap = await leadRepoAfterRestart.init();

    expect(restoredSnap.channel).not.toBeNull();
    expect(restoredSnap.channel!.id).toBe(channelId);
    expect(restoredSnap.channel!.sessionId).toBe(sessionId);
    expect(restoredSnap.channel!.name).toBe('Release Command');
    expect(restoredSnap.channel!.members).toHaveLength(1);
    expect(restoredSnap.channel!.members[0].displayName).toBe('Alice Lead');
    expect(restoredSnap.channel!.members[0].role).toBe('LEAD');

    expect(restoredSnap.tasks).toHaveLength(1);
    expect(restoredSnap.tasks[0].id).toBe(taskId);
    expect(restoredSnap.tasks[0].title).toBe('Verify APK LAN sync');
    expect(restoredSnap.tasks[0].status).toBe('IN_PROGRESS');

    expect(restoredSnap.messages.some((m) => m.body.includes('Channel lead initialized board'))).toBe(
      true,
    );

    // 3. Simulate session cut-off (leaveChannel) and recovery by sessionId
    await leadRepoAfterRestart.leaveChannel();
    const recoveredSnap = await leadRepoAfterRestart.recoverChannelSession(sessionId);
    expect(recoveredSnap.channel).not.toBeNull();
    expect(recoveredSnap.channel!.id).toBe(channelId);
    expect(recoveredSnap.channel!.sessionId).toBe(sessionId);
    expect(recoveredSnap.tasks).toHaveLength(1);
    expect(recoveredSnap.tasks[0].status).toBe('IN_PROGRESS');
  });

  it('synchronizes bidirectionally (Device A <-> Device B) when Device B joins via Device A invite code', async () => {
    const { parseInvitationCode } = await import('../src/domain/invitations/invitation-codec');

    // Device A (Lead) creates channel, a Kanban task, and a chat message before Device B joins
    const repoA = new NodicRepository();
    await repoA.init('Device A Lead');
    const idA = await repoA.getIdentity();

    const { snapshot: snapA0 } = await repoA.createChannel('Field Mesh Alpha', 'Two-device sync test');
    const channelId = snapA0.channel!.id;
    const sessionId = snapA0.channel!.sessionId!;

    const taskAId = crypto.randomUUID();
    await repoA.commitLocalEvent(
      channelId,
      'TASK_CREATED',
      {
        id: taskAId,
        title: 'Task from Device A',
        description: 'Created by Lead before Device B joined',
        status: 'TODO',
        priority: 'MEDIUM',
      },
      taskAId,
    );

    await repoA.commitLocalEvent(channelId, 'CHAT_MESSAGE_SENT', {
      messageId: crypto.randomUUID(),
      body: 'Hello from Device A!',
    });

    const inviteCode = await repoA.createInvitation(channelId, 24, '192.168.1.10:42110');
    const parsedInvite = parseInvitationCode(inviteCode);
    expect(parsedInvite.success).toBe(true);
    if (!parsedInvite.success) return;
    expect(parsedInvite.invitation.sessionId).toBe(sessionId);
    expect(parsedInvite.invitation.channelName).toBe('Field Mesh Alpha');
    expect(parsedInvite.invitation.leadDeviceId).toBe(idA.deviceId);
    expect(parsedInvite.invitation.leadPublicKey).toBe(idA.publicSigningKey);

    // Device B (Joiner) initializes and joins using Device A's invite code
    const repoB = new NodicRepository();
    await repoB.init('Device B Member');
    const idB = await repoB.getIdentity();

    await repoB.joinChannel(
      parsedInvite.invitation.channelId,
      parsedInvite.invitation.channelName,
      parsedInvite.invitation.leadDeviceId,
      {
        description: parsedInvite.invitation.channelDescription ?? null,
        sessionId: parsedInvite.invitation.sessionId,
        leadDisplayName: parsedInvite.invitation.leadDisplayName,
        leadPublicKey: parsedInvite.invitation.leadPublicKey,
      },
    );

    const { event: bJoinEvent } = await repoB.commitLocalEvent(
      channelId,
      'MEMBER_ADDED',
      {
        deviceId: idB.deviceId,
        displayName: idB.displayName,
        role: 'MEMBER',
        publicSigningKey: idB.publicSigningKey,
        publicKey: idB.publicSigningKey,
      },
      idB.deviceId,
    );

    // Device B sends MEMBER_ADDED to Device A
    await repoA.applyEvent(bJoinEvent);

    // Bidirectional summary reconciliation: Device B sends its summary to Device A
    const summaryB = await repoB.getSyncSummary(channelId);
    const { eventsToSend: fromAToB } = await repoA.reconcileWithPeerSummary(
      channelId,
      idB.deviceId,
      summaryB,
    );
    expect(fromAToB.length).toBeGreaterThanOrEqual(3); // CHANNEL_CREATED, TASK_CREATED, CHAT_MESSAGE_SENT

    // Device B applies batch from Device A
    const snapBAfterSync = await repoB.applyBatch(fromAToB);
    expect(snapBAfterSync.channel?.name).toBe('Field Mesh Alpha');
    expect(snapBAfterSync.channel?.sessionId).toBe(sessionId);
    expect(snapBAfterSync.channel?.members.map((m) => m.displayName)).toEqual(
      expect.arrayContaining(['Device A Lead', 'Device B Member']),
    );
    expect(snapBAfterSync.tasks.some((t) => t.title === 'Task from Device A')).toBe(true);
    expect(snapBAfterSync.messages.some((m) => m.body === 'Hello from Device A!')).toBe(true);

    // Now Device A sends a new task update and chat message to Device B, and Device B sends a message to Device A
    const { event: aMoveTask } = await repoA.commitLocalEvent(
      channelId,
      'TASK_STATUS_CHANGED',
      { taskId: taskAId, status: 'DONE' },
      taskAId,
    );
    const { event: bChat } = await repoB.commitLocalEvent(channelId, 'CHAT_MESSAGE_SENT', {
      messageId: crypto.randomUUID(),
      body: 'Confirmed on Device B!',
    });

    const finalSnapB = await repoB.applyEvent(aMoveTask);
    const finalSnapA = await repoA.applyEvent(bChat);

    expect(finalSnapB.tasks.find((t) => t.id === taskAId)?.status).toBe('DONE');
    expect(finalSnapA.tasks.find((t) => t.id === taskAId)?.status).toBe('DONE');
    expect(finalSnapA.messages.some((m) => m.body === 'Confirmed on Device B!')).toBe(true);
    expect(finalSnapB.messages.some((m) => m.body === 'Confirmed on Device B!')).toBe(true);
  });

  it('supports Bluetooth-style multi-peer pairing by Nodic User IDs, persistent saved connections, unilateral local disconnect, and re-pairing', async () => {
    const { formatNodicId } = await import('../src/db/repository');

    // Initialize User A, User B, and User C
    const repoA = new NodicRepository();
    await repoA.init('User A');
    const idA = await repoA.getIdentity();
    const nodicIdA = formatNodicId(idA.deviceId);

    if (typeof localStorage !== 'undefined') localStorage.clear();
    const repoB = new NodicRepository();
    await repoB.init('User B');
    const idB = await repoB.getIdentity();
    const nodicIdB = formatNodicId(idB.deviceId);

    if (typeof localStorage !== 'undefined') localStorage.clear();
    const repoC = new NodicRepository();
    await repoC.init('User C');
    const idC = await repoC.getIdentity();
    const nodicIdC = formatNodicId(idC.deviceId);

    const nowIso = new Date().toISOString();

    // User A discovers User B and User C as nearby devices on LAN
    await repoA.savePeerIdentity({
      deviceId: idB.deviceId,
      displayName: idB.displayName,
      publicSigningKey: idB.publicSigningKey,
      serviceName: nodicIdB,
      host: '192.168.1.21',
      port: 42111,
      status: 'ONLINE',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });
    await repoA.savePeerIdentity({
      deviceId: idC.deviceId,
      displayName: idC.displayName,
      publicSigningKey: idC.publicSigningKey,
      serviceName: nodicIdC,
      host: '192.168.1.22',
      port: 42112,
      status: 'ONLINE',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });

    // 1. User A inputs User B's and User C's Nodic User IDs (plus a non-existent nearby ID)
    const attemptResults = await repoA.requestPairingByNodicIds(
      `${nodicIdB}, ${nodicIdC}, nodic-99999999`,
    );
    expect(attemptResults).toHaveLength(3);
    expect(attemptResults[0].status).toBe('REQUEST_SENT');
    expect(attemptResults[0].nodicId).toBe(nodicIdB);
    expect(attemptResults[1].status).toBe('REQUEST_SENT');
    expect(attemptResults[1].nodicId).toBe(nodicIdC);
    expect(attemptResults[2].status).toBe('NOT_FOUND_NEARBY');

    // User A's saved devices are currently PENDING_OUTBOUND
    const pairedOnABeforeAccept = await repoA.listPairedDevices();
    expect(pairedOnABeforeAccept).toHaveLength(2);
    expect(
      pairedOnABeforeAccept.find((d) => d.deviceId === idB.deviceId)?.pairingState,
    ).toBe('PENDING_OUTBOUND');
    expect(
      pairedOnABeforeAccept.find((d) => d.deviceId === idC.deviceId)?.pairingState,
    ).toBe('PENDING_OUTBOUND');

    // 2. User B and User C receive User A's incoming connection requests and accept them
    const reqOnB = await repoB.receiveIncomingPairingRequest({
      requestId: attemptResults[0].request!.requestId,
      fromDeviceId: idA.deviceId,
      fromNodicId: nodicIdA,
      fromDisplayName: idA.displayName,
      fromPublicKey: idA.publicSigningKey,
      host: '192.168.1.20',
      port: 42110,
    });
    const respB = await repoB.respondToPairingRequest(reqOnB.requestId, true);
    expect(respB.accepted).toBe(true);
    expect(respB.pairedDevice?.pairingState).toBe('PAIRED');

    const reqOnC = await repoC.receiveIncomingPairingRequest({
      requestId: attemptResults[1].request!.requestId,
      fromDeviceId: idA.deviceId,
      fromNodicId: nodicIdA,
      fromDisplayName: idA.displayName,
      fromPublicKey: idA.publicSigningKey,
      host: '192.168.1.20',
      port: 42110,
    });
    const respC = await repoC.respondToPairingRequest(reqOnC.requestId, true);
    expect(respC.accepted).toBe(true);
    expect(respC.pairedDevice?.pairingState).toBe('PAIRED');

    // 3. User A receives the PAIR_RESPONSE from User B and User C
    await repoA.receivePairingResponse({
      requestId: reqOnB.requestId,
      fromDeviceId: idB.deviceId,
      fromNodicId: nodicIdB,
      fromDisplayName: idB.displayName,
      fromPublicKey: idB.publicSigningKey,
      host: '192.168.1.21',
      port: 42111,
      accepted: true,
    });
    await repoA.receivePairingResponse({
      requestId: reqOnC.requestId,
      fromDeviceId: idC.deviceId,
      fromNodicId: nodicIdC,
      fromDisplayName: idC.displayName,
      fromPublicKey: idC.publicSigningKey,
      host: '192.168.1.22',
      port: 42112,
      accepted: true,
    });

    // Verify all devices now have persistent saved connections in PAIRED state
    const pairedOnA = await repoA.listPairedDevices();
    expect(pairedOnA.find((d) => d.nodicId === nodicIdB)?.pairingState).toBe('PAIRED');
    expect(pairedOnA.find((d) => d.nodicId === nodicIdC)?.pairingState).toBe('PAIRED');

    const pairedOnB = await repoB.listPairedDevices();
    expect(pairedOnB.find((d) => d.nodicId === nodicIdA)?.pairingState).toBe('PAIRED');

    const pairedOnC = await repoC.listPairedDevices();
    expect(pairedOnC.find((d) => d.nodicId === nodicIdA)?.pairingState).toBe('PAIRED');

    // 4. Unilateral local disconnect: User A disconnects from User B
    const disconnectedRecord = await repoA.disconnectPeerLocally(nodicIdB);
    expect(disconnectedRecord?.pairingState).toBe('DISCONNECTED_LOCAL');

    // Disconnection is ONLY recorded on User A's device; User B still sees User A as PAIRED
    const pairedOnAAfterDisc = await repoA.listPairedDevices();
    expect(
      pairedOnAAfterDisc.find((d) => d.nodicId === nodicIdB)?.pairingState,
    ).toBe('DISCONNECTED_LOCAL');
    const pairedOnBAfterADisc = await repoB.listPairedDevices();
    expect(
      pairedOnBAfterADisc.find((d) => d.nodicId === nodicIdA)?.pairingState,
    ).toBe('PAIRED');

    // 5. Re-request and re-approve: User A resends connection request to User B and User B re-approves
    const reconnectAttempt = await repoA.requestPairingByNodicIds([nodicIdB]);
    expect(reconnectAttempt[0].status).toBe('REQUEST_SENT');

    const reReqOnB = await repoB.receiveIncomingPairingRequest({
      requestId: reconnectAttempt[0].request!.requestId,
      fromDeviceId: idA.deviceId,
      fromNodicId: nodicIdA,
      fromDisplayName: idA.displayName,
      fromPublicKey: idA.publicSigningKey,
      host: '192.168.1.20',
      port: 42110,
    });
    await repoB.respondToPairingRequest(reReqOnB.requestId, true);
    const reconnectedOnA = await repoA.receivePairingResponse({
      requestId: reReqOnB.requestId,
      fromDeviceId: idB.deviceId,
      fromNodicId: nodicIdB,
      fromDisplayName: idB.displayName,
      fromPublicKey: idB.publicSigningKey,
      host: '192.168.1.21',
      port: 42111,
      accepted: true,
    });
    expect(reconnectedOnA.pairingState).toBe('PAIRED');

    // 6. Invite-only channel scoping: creating a channel on User A does NOT add paired User B or User C
    const { snapshot: chSnapA } = await repoA.createChannel('Alpha Squad', 'Invite-only mesh room');
    const alphaChannelId = chSnapA.channel!.id;
    expect(repoA.getChannelRecipientIds(alphaChannelId)).toEqual([]);

    // User B joins via invite code using JOIN_REQUESTED handshake; User C remains outside the channel
    const { parseInvitationCode } = await import('../src/domain/invitations/invitation-codec');
    const codeForB = await repoA.createInvitation(alphaChannelId, 24);
    const parsedForB = parseInvitationCode(codeForB);
    expect(parsedForB.success).toBe(true);
    if (!parsedForB.success) return;

    const joinReqFromB = await repoB.buildJoinRequestEvent(alphaChannelId, {
      invitationId: parsedForB.invitation.invitationId,
      joinSecret: parsedForB.invitation.joinSecret,
    });
    const joinOutcome = await repoA.handleIncomingJoinRequest(joinReqFromB);
    expect(joinOutcome.accepted).toBe(true);
    expect(joinOutcome.memberEvent?.type).toBe('MEMBER_ADDED');

    // Only admitted member B is in channel recipients; paired peer C is excluded
    expect(repoA.getChannelRecipientIds(alphaChannelId)).toEqual([idB.deviceId]);
  });
});
