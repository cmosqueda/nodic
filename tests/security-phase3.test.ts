import { describe, expect, it } from 'vitest';
import { NodicRepository } from '../src/db/repository';
import {
  decryptPayload,
  encryptPayload,
  generateChannelKey,
  generateDeviceKeyPair,
  signEvent,
  verifyEventSignature,
} from '../src/domain/crypto/crypto-engine';
import { parseInvitationCode } from '../src/domain/invitations/invitation-codec';
import type { NodicEvent } from '../protocol/contracts';

describe('Phase 3: Security, Membership Governance, and Cryptography', () => {
  describe('ECDSA P-256 Event Signatures & Tamper Resistance', () => {
    it('signs events with authentic ECDSA P-256 and verifies against author public key', async () => {
      const repo = new NodicRepository();
      await repo.init('Alice Security Lead');
      const identity = await repo.getIdentity();

      expect(identity.publicSigningKey.startsWith('p256:')).toBe(true);

      const { snapshot: ws, genesisEvent } = await repo.createChannel('Secure Operations', 'Phase 3 Channel');
      const channelId = ws.channel!.id;

      // Verify genesis event signature against Alice's public key
      const isGenesisValid = await verifyEventSignature(genesisEvent, identity.publicSigningKey);
      expect(isGenesisValid).toBe(true);

      // Create a task
      const { event: taskEvent } = await repo.commitLocalEvent(
        channelId,
        'TASK_CREATED',
        { id: 'sec-task-1', title: 'Audit firewall rules', status: 'TODO', priority: 'URGENT' },
        'sec-task-1',
      );

      const isTaskValid = await verifyEventSignature(taskEvent, identity.publicSigningKey);
      expect(isTaskValid).toBe(true);
    });

    it('quarantines events with invalid or tampered signatures', async () => {
      const repo = new NodicRepository();
      await repo.init('Bob Verifier');
      const { snapshot: ws } = await repo.createChannel('Verification Room');
      const channelId = ws.channel!.id;

      const attackerKeys = await generateDeviceKeyPair();

      const legitimateKeys = await generateDeviceKeyPair();

      // Event claims to be by legitimate author, but signed by attacker's private key
      const fakeEventWithoutSig: Omit<NodicEvent, 'signature'> = {
        protocolVersion: 1,
        id: 'evt-spoofed-1',
        channelId,
        authorDeviceId: 'legit-device',
        authorSequence: 1,
        lamportClock: 1,
        type: 'CHAT_MESSAGE_SENT',
        keyVersion: 1,
        createdAt: new Date().toISOString(),
        payloadVersion: 1,
        payload: { body: 'Impersonated message' },
      };

      const forgedSignature = await signEvent(fakeEventWithoutSig, attackerKeys.privateKey);
      const forgedEvent: NodicEvent = {
        ...fakeEventWithoutSig,
        signature: forgedSignature,
      };

      // Add legit-device to peer identities with legitimate public key
      await repo.savePeerIdentity({
        deviceId: 'legit-device',
        displayName: 'Legitimate User',
        publicSigningKey: legitimateKeys.publicKey,
        serviceName: 'legit',
        host: '192.168.1.50',
        port: 8443,
        status: 'ONLINE',
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      });

      // Attempt to apply the forged event
      const snapshotAfterAttack = await repo.applyEvent(forgedEvent);

      // Event must NOT appear in messages
      expect(snapshotAfterAttack.messages.some((m) => m.id === 'evt-spoofed-1')).toBe(false);

      // Forged event must be recorded into rejected events
      const rejected = await repo.listRejectedEvents();
      expect(rejected.some((r) => r.eventId === 'evt-spoofed-1')).toBe(true);
      expect(rejected.find((r) => r.eventId === 'evt-spoofed-1')?.reasonCode).toBe('INVALID_SIGNATURE');
    });
  });

  describe('Member Removal & Revocation (Forward Secrecy)', () => {
    it('revokes removed member, rejects subsequent events, and rotates channel key', async () => {
      const repo = new NodicRepository();
      await repo.init('Lead Officer');
      const { snapshot: ws } = await repo.createChannel('Tactical Unit');
      const channelId = ws.channel!.id;

      const memberKeys = await generateDeviceKeyPair();
      const memberDeviceId = 'dev-contractor-1';

      // 1. Add member
      await repo.applyEvent({
        protocolVersion: 1,
        id: 'evt-member-join',
        channelId,
        authorDeviceId: 'lead-officer',
        authorSequence: 2,
        lamportClock: 2,
        type: 'MEMBER_ADDED',
        keyVersion: 1,
        createdAt: new Date().toISOString(),
        payloadVersion: 1,
        payload: {
          deviceId: memberDeviceId,
          displayName: 'Contractor Bob',
          publicSigningKey: memberKeys.publicKey,
          role: 'MEMBER',
        },
        signature: 'sig-mock',
      });

      const memberWorkspace = await repo.loadWorkspace(channelId);
      expect(memberWorkspace.channel?.members.some((m) => m.deviceId === memberDeviceId)).toBe(true);

      // 2. Member creates a valid task before removal
      const preRemovalTask: NodicEvent = {
        protocolVersion: 1,
        id: 'evt-contractor-task',
        channelId,
        authorDeviceId: memberDeviceId,
        authorSequence: 1,
        lamportClock: 3,
        type: 'TASK_CREATED',
        keyVersion: 1,
        createdAt: new Date().toISOString(),
        payloadVersion: 1,
        payload: { id: 'task-pre', title: 'Task completed while employed', status: 'DONE', priority: 'LOW' },
        signature: 'sig-mock',
      };
      await repo.applyEvent(preRemovalTask);
      const wsWithTask = await repo.loadWorkspace(channelId);
      expect(wsWithTask.tasks.some((t) => t.id === 'task-pre')).toBe(true);

      // 3. Lead removes contractor
      await repo.applyEvent({
        protocolVersion: 1,
        id: 'evt-member-removed',
        channelId,
        authorDeviceId: 'lead-officer',
        authorSequence: 3,
        lamportClock: 4,
        type: 'MEMBER_REMOVED',
        keyVersion: 1,
        createdAt: new Date().toISOString(),
        payloadVersion: 1,
        payload: { deviceId: memberDeviceId, displayName: 'Contractor Bob' },
        signature: 'sig-mock',
      });

      // Member is removed from active channel list
      const postRemovalWs = await repo.loadWorkspace(channelId);
      expect(postRemovalWs.channel?.members.some((m) => m.deviceId === memberDeviceId)).toBe(false);
      // Activity log message exists
      expect(postRemovalWs.messages.some((m) => m.body.includes('Contractor Bob was removed'))).toBe(true);

      // 4. Contractor attempts to author an event AFTER being removed
      const postRemovalMaliciousEvent: NodicEvent = {
        protocolVersion: 1,
        id: 'evt-malicious-post-removal',
        channelId,
        authorDeviceId: memberDeviceId,
        authorSequence: 2,
        lamportClock: 10,
        type: 'CHAT_MESSAGE_SENT',
        keyVersion: 1,
        createdAt: new Date().toISOString(),
        payloadVersion: 1,
        payload: { body: 'Unauthorized post-removal broadcast' },
        signature: 'sig-mock',
      };

      await repo.applyEvent(postRemovalMaliciousEvent);

      // Event is rejected and not in messages
      const finalWs = await repo.loadWorkspace(channelId);
      expect(finalWs.messages.some((m) => m.id === 'evt-malicious-post-removal')).toBe(false);

      // Event is quarantined as AUTHOR_REVOKED
      const rejected = await repo.listRejectedEvents();
      expect(rejected.some((r) => r.eventId === 'evt-malicious-post-removal')).toBe(true);
      expect(rejected.find((r) => r.eventId === 'evt-malicious-post-removal')?.reasonCode).toBe('AUTHOR_REVOKED');
    });

    it('rotates channel key to version 2, protecting future traffic from removed member', async () => {
      const repo = new NodicRepository();
      await repo.init('Lead Officer');
      const { snapshot: ws } = await repo.createChannel('Confidential Desk');
      const channelId = ws.channel!.id;

      expect(repo.getActiveKeyVersion(channelId)).toBe(1);
      const keyVersion1 = repo.getChannelKey(channelId, 1);
      expect(keyVersion1).toBeDefined();

      // Lead rotates key
      const { event: rotationEvent, newKeyVersion, newKey } = await repo.rotateChannelKey(channelId);
      expect(newKeyVersion).toBe(2);
      expect(repo.getActiveKeyVersion(channelId)).toBe(2);
      expect(newKey).not.toBe(keyVersion1);

      // Encrypt payload under key version 2
      const futureData = { body: 'Top secret strategy post-rotation' };
      const encrypted = await encryptPayload(futureData, newKey);

      // Holder of old keyVersion 1 CANNOT decrypt keyVersion 2 data
      await expect(
        decryptPayload(encrypted.ciphertext, encrypted.nonce, keyVersion1!),
      ).rejects.toThrow();

      // Holder of newKey CAN decrypt
      const decrypted = await decryptPayload<typeof futureData>(
        encrypted.ciphertext,
        encrypted.nonce,
        newKey,
      );
      expect(decrypted).toEqual(futureData);
    });
  });

  describe('Invitation Secret Hashing & Join Request Workflow', () => {
    it('creates invitation code, verifies secret hash, and admits member', async () => {
      const leadRepo = new NodicRepository();
      await leadRepo.init('Channel Lead');
      const { snapshot: ws } = await leadRepo.createChannel('Invitation Channel');
      const channelId = ws.channel!.id;

      // 1. Lead creates copyable invitation code
      const invitationCode = await leadRepo.createInvitation(channelId, 24);
      expect(invitationCode.startsWith('nodic:v1:')).toBe(true);

      const parsed = parseInvitationCode(invitationCode);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      const applicantKeys = await generateDeviceKeyPair();

      // 2. Applicant submits join request with matching secret
      const joinResult = await leadRepo.processJoinRequest({
        channelId,
        invitationId: parsed.invitation.invitationId,
        joinSecret: parsed.invitation.joinSecret,
        applicantDeviceId: 'dev-applicant-99',
        applicantDisplayName: 'Applicant Charlie',
        applicantPublicKey: applicantKeys.publicKey,
      });

      expect(joinResult.accepted).toBe(true);
      expect(joinResult.memberEvent).toBeDefined();
      expect(joinResult.channelKey).toBeDefined();

      // Lead's state has approved Charlie
      const updatedWs = await leadRepo.loadWorkspace(channelId);
      expect(updatedWs.channel?.members.some((m) => m.deviceId === 'dev-applicant-99')).toBe(true);
    });

    it('rejects join request with invalid or tampered secret', async () => {
      const leadRepo = new NodicRepository();
      await leadRepo.init('Strict Lead');
      const { snapshot: ws } = await leadRepo.createChannel('Strict Channel');
      const channelId = ws.channel!.id;

      const invitationCode = await leadRepo.createInvitation(channelId, 24);
      const parsed = parseInvitationCode(invitationCode);
      if (!parsed.success) return;

      // Attacker attempts to guess/tamper with join secret
      const badJoinResult = await leadRepo.processJoinRequest({
        channelId,
        invitationId: parsed.invitation.invitationId,
        joinSecret: 'f'.repeat(64), // Incorrect secret
        applicantDeviceId: 'dev-attacker',
        applicantDisplayName: 'Intruder',
        applicantPublicKey: 'p256:attacker',
      });

      expect(badJoinResult.accepted).toBe(false);
      expect(badJoinResult.reason).toContain('Invalid invitation secret');

      // Attacker is NOT added as a member
      const wsAfterAttempt = await leadRepo.loadWorkspace(channelId);
      expect(wsAfterAttempt.channel?.members.some((m) => m.deviceId === 'dev-attacker')).toBe(false);
    });
  });
});
