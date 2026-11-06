# Nodic Protocol v1

This document is the implementation contract between the Ionic application, the Android native sync service, and peer nodes. TypeScript validation schemas live in [`contracts.ts`](contracts.ts).

## Boundaries

Nodic has no cloud backend in the MVP. Its backend boundary consists of:

1. The local domain/event service.
2. SQLite persistence and projections.
3. The Capacitor-to-Kotlin native plugin API.
4. The authenticated peer wire protocol.

## Capacitor plugin API

Plugin name: `NodicSync`.

### Methods

| Method | Input | Output | Purpose |
|---|---|---|---|
| `getStatus` | `{}` | `SyncStatus` | Current foreground-service and peer state. |
| `start` | `{ displayName: string; deviceId?: string; publicKey?: string }` | `SyncStatus` | Start the foreground sync service. |
| `stop` | `{}` | `SyncStatus` | Stop local discovery and peer connections. |
| `publishEvent` | `{ eventJson: string }` | `{ accepted: boolean; eventId: string }` | Persist/queue one validated local event for relay. |
| `publishBatch` | `{ batchJson: string }` | `{ accepted: boolean; batchId: string }` | Relay a batch of channel events to connected peers. |
| `getDeviceIdentity` | `{ displayName?: string }` | `{ deviceId: string; displayName: string; publicKey: string; keystoreAlias: string }` | Get or create the Keystore-backed identity. |
| `syncDeviceIdentity` | `{ deviceId: string; displayName: string; publicKey: string }` | `{ deviceId: string; displayName: string; publicKey: string; keystoreAlias: string }` | Sync updated identity to native store and re-announce to peers. |
| `connectPeer` | `{ host: string; port: number }` | `{ connected: boolean; host: string; port: number }` | Initiate direct peer handshake and session establishment. |
| `getDiagnostics` | `{}` | `{ peerIdentities: PeerIdentity[]; peerSessions: PeerSession[]; syncLogs: SyncLog[] }` | Read saved peer identities, sessions, and sync logs from native SQLite. |
| `clearLogs` | `{}` | `{ cleared: boolean }` | Clear persisted sync logs. |
| `runProbe` | `{}` | `ProbeResult` | Phase 0 native/database/service health check. |
| `sendProbe` | `{}` | `{ accepted: boolean; probeId: string }` | Send one Phase 0 probe to discovered peers. |

### Listener events

| Event | Payload | Meaning |
|---|---|---|
| `statusChanged` | `SyncStatus` | Discovery, connectivity, or queue status changed. |
| `eventReceived` | `{ eventJson: string; peerId: string }` | A remote event passed transport-level checks. |
| `probeEventReceived` | `{ id: string; from: string; sentAt: string }` | Phase 0 test frame arrived. |
| `peerIdentityUpdated` | `PeerIdentity` | Remote peer identity verified and persisted during handshake/event exchange. |
| `peerSessionUpdated` | `PeerSession` | Inbound or outbound peer session created, updated, or closed. |
| `syncLogAdded` | `SyncLog` | Connection, handshake, or sync log entry recorded. |

Plugin methods must return structured errors with stable `code` and human-readable `message` fields.

## Peer transport

Phase 0 uses NSD service type `_nodic._tcp.` plus newline-delimited JSON over TCP. This proves discovery and background receipt. It is **not** the final secure transport.

Before pilot use, the connection must add identity proof, encrypted sessions, canonical signatures, frame limits, and authorization described in `SPEC.md`.

## Event ordering

- Event IDs are globally unique.
- `(channelId, authorDeviceId, authorSequence)` is unique.
- Lamport clocks decide field conflicts; wall-clock time is display-only.
- Duplicate IDs are successful no-ops.
- Events are applied only after schema, signature, membership, and permission checks.

## Limits

Initial limits:

- Frame: 256 KiB.
- Event batch: 100 events.
- Chat message: 4,000 Unicode characters.
- Task title: 200 characters.
- Task description: 20,000 characters.
- Display name: 80 characters.

## Versioning

Protocol and event payload versions begin at `1`. Unknown major protocol versions are rejected. Unknown event payload versions are quarantined and do not alter projections.
