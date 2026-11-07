import { describe, expect, it } from 'vitest';
import {
  canonicalizeEventForSigning,
  canonicalizeJson,
  constantTimeCompare,
  decryptPayload,
  encryptPayload,
  generateChannelKey,
  generateDeviceKeyPair,
  hashSecret,
  signEvent,
  verifyEventSignature,
} from '../src/domain/crypto/crypto-engine';
import type { NodicEvent } from '../protocol/contracts';

describe('Phase 3: Cryptographic Engine', () => {
  describe('Canonical JSON & Envelope Normalization', () => {
    it('sorts keys lexicographically regardless of insertion order', () => {
      const objA = { z: 1, a: 2, m: { y: 'last', b: 'first' } };
      const objB = { a: 2, m: { b: 'first', y: 'last' }, z: 1 };

      const canonA = canonicalizeJson(objA);
      const canonB = canonicalizeJson(objB);

      expect(canonA).toBe(canonB);
      expect(canonA).toBe('{"a":2,"m":{"b":"first","y":"last"},"z":1}');
    });

    it('strips signature field when canonicalizing an event envelope', () => {
      const event: NodicEvent = {
        protocolVersion: 1,
        id: 'evt-100',
        channelId: 'chan-1',
        authorDeviceId: 'dev-1',
        authorSequence: 1,
        lamportClock: 1,
        type: 'CHAT_MESSAGE_SENT',
        keyVersion: 1,
        createdAt: '2026-11-07T10:00:00.000Z',
        payloadVersion: 1,
        payload: { body: 'hello' },
        signature: 'should-be-omitted-from-canonical-form',
      };

      const canonical = canonicalizeEventForSigning(event);
      expect(canonical).not.toContain('should-be-omitted');
      expect(canonical).toContain('"id":"evt-100"');
    });
  });

  describe('ECDSA P-256 Key Generation, Signing, and Verification', () => {
    it('generates valid EC P-256 keypair and signs/verifies events', async () => {
      const { publicKey, privateKey } = await generateDeviceKeyPair();
      expect(publicKey.startsWith('p256:')).toBe(true);

      const eventWithoutSig: Omit<NodicEvent, 'signature'> = {
        protocolVersion: 1,
        id: 'evt-test-1',
        channelId: 'chan-alpha',
        authorDeviceId: 'dev-alice',
        authorSequence: 1,
        lamportClock: 5,
        type: 'TASK_CREATED',
        keyVersion: 1,
        createdAt: '2026-11-07T12:00:00.000Z',
        payloadVersion: 1,
        payload: { title: 'Implement security', status: 'TODO', priority: 'HIGH' },
      };

      // Sign event
      const signature = await signEvent(eventWithoutSig, privateKey);
      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');

      const fullEvent: NodicEvent = {
        ...eventWithoutSig,
        signature,
      };

      // Verify with matching public key
      const isValid = await verifyEventSignature(fullEvent, publicKey);
      expect(isValid).toBe(true);

      // Verify fails if payload or content is tampered with
      const tamperedEvent: NodicEvent = {
        ...fullEvent,
        payload: { title: 'Malicious modification', status: 'DONE' },
      };
      const isTamperedValid = await verifyEventSignature(tamperedEvent, publicKey);
      expect(isTamperedValid).toBe(false);

      // Verify fails if signed by another key
      const anotherKey = await generateDeviceKeyPair();
      const isAnotherKeyValid = await verifyEventSignature(fullEvent, anotherKey.publicKey);
      expect(isAnotherKeyValid).toBe(false);
    });
  });

  describe('AES-256-GCM Channel Encryption & Decryption', () => {
    it('encrypts and decrypts channel payloads with unique nonces', async () => {
      const channelKey = generateChannelKey();
      expect(channelKey).toBeDefined();

      const secretPayload = {
        title: 'Classified Department Budget',
        items: [100, 250, 400],
        assignee: 'dev-bob',
      };

      const encrypted1 = await encryptPayload(secretPayload, channelKey);
      const encrypted2 = await encryptPayload(secretPayload, channelKey);

      // Nonces must be unique across encryptions even with the same payload
      expect(encrypted1.nonce).not.toBe(encrypted2.nonce);
      expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);

      // Successfully decrypts
      const decrypted = await decryptPayload<typeof secretPayload>(
        encrypted1.ciphertext,
        encrypted1.nonce,
        channelKey,
      );
      expect(decrypted).toEqual(secretPayload);

      // Fails with wrong key
      const wrongKey = generateChannelKey();
      await expect(
        decryptPayload(encrypted1.ciphertext, encrypted1.nonce, wrongKey),
      ).rejects.toThrow();
    });
  });

  describe('Invitation Secret Hashing and Constant-Time Comparison', () => {
    it('hashes secrets with SHA-256 deterministically', async () => {
      const secret = 'a'.repeat(64);
      const hash1 = await hashSecret(secret);
      const hash2 = await hashSecret(secret);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // 32 bytes hex
    });

    it('performs constant-time string comparison', () => {
      expect(constantTimeCompare('secret-key-123', 'secret-key-123')).toBe(true);
      expect(constantTimeCompare('secret-key-123', 'secret-key-999')).toBe(false);
      expect(constantTimeCompare('short', 'longer-string')).toBe(false);
    });
  });
});
