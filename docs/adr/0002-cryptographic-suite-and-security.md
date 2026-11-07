# ADR 0002: Cryptographic Suite and Security Boundary

- Status: Accepted
- Date: 2026-11-07

## Context

Phase 3 requires establishing the production cryptographic suite and security boundary for Nodic:
1. Every event envelope must be attributed to an authentic device identity.
2. Channel traffic must be confidential to approved active members.
3. Removed members must not be able to decrypt future channel content (forward secrecy via key rotation).
4. Local LAN invitations and join requests must not leak secrets in plain logs or discovery frames.

## Decision

### 1. Device Identity and Event Signing (ECDSA P-256 / SHA-256)
- Each device generates an EC P-256 (`secp256r1`) key pair.
- Android uses the hardware-backed `AndroidKeyStore` (`KeyGenParameterSpec` with `PURPOSE_SIGN | PURPOSE_VERIFY` and `DIGEST_SHA256`).
- Browser/TypeScript environments use the Web Cryptography API (`SubtleCrypto` with algorithm `{ name: 'ECDSA', namedCurve: 'P-256' }`).
- Public keys are exported as SPKI DER Base64, prefixed with `p256:`.
- Event signatures are generated over the deterministic canonical JSON representation of the event envelope (excluding the `signature` field) using ECDSA P-256 with SHA-256.

### 2. Channel Payload Authenticated Encryption (AES-256-GCM)
- Each channel has versioned symmetric keys (`keyVersion = 1, 2, ...`).
- Channel payloads for sensitive events (`CHAT_MESSAGE_SENT`, `TASK_CREATED`, `TASK_FIELDS_UPDATED`) are encrypted with AES-256-GCM.
- Each encryption generates a fresh, cryptographically random 12-byte (96-bit) nonce (IV). Nonce reuse is strictly prohibited.
- The ciphertext and nonce are stored in the database / wire envelope (`ciphertext` column), with local plaintext projections created only after verification.

### 3. Forward Secrecy & Channel Key Rotation (`CHANNEL_KEY_ROTATED`)
- Upon removing a member (`MEMBER_REMOVED`), the channel lead rotates the channel symmetric key to `keyVersion + 1`.
- The new key is distributed to remaining authorized members wrapped with their individual public keys / derived pairwise secrets.
- Events signed by removed device identities are rejected and quarantined with reason `AUTHOR_REVOKED`.

### 4. Invitations & Join Workflow
- Invitations contain a 32-byte cryptographically random join secret (`nodic:v1:<base64url>`) with 24-hour expiration.
- Invitation secrets are hashed (SHA-256) when stored or logged; plaintext secrets are never broadcast in discovery frames or ordinary logs.
- Joining nodes send a `JOIN_REQUEST` frame containing the join secret. The channel lead verifies the hash, emits a signed `MEMBER_ADDED` event, and admits the applicant.

## Consequences
- Deterministic canonicalization ensures cross-platform signature verification between Kotlin and TypeScript.
- Removed users cannot decrypt subsequent events authored under rotated keys.
