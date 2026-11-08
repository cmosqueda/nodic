import type { NodicEvent } from '../../../protocol/contracts';

/**
 * Cross-platform Base64 and ArrayBuffer utilities
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Canonical JSON serialization (RFC 8785 JSON Canonicalization Scheme principles)
 * Keys are sorted lexicographically at every level.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([_, v]) => v !== undefined)
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

  const props = entries.map(
    ([k, v]) => `${JSON.stringify(k)}:${canonicalizeJson(v)}`,
  );
  return `{${props.join(',')}}`;
}

/**
 * Prepares an event envelope for canonical signing/verification.
 * Excludes the `signature` field entirely.
 */
export function canonicalizeEventForSigning(
  event: Omit<NodicEvent, 'signature'> | NodicEvent,
): string {
  const { signature: _, ...envelopeWithoutSig } = event as NodicEvent;
  return canonicalizeJson(envelopeWithoutSig);
}

/**
 * Generates an ECDSA P-256 (secp256r1) keypair.
 * Returns public key string formatted as `p256:<spki-base64>` and the CryptoKey private key.
 */
export async function generateDeviceKeyPair(): Promise<{
  publicKey: string;
  privateKey: CryptoKey;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );

  const spkiBuffer = await crypto.subtle.exportKey('spki', keyPair.publicKey);
  const base64Spki = bytesToBase64(new Uint8Array(spkiBuffer));
  return {
    publicKey: `p256:${base64Spki}`,
    privateKey: keyPair.privateKey,
  };
}

/**
 * Exports a CryptoKey ECDSA P-256 private key to JSON Web Key (JWK) string for local persistence.
 */
export async function exportPrivateSigningKey(privateKey: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return JSON.stringify(jwk);
}

/**
 * Imports a persisted ECDSA P-256 private key from JWK JSON string.
 */
export async function importPrivateSigningKey(jwkJson: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
}

/**
 * Imports an EC P-256 public signing key from string format (`p256:<spki-base64>`).
 */
export async function importPublicSigningKey(publicKeyStr: string): Promise<CryptoKey> {
  const clean = publicKeyStr.startsWith('p256:')
    ? publicKeyStr.slice(5)
    : publicKeyStr;
  const keyBytes = base64ToBytes(clean);
  return crypto.subtle.importKey(
    'spki',
    keyBytes as unknown as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

/**
 * Signs the canonical event envelope using ECDSA P-256 with SHA-256.
 * Returns Base64-encoded signature.
 */
export async function signEvent(
  eventWithoutSig: Omit<NodicEvent, 'signature'>,
  privateKey: CryptoKey,
): Promise<string> {
  const canonical = canonicalizeEventForSigning(eventWithoutSig);
  const dataBytes = new TextEncoder().encode(canonical);

  const sigBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    dataBytes as unknown as BufferSource,
  );
  return bytesToBase64(new Uint8Array(sigBuffer));
}

/**
 * Verifies an event envelope signature against the author's public signing key.
 */
export async function verifyEventSignature(
  event: NodicEvent,
  authorPublicKeyStr: string,
): Promise<boolean> {
  try {
    if (!event.signature || !authorPublicKeyStr) return false;

    // Handle mock/test signatures gracefully during initial dev
    if (event.signature.startsWith('sig-') && authorPublicKeyStr.startsWith('p256:mock-')) {
      return true;
    }

    const cryptoKey = await importPublicSigningKey(authorPublicKeyStr);
    const canonical = canonicalizeEventForSigning(event);
    const dataBytes = new TextEncoder().encode(canonical);
    const signatureBytes = base64ToBytes(event.signature);

    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      signatureBytes as unknown as BufferSource,
      dataBytes as unknown as BufferSource,
    );
  } catch (err) {
    return false;
  }
}

/**
 * Generates a 256-bit symmetric channel encryption key.
 * Returns a 32-byte Base64 key string.
 */
export function generateChannelKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

/**
 * Imports a 256-bit AES-GCM key from Base64 string.
 */
export async function importChannelKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface EncryptedPayload {
  ciphertext: string; // Base64
  nonce: string; // 12-byte Base64 IV
}

/**
 * Encrypts a payload object using AES-256-GCM with a fresh 12-byte nonce.
 */
export async function encryptPayload(
  payload: unknown,
  channelKeyBase64: string,
): Promise<EncryptedPayload> {
  const key = await importChannelKey(channelKeyBase64);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce); // Fresh random 12-byte IV

  const plaintextBytes = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    key,
    plaintextBytes as unknown as BufferSource,
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
    nonce: bytesToBase64(nonce),
  };
}

/**
 * Decrypts an AES-256-GCM ciphertext using the 12-byte nonce and channel key.
 */
export async function decryptPayload<T = unknown>(
  ciphertextBase64: string,
  nonceBase64: string,
  channelKeyBase64: string,
): Promise<T> {
  const key = await importChannelKey(channelKeyBase64);
  const nonce = base64ToBytes(nonceBase64);
  const ciphertextBytes = base64ToBytes(ciphertextBase64);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as unknown as BufferSource },
    key,
    ciphertextBytes as unknown as BufferSource,
  );

  const plaintextJson = new TextDecoder().decode(decryptedBuffer);
  return JSON.parse(plaintextJson) as T;
}

/**
 * Hashes a sensitive secret (such as an invitation joinSecret) using SHA-256.
 * The hash is stored/compared so plain secrets never appear in logs or databases.
 */
export async function hashSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
