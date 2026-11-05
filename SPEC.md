# Nodic MVP Product and Technical Specification

## 1. Document Purpose

This document defines the product behavior, architecture, protocol, data model, security boundaries, and acceptance criteria for the first implementable version of **Nodic**.

It is intended to be the source of truth for implementation. Where this specification uses **MUST**, the requirement is mandatory for the MVP. **SHOULD** indicates a strong recommendation. **MAY** indicates optional behavior.

## 2. Product Overview

**Nodic** is an Android-first, local-first collaboration application that combines peer-to-peer team communication with task-driven Kanban workflows. Its name represents communication and iterative work connected through network nodes.

Each Android device is a node. Nodes on the same department Wi-Fi network discover one another, exchange signed channel events, store those events locally, and relay missing events to other authorized nodes. There is no required cloud service for the MVP.

A channel creator becomes its team lead. The lead may invite members, appoint co-leads, create tasks, and assign tasks. Co-leads may also manage tasks. Assigned members receive notifications and manage their tasks through a personal Kanban view. Completing a task produces a task event and an automatic message in the channel chat.

## 3. MVP Goals

1. Let a team lead create a private department channel without a cloud account.
2. Let nearby Android users join through a copy/paste invitation code and lead approval.
3. Synchronize channel messages, membership changes, and task changes over the same Wi-Fi network.
4. Let leads and co-leads create, edit, prioritize, assign, and track tasks.
5. Give each member a personal Kanban view backed by local SQLite data.
6. Notify a member when a task is assigned and notify channel members of relevant messages and task completion.
7. Continue receiving and relaying data while the UI is closed by using an Android foreground service.
8. Recover from temporary disconnection and converge devices to the same state when peers reconnect.

## 4. MVP Scope

The MVP includes:

- Android only.
- Operation on one local Wi-Fi network.
- One app installation representing one user and one device identity.
- Multiple channels per installation, although initial testing may focus on one.
- Channel roles: lead, co-lead, and member.
- Copy/paste invitation codes.
- Lead-approved membership.
- Text group chat.
- Kanban tasks with assignment, priority, due date, status, and activity history.
- Personal and team Kanban views.
- Native local notifications.
- Native Android foreground synchronization service.
- Store-and-forward event synchronization between peers.
- Local encrypted secrets and signed channel events.

The MVP does not promise delivery when no authorized device holding a message is reachable. Delivery is eventual, not instantaneous.

## 5. Terminology

| Term | Meaning |
|---|---|
| Node | One authorized Android installation participating in a channel. |
| Device identity | The installation-specific cryptographic identity and stable device ID. |
| Channel | A private team communication and task workspace. |
| Lead | The channel creator and root authority for membership and co-lead appointment. |
| Co-lead | A member appointed by the lead who can manage tasks. |
| Member | An approved channel participant. |
| Event | An immutable, signed record of a change or message. |
| Materialized state | Current tasks, messages, roles, and membership derived from accepted events. |
| Relay | Forwarding an accepted event to another authorized peer. |
| Foreground service | Android service that keeps synchronization active while showing a persistent system notification. |
| Logical clock | A Lamport counter used to order changes without trusting wall-clock time. |

## 6. Product Principles

- **Local first:** the app remains useful without internet access.
- **Event based:** nodes exchange immutable events rather than copying database rows.
- **Eventually consistent:** authorized devices converge after they exchange all accepted events.
- **Explicit authority:** membership and role changes must be cryptographically attributable to permitted actors.
- **No silent data loss:** conflicting edits remain visible in task activity history.
- **Android-realistic background behavior:** background synchronization uses a foreground service and clearly communicates its status.
- **Minimum data exposure:** discovery advertisements must not include message text, task content, member names, or channel keys.

## 7. Users, Roles, and Permissions

### 7.1 Role creation

- The user who creates a channel MUST become its lead.
- A channel MUST have exactly one lead in the MVP.
- Only the lead MAY appoint or remove co-leads.
- Lead transfer is outside MVP scope.
- Removing the lead is not permitted.

### 7.2 Permissions

| Action | Lead | Co-lead | Member |
|---|---:|---:|---:|
| View channel roster, chat, and team tasks | Yes | Yes | Yes |
| Send chat messages | Yes | Yes | Yes |
| Create and revoke invitations | Yes | No | No |
| Approve or reject join requests | Yes | No | No |
| Remove members | Yes | No | No |
| Appoint or remove co-leads | Yes | No | No |
| Create, edit, assign, archive, or reopen any task | Yes | Yes | No |
| Change status of a task assigned to self | Yes | Yes | Yes |
| Comment on tasks | Yes | Yes | Yes |

Permissions MUST be checked both before local event creation and when a remote event is received. UI restrictions alone are not authorization.

### 7.3 Identity rules

- A user MUST choose a display name during onboarding.
- Each installation MUST generate a unique `deviceId` and signing key pair.
- Display names need not be globally unique; the UI SHOULD show a short device fingerprint where ambiguity exists.
- Reinstalling the app creates a new identity and requires joining again.

## 8. Functional Requirements

### 8.1 Identity and Device Setup

1. On first launch, the app MUST request a display name.
2. The app MUST generate and persist an installation ID and cryptographic key pair.
3. Private keys and channel secrets MUST be protected through Android Keystore-backed storage.
4. The user MUST explicitly start Nodic networking. Starting it launches the foreground service.
5. The app MUST explain that a permanent Android notification is required for closed-UI message delivery.
6. The app SHOULD guide the user to exclude Nodic from battery optimization, but MUST remain usable if the user declines.

### 8.2 Channel Creation

1. The creator enters a channel name and optional description.
2. The app creates a random channel ID and channel encryption key.
3. The app records the creator as lead in the genesis event.
4. The genesis event MUST be signed by the creator.
5. Channel creation MUST work without internet access.
6. The new channel MUST be immediately visible locally, even when no peers are online.

### 8.3 Invitation and Joining

1. The lead creates an invitation with an expiration time and optional maximum use count; MVP default is one use and 24-hour expiry.
2. The invitation is rendered as a URL-safe copyable code.
3. A prospective member pastes the code into Nodic while connected to the same Wi-Fi network.
4. The joining node discovers a current channel peer and submits a signed join request containing its device ID, display name, and public key.
5. The lead MUST approve or reject the request.
6. Approval creates a signed `MEMBER_ADDED` event. The member is unauthorized until that event is received and validated.
7. The approved node performs an initial synchronization before entering the channel.
8. Expired, revoked, malformed, or already-consumed codes MUST fail with a clear error.
9. Invitation secrets MUST never be broadcast in peer discovery messages or logs.

The invitation payload SHOULD be versioned and contain at least:

```ts
type ChannelInvitationV1 = {
  version: 1;
  channelId: string;
  invitationId: string;
  joinSecret: string;
  expiresAt: string;
};
```

The code format SHOULD be `nodic:v1:<base64url-payload>`. The future QR code feature will encode exactly the same string.

### 8.4 Membership Management

- The lead MUST see pending join requests.
- The lead MAY remove any member or co-lead.
- Removing a member MUST create a signed `MEMBER_REMOVED` event.
- Events authored by a removed identity after the effective removal event MUST be rejected.
- After removal, the channel key SHOULD be rotated and distributed only to remaining members.
- Membership and role changes MUST appear in a channel activity log.
- An offline removed device may retain previously synchronized data; the MVP cannot remotely erase it.

### 8.5 Kanban and Task Management

Each task MUST support:

- Stable task ID.
- Channel ID.
- Title.
- Optional description.
- Status: `BACKLOG`, `TODO`, `IN_PROGRESS`, `BLOCKED`, or `DONE`.
- Priority: `LOW`, `MEDIUM`, `HIGH`, or `URGENT`.
- Optional assignee.
- Optional due date and time.
- Creator and creation time.
- Per-field logical version metadata.
- Archived flag.

Required behavior:

1. Leads and co-leads can create and edit tasks.
2. Leads and co-leads can assign or reassign tasks to active members.
3. Members can change the status of tasks currently assigned to them.
4. Assigning or reassigning a task creates a notification for the new assignee.
5. A personal Kanban view shows tasks assigned to the current identity.
6. A team Kanban view shows all non-archived channel tasks.
7. Moving a card creates a status update event; it MUST NOT directly update remote database rows.
8. Marking a task `DONE` creates a `TASK_STATUS_CHANGED` event.
9. The first accepted transition into `DONE` MUST generate one deterministic system chat item: `<member> completed “<task title>”.`
10. Reopening and completing the task again creates a new completion item.
11. Every accepted task mutation MUST appear in the task activity history.
12. Archived tasks remain in history and synchronization but are hidden from default boards.

### 8.6 Group Chat

- All active channel members can send plain-text messages.
- Messages MUST have stable IDs and immutable content in the MVP.
- Messages MUST display sender and creation time.
- The UI MUST distinguish user messages from system activity items.
- Nodes MUST suppress duplicate messages by event ID.
- Message editing, deletion, reactions, replies, attachments, and read receipts are out of scope.
- Chat history is retained locally unless the user leaves or clears local application data.

### 8.7 Notifications

Nodic MUST support these local notifications:

- Task assigned to the current user.
- Current user's task materially edited or reassigned.
- New chat message while the channel screen is not visible.
- Join request on the lead's device.
- Task completion, optionally grouped by channel.

Tapping a notification MUST open the relevant channel, task, or join request when available. Notifications MUST be deduplicated using event ID. The foreground service's persistent status notification is separate from content notifications.

### 8.8 Local Wi-Fi Peer Communication

- Peers MUST communicate without internet access when on a network that permits client-to-client traffic.
- Discovery MUST advertise only protocol version, device endpoint, and opaque channel discovery identifiers.
- A connection MUST authenticate the remote device before channel data is exchanged.
- A node MAY connect to several peers simultaneously.
- Every node MUST be able to store and forward accepted events.
- Nodes MUST reconnect after temporary Wi-Fi loss or address changes.
- The UI MUST show `Connected`, `Searching`, `Offline`, or `Sync error` status.

### 8.9 Offline Operation and Synchronization

- Local actions MUST be committed to SQLite before being announced to peers.
- Events created offline MUST enter an outbox and synchronize later.
- Peers MUST exchange per-author sequence summaries and request missing events.
- Receiving the same event more than once MUST be safe.
- An event MUST be validated before it changes materialized state or is relayed.
- A node MUST retain accepted events so it can relay them to peers that reconnect later.
- The MVP does not require permanent delivery after every copy of an event has been deleted or lost.
- The UI SHOULD show whether a local event has reached zero, one, or multiple peers. This is informational and is not a global read receipt.

### 8.10 Conflict Resolution

Task edits MUST use field-level changes. Each changed field is resolved independently using the following total ordering tuple:

```text
(lamportClock, actorDeviceId, eventId)
```

The lexicographically greatest valid tuple wins for that field. A node increments its Lamport clock before creating an event and updates it to `max(local, received) + 1` after accepting a remote event.

Consequences:

- Concurrent edits to different fields merge automatically.
- Concurrent edits to the same field resolve deterministically on every node.
- Losing changes remain visible in immutable activity history.
- Wall-clock timestamps are for display only and MUST NOT decide conflicts.
- Membership and role events do not use task field conflict rules; they follow authority validation and their event order.

The UI SHOULD show a small notice when a user's recently edited value is superseded during synchronization.

## 9. User Flows

### 9.1 First launch and channel creation

1. User opens Nodic and enters a display name.
2. Nodic creates the device identity.
3. User enables networking and accepts the persistent service notification.
4. User selects **Create channel**, enters channel details, and confirms.
5. Nodic creates the channel genesis event and makes the user its lead.
6. Empty chat, team board, and member list become available.

### 9.2 Invite and approve a member

1. Lead opens **Members → Invite member**.
2. Nodic creates and displays a copyable invitation code.
3. Member installs Nodic, completes identity setup, and pastes the code.
4. Nodic discovers a channel node and submits a join request.
5. Lead receives a notification and reviews the display name and identity fingerprint.
6. Lead approves the request.
7. The membership event and channel snapshot synchronize to the member.
8. Member enters the channel.

### 9.3 Assign and complete a task

1. Lead or co-lead creates a task and selects an assignee.
2. The task event commits locally and propagates through peers.
3. Assignee's device stores the event and shows a notification.
4. Task appears in the assignee's personal Kanban board.
5. Assignee moves it to `IN_PROGRESS`, then `DONE`.
6. The completion event propagates.
7. Every device derives one corresponding system chat item and updates the board.

### 9.4 Offline synchronization

1. A co-lead edits a task while disconnected.
2. The event is committed locally and marked pending.
3. Networking resumes when an authorized peer becomes reachable.
4. Peers compare sequence summaries and transfer missing events.
5. Both validate, apply, and relay accepted events.
6. Conflicting fields resolve using the deterministic ordering rule.

## 10. System Architecture

```text
┌───────────────────────────────────────────┐
│ Ionic application                        │
│ Pages, components, state, use cases       │
├───────────────────────────────────────────┤
│ Domain and persistence                    │
│ Event validation, reducers, Drizzle       │
├───────────────────────┬───────────────────┤
│ Capacitor SQLite      │ Custom Capacitor  │
│ local database        │ Android plugin    │
├───────────────────────┼───────────────────┤
│ Android Keystore      │ Kotlin foreground │
│ keys and secrets      │ sync service      │
├───────────────────────┴───────────────────┤
│ Wi-Fi LAN: discovery + secure transport   │
└───────────────────────────────────────────┘
```

### 10.1 Application layer

The Ionic application owns user interaction, navigation, Kanban rendering, chat rendering, and application-level use cases. It communicates with native synchronization through a Capacitor plugin API and subscribes to service events while the UI is active.

### 10.2 Persistence layer

SQLite is the source of truth on each device. Drizzle SHOULD define schemas, migrations, and application queries. The selected Capacitor SQLite driver and Drizzle adapter MUST be validated with a small proof of concept before full implementation because web and native SQLite adapters differ.

Database writes that create an event and apply its local state MUST occur in one transaction.

### 10.3 Native synchronization layer

A custom Kotlin Capacitor plugin and Android foreground service SHOULD own:

- Service lifecycle.
- Network discovery.
- Peer connections.
- Authentication handshake.
- Event exchange and acknowledgements.
- Network-change handling.
- Boot recovery.
- Notification delivery while the web view is not running.

The native service must be able to read and write the same SQLite database safely. Database access MUST be serialized or use SQLite WAL mode with tested transaction boundaries.

### 10.4 Event processing pipeline

```text
Create/receive event
       ↓
Validate envelope, signature, membership, permission, sequence
       ↓
Insert immutable event (duplicate-safe)
       ↓
Apply reducer to materialized tables
       ↓
Queue relay and local notification
       ↓
Announce updated synchronization summary
```

## 11. Data Model

The exact SQL types may be adapted to the chosen SQLite driver. IDs SHOULD be UUIDv7 or another collision-resistant, time-sortable identifier. Timestamps SHOULD use UTC ISO 8601 strings or integer epoch milliseconds consistently.

### 11.1 Core tables

#### `device_identity`

| Column | Purpose |
|---|---|
| `device_id` | Stable installation ID; primary key. |
| `display_name` | Current local display name. |
| `public_signing_key` | Public key. |
| `keystore_alias` | Reference to protected private key. |
| `lamport_clock` | Current local logical clock. |
| `created_at` | Local creation time. |

#### `channels`

| Column | Purpose |
|---|---|
| `id` | Channel ID; primary key. |
| `name` | Channel name. |
| `description` | Optional description. |
| `lead_device_id` | Root lead identity. |
| `genesis_event_id` | Channel genesis event. |
| `key_version` | Current channel key version. |
| `created_at` | Display timestamp. |

#### `members`

| Column | Purpose |
|---|---|
| `channel_id` + `device_id` | Composite primary key. |
| `display_name` | Channel-visible name. |
| `public_signing_key` | Verified member key. |
| `role` | `LEAD`, `CO_LEAD`, or `MEMBER`. |
| `status` | `ACTIVE` or `REMOVED`. |
| `joined_event_id` | Authorizing membership event. |
| `removed_event_id` | Optional removal event. |

#### `events`

| Column | Purpose |
|---|---|
| `id` | Globally unique event ID; primary key. |
| `channel_id` | Owning channel; indexed. |
| `author_device_id` | Event author. |
| `author_sequence` | Strictly increasing sequence per author and channel. |
| `lamport_clock` | Logical ordering value. |
| `type` | Versioned event type. |
| `entity_id` | Optional affected task or message ID. |
| `key_version` | Encryption key version. |
| `ciphertext` | Encrypted payload for transport/storage policy. |
| `payload_json` | Validated local payload if storing decrypted projections. |
| `signature` | Author signature over canonical envelope. |
| `created_at` | Author wall-clock timestamp for display. |
| `received_at` | Local receipt timestamp. |

Enforce a unique constraint on `(channel_id, author_device_id, author_sequence)`.

#### `tasks`

Contains the materialized current task state. In addition to task fields, each conflict-resolved field MUST have version metadata, either as dedicated columns or a `task_field_versions` child table.

#### `task_field_versions`

| Column | Purpose |
|---|---|
| `task_id` + `field_name` | Composite primary key. |
| `lamport_clock` | Winning field clock. |
| `actor_device_id` | Winning actor. |
| `event_id` | Winning event. |

#### `messages`

Stores materialized user messages and derived system items. A unique `source_event_id` prevents duplicate completion messages.

#### Additional tables

- `invitations`: invitation hash, expiry, usage count, and revocation state.
- `join_requests`: pending and resolved requests.
- `peer_receipts`: last known peer receipt per event or author sequence.
- `channel_keys`: channel key versions stored through protected references.
- `rejected_events`: event ID, reason, sender, and diagnostic time.
- `schema_migrations`: database migration history.

## 12. Event Protocol

### 12.1 Envelope

```ts
type NodicEvent<T = unknown> = {
  protocolVersion: 1;
  id: string;
  channelId: string;
  authorDeviceId: string;
  authorSequence: number;
  lamportClock: number;
  type: EventType;
  entityId?: string;
  keyVersion: number;
  createdAt: string;
  payload: T;
  signature: string;
};
```

The signature MUST cover a canonical serialization of every field except `signature`. JSON key order MUST NOT be assumed; use a defined canonical JSON implementation or a binary format with deterministic encoding.

### 12.2 Required event types

```text
CHANNEL_CREATED
INVITATION_CREATED
INVITATION_REVOKED
MEMBER_ADDED
MEMBER_REMOVED
MEMBER_ROLE_CHANGED
CHANNEL_KEY_ROTATED
CHAT_MESSAGE_SENT
TASK_CREATED
TASK_FIELDS_UPDATED
TASK_STATUS_CHANGED
TASK_ARCHIVED
TASK_COMMENT_ADDED
```

Event payloads MUST be versioned. Unknown event versions MUST be stored as unsupported but MUST NOT modify state or be relayed as accepted data until validation support exists.

### 12.3 Validation order

1. Confirm envelope size and protocol version.
2. Confirm valid channel and event identifiers.
3. Reject exact duplicates without error.
4. Verify signature against the author's authorized public key.
5. Confirm author membership at the event's logical position.
6. Confirm author permission for the event type and target.
7. Confirm author sequence has not been reused with different content.
8. Validate payload schema, lengths, and referenced entities.
9. Insert, reduce, notify, and relay in an atomic or recoverable workflow.

### 12.4 Synchronization summary

Each node SHOULD maintain a compact map per channel:

```ts
type SyncSummary = Record<string, number>; // authorDeviceId -> highest contiguous sequence
```

After authentication, peers exchange summaries, request missing ranges, transfer events in bounded batches, and acknowledge the highest contiguous accepted sequence. Gaps MUST be requested again. Batch count and byte size MUST be capped.

## 13. Peer Discovery and Transport

### 13.1 Recommended MVP approach

- Use Android Network Service Discovery (NSD/mDNS) to advertise and discover a Nodic service on the local network.
- Run a TCP-based authenticated transport, preferably WebSocket or a framed protocol, inside the Kotlin service.
- Advertise a protocol version, listening port, ephemeral node instance ID, and opaque hashes for channels willing to accept connections.
- Do not advertise channel names, member names, task data, invitation secrets, or encryption keys.

UDP multicast discovery may be used if NSD proves unreliable, but it requires careful Android multicast-lock lifecycle management. The transport implementation MUST be abstracted behind an interface so discovery can be replaced later.

### 13.2 Connection lifecycle

1. Discover endpoint.
2. Establish transport connection.
3. Exchange protocol capabilities and nonces.
4. Prove device identity by signing the handshake transcript.
5. Determine shared authorized channels using opaque channel identifiers.
6. Establish encrypted session keys using a maintained cryptographic library.
7. Exchange sync summaries and events.
8. Send keep-alives while appropriate.
9. Back off with jitter after failure.

A node MUST limit concurrent connections, message sizes, handshake rate, and retry rate to prevent local resource exhaustion.

### 13.3 Network assumptions

The office access point must permit peer-to-peer/client-to-client traffic and local discovery. Nodic MUST detect and report when Wi-Fi exists but no peers are discoverable. Documentation for deployment SHOULD include a network validation checklist.

No fixed IP addresses may be assumed. The implementation MUST handle DHCP address changes and Wi-Fi transitions.

## 14. Background Operation

### 14.1 Foreground service requirement

Nodic MUST use an Android foreground service for peer discovery, listening, synchronization, and closed-UI notifications. The service notification MUST indicate status and provide actions to open or pause Nodic.

The service SHOULD use the appropriate Android foreground service type and permissions for the target SDK. Manifest declarations and runtime permission behavior MUST be verified against the Android version selected during implementation.

### 14.2 Lifecycle behavior

- Starting networking starts the foreground service.
- Swiping away the UI MUST NOT intentionally stop the service.
- Network callbacks MUST trigger rediscovery after connectivity changes.
- A boot receiver MAY restart synchronization after reboot if Android policy and user settings allow it.
- The UI MUST clearly show when the service is paused, stopped, or restricted.
- The service MUST release multicast locks, wake locks, sockets, and callbacks when stopped.
- Long-held wake locks SHOULD be avoided.

### 14.3 Explicit limitations

Nodic cannot guarantee background receipt when:

- The user force-stops the application.
- Android or the device vendor kills or restricts the service.
- Wi-Fi is disconnected or isolates clients.
- No peer containing the missing event is online.
- The device is rebooted before Nodic is allowed to restart.

Product copy MUST describe this as eventual local-network delivery, not guaranteed push delivery.

## 15. Security Model

### 15.1 Security objectives

- Only approved members can decrypt current channel traffic.
- Every accepted event can be attributed to an authorized device identity.
- Unauthorized devices cannot appoint themselves or mutate tasks.
- Replayed events do not create duplicate state.
- Secrets are not exposed through discovery or ordinary logs.

### 15.2 Cryptographic requirements

- Generate device signing keys using Android-supported, maintained cryptographic APIs.
- Protect private keys with Android Keystore.
- Encrypt channel payloads using an authenticated encryption mode such as AES-256-GCM.
- Use a fresh nonce according to the selected library's requirements; nonce reuse with the same key is forbidden.
- Sign canonical event envelopes.
- Use a standard authenticated key agreement/library for transport. Do not design a custom cipher or handshake.
- Store invitation secrets as hashes when plaintext is not needed.
- Use constant-time secret comparison where supported.

The precise cryptographic suite MUST be captured in an architecture decision record before protocol implementation and reviewed separately.

### 15.3 Trust and revocation

The lead's genesis key is the root authority for a channel. Co-lead authorization is derived from lead-signed role events. Removal prevents future accepted events from that identity, but cannot erase previously copied data.

After removal, rotating the channel key limits access to future content. Remaining peers need a reliable key-distribution event encrypted separately for each member. If key rotation is deferred during early prototyping, the UI and documentation MUST state that removed users may still decrypt later traffic they can capture; production-like testing must not claim secure revocation until rotation works.

### 15.4 Data protection limitations

Local SQLite projections may contain plaintext needed by the app. Android sandboxing alone does not provide database-at-rest encryption. Full encrypted database storage is optional for MVP, but keys MUST remain Keystore-protected and backups SHOULD be disabled or explicitly designed.

## 16. Error Handling and Recovery

- Invalid remote events MUST be quarantined in `rejected_events` with a non-sensitive reason.
- One invalid event MUST NOT terminate the entire synchronization session.
- Database migrations MUST be transactional where SQLite permits.
- Materialized state MUST be rebuildable from accepted events for diagnostics and recovery.
- Interrupted event batches MUST resume from the last contiguous accepted sequence.
- If a duplicate sequence carries different content, quarantine it as identity corruption or malicious behavior.
- If storage is full, stop accepting events, retain existing data, and show a blocking warning.
- If notification permission is denied, synchronization continues and the UI shows that alerts are disabled.
- If discovery fails, users receive actionable checks: same Wi-Fi, service running, battery restrictions, and network client isolation.
- Diagnostic export MAY include versions, connection state, and redacted event metadata; it MUST exclude keys, invitation secrets, and plaintext content by default.

## 17. User Interface Requirements

### 17.1 Primary navigation

The app SHOULD provide these primary areas:

- Channel switcher/home.
- Chat.
- My Board.
- Team Board.
- Members.
- Channel settings and connection status.

### 17.2 Required screens

1. Onboarding and display-name setup.
2. Create channel / paste invitation.
3. Channel chat.
4. Personal Kanban board.
5. Team Kanban board.
6. Task detail and activity history.
7. Task editor for authorized roles.
8. Member roster and pending join requests.
9. Invitation creation and sharing.
10. Networking, service, and synchronization status.

### 17.3 UX rules

- Pending local changes MUST be visually distinguishable from changes observed by at least one peer.
- Offline status MUST not prevent valid local task or chat actions.
- Role-restricted controls MUST be hidden or disabled with an explanation.
- Task priority MUST use labels/icons in addition to color.
- Kanban actions MUST have accessible non-drag alternatives.
- Destructive membership actions MUST require confirmation.
- Long IDs, keys, and raw protocol errors MUST not be shown as primary user messages.

## 18. Non-Functional Requirements

### 18.1 Reliability

- Event application MUST be idempotent.
- A process restart between event insertion and projection MUST recover without duplicate state.
- Synchronization MUST tolerate peer churn and out-of-order event arrival.

### 18.2 Performance targets

- Initial local screen data SHOULD render within 1 second on a representative MVP device.
- A local task update SHOULD appear immediately after transaction commit.
- A received event SHOULD update state and notify within 2 seconds under normal LAN conditions.
- Initial sync of 10,000 small events SHOULD complete without UI lockup or application crash.
- Event batches and payloads MUST be bounded; default maximum user chat message length SHOULD be 4,000 characters.

### 18.3 Resource usage

- Idle discovery and synchronization SHOULD minimize wake locks and reconnection loops.
- The service MUST use exponential backoff with jitter.
- Database indexes MUST cover channel/event sequence lookups, task board queries, and chat ordering.

### 18.4 Compatibility and accessibility

- Define one minimum Android SDK before implementation and test at least the minimum and current target SDK.
- Support system font scaling, screen readers, keyboard navigation where relevant, and sufficient contrast.
- All protocol and database schemas MUST carry explicit versions.

### 18.5 Observability

- Use structured, severity-based logs.
- Redact message content, task content, invitation secrets, channel keys, and private keys.
- Record counters for peers discovered, sessions established, events sent, events accepted, and events rejected.

## 19. Technology Stack

| Layer | MVP choice |
|---|---|
| UI | Ionic with a supported JavaScript/TypeScript framework |
| Native runtime | Capacitor |
| Local database | SQLite |
| ORM/schema | Drizzle ORM |
| Native Android code | Kotlin |
| Background execution | Android foreground service |
| Discovery | Android NSD/mDNS initially |
| Transport | Authenticated TCP/WebSocket or framed TCP |
| Notifications | Capacitor/native Android local notifications |
| Serialization | Versioned canonical JSON or deterministic binary format |
| Testing | Unit, database, protocol, native instrumentation, and multi-device tests |

The team MUST build a vertical technical spike before feature development that proves Ionic → Capacitor plugin → foreground service → SQLite → two-device LAN exchange.

## 20. Suggested Project Structure

```text
nodic/
├─ src/
│  ├─ app/
│  ├─ features/
│  │  ├─ channels/
│  │  ├─ chat/
│  │  ├─ tasks/
│  │  ├─ members/
│  │  └─ sync-status/
│  ├─ domain/
│  │  ├─ events/
│  │  ├─ permissions/
│  │  ├─ reducers/
│  │  └─ conflicts/
│  ├─ db/
│  │  ├─ schema/
│  │  ├─ migrations/
│  │  └─ repositories/
│  ├─ services/
│  └─ shared/
├─ android/
│  └─ app/src/main/java/.../nodic/
│     ├─ plugin/
│     ├─ sync/
│     ├─ discovery/
│     ├─ transport/
│     ├─ crypto/
│     ├─ notifications/
│     └─ persistence/
├─ protocol/
│  ├─ schemas/
│  ├─ fixtures/
│  └─ PROTOCOL.md
├─ tests/
└─ docs/
   └─ adr/
```

Domain event schemas and protocol fixtures SHOULD be shared or generated so TypeScript and Kotlin validate identical formats.

## 21. Implementation Phases

### Phase 0: Feasibility spike

- Initialize Ionic and Capacitor Android application.
- Confirm Drizzle schema/migrations with the selected native SQLite adapter.
- Build a minimal Kotlin Capacitor plugin.
- Start a foreground service and retain it after UI closure.
- Discover two Android devices on representative office Wi-Fi.
- Exchange, store, and acknowledge one signed test event.
- Verify behavior under screen lock, Doze, Wi-Fi loss, and app swipe-away.

Exit criterion: two physical Android devices exchange a persisted event while one UI is closed.

### Phase 1: Local domain application

- Identity onboarding.
- Channel creation.
- Database schema and migrations.
- Event creation, validation, reducers, and projection rebuild.
- Local chat and Kanban workflows.
- Roles and permission checks.
- Conflict-resolution unit tests.

### Phase 2: Peer synchronization

- Discovery abstraction and NSD implementation.
- Authenticated transport.
- Sync summaries, missing-range requests, batching, acknowledgements, and retries.
- Duplicate suppression and rejected-event quarantine.
- Multi-peer relay tests.

### Phase 3: Membership and security

- Invitation code creation and parsing.
- Join request and lead approval.
- Signed membership and role events.
- Channel payload encryption and protected key storage.
- Member removal and channel key rotation.

### Phase 4: Background behavior and notifications

- Production foreground service lifecycle.
- Local content notifications and deep links.
- Boot/network recovery.
- Battery-optimization guidance and status diagnostics.

### Phase 5: Hardening and MVP release

- Multi-device conflict, relay, and reconnection testing.
- Office network compatibility testing.
- Performance, accessibility, migration, and failure testing.
- Security review of protocol, logs, invitation handling, and key lifecycle.
- User-facing limitation and setup documentation.

## 22. Acceptance Criteria

### Channel and membership

- [ ] A new user can create a channel offline and becomes its only lead.
- [ ] A lead can generate a copyable, expiring invitation code.
- [ ] A second device can paste the code, request access, and be approved on the same Wi-Fi.
- [ ] A non-lead cannot approve members or appoint a co-lead.
- [ ] A lead can appoint and remove a co-lead.
- [ ] Removed members' later events are rejected.

### Tasks and Kanban

- [ ] A lead or co-lead can create, edit, prioritize, assign, reassign, archive, and reopen a task.
- [ ] An ordinary member cannot edit arbitrary task fields.
- [ ] An assignee can update the status of their task.
- [ ] An assigned task appears on the assignee's personal board after synchronization.
- [ ] Completing a task produces exactly one corresponding system chat item per completion transition.
- [ ] Concurrent changes to different task fields merge.
- [ ] Concurrent changes to the same field resolve identically on all synchronized devices.

### Messaging and synchronization

- [ ] A text message reaches an online authorized peer on the same compatible Wi-Fi.
- [ ] Offline-created messages and task changes synchronize after reconnection.
- [ ] A third node can receive an event relayed through a second node.
- [ ] Duplicate event delivery never duplicates messages, task activity, or notifications.
- [ ] Invalid signatures and unauthorized mutations do not alter materialized state.
- [ ] Restarting the app during synchronization does not lose a committed local event.

### Background and notifications

- [ ] With the UI closed and foreground service running, an Android device receives and stores an event.
- [ ] A task assignment produces one notification with a working task deep link.
- [ ] A new chat message produces one notification when the chat is not visible.
- [ ] The app accurately reports when synchronization is stopped or restricted.
- [ ] Force-stop and unavailable-peer limitations are documented in the app.

## 23. Testing Strategy

### 23.1 Unit tests

- Permission matrix for every event type.
- Event canonicalization and signature verification.
- Lamport clock updates.
- Field-level conflict ordering.
- Event reducers and idempotency.
- Invitation parsing, expiry, and single-use behavior.
- Completion system-message derivation.

### 23.2 Database tests

- Fresh installation and every migration path.
- Transaction rollback on reducer failure.
- Unique event and author-sequence constraints.
- Projection rebuild from event history.
- Concurrent UI/service access under WAL mode.

### 23.3 Protocol tests

- Valid and invalid event fixtures shared between TypeScript and Kotlin.
- Missing ranges, out-of-order batches, duplicates, and gaps.
- Corrupt payloads, oversized frames, unknown versions, and invalid signatures.
- Connection interruption and resume.
- Three-node store-and-forward topology.

### 23.4 Android tests

- UI active, UI swiped away, screen locked, Doze, reboot, and force-stop behavior.
- Notification permission allowed and denied.
- Wi-Fi disconnect/reconnect and IP address change.
- Battery optimization enabled and excluded.
- At least two Android versions and two device vendors where possible.

### 23.5 Conflict scenarios

- Lead and co-lead change different task fields offline.
- Lead and co-lead change the same field offline.
- Task is reassigned while previous assignee marks it complete.
- Member is removed while authoring offline events.
- Co-lead role is revoked while that device has pending privileged events.

Expected outcomes for these scenarios MUST be recorded as protocol fixtures, not left to manual interpretation.

## 24. Known Constraints and Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Android background restrictions | Delayed or stopped delivery | Foreground service, status UI, battery guidance, physical-device tests |
| Wi-Fi client isolation or blocked mDNS | Peers cannot discover/connect | Network preflight, alternate discovery strategy, deployment checklist |
| No peer is continuously online | Delayed eventual delivery | Store-and-forward on all nodes; later add optional stable relay node |
| Device clocks differ | Incorrect wall-clock ordering | Lamport clocks for conflict decisions |
| Concurrent privileged events | Complex authorization ordering | Deterministic validation rules and protocol fixtures |
| Removed member retains old data/key | Confidentiality limitations | Key rotation; clearly document inability to erase copied data |
| Capacitor/Drizzle/native SQLite mismatch | Persistence integration delay | Phase 0 adapter proof of concept |
| Native service and web view share SQLite | Locking or corruption risk | WAL, transactions, serialized writes, stress tests |
| Custom cryptographic protocol mistakes | Data exposure or impersonation | Standard libraries, documented suite, security review |
| Event log growth | Storage and sync slowdown | Indexing, bounded batches; snapshots/compaction after MVP |

The largest product risk is the phrase “messages arrive when the app is closed.” The MVP satisfies it only while the foreground service is running and Android/network policy permits communication.

## 25. Out of Scope

- iOS support.
- Bluetooth, Wi-Fi Direct, or internet relay.
- Cloud accounts, cloud backup, or web dashboard.
- Guaranteed delivery when every source/relay node is offline.
- Silent background operation without a persistent Android notification.
- Multiple devices linked to one user identity.
- Lead transfer or multiple equal channel owners.
- Direct/private messages.
- Message edits, deletion, reactions, threads, and read receipts.
- File, image, voice, or video attachments.
- Task subtasks, recurring tasks, dependencies, and custom workflows.
- Calendar integration.
- Remote wipe of data already synchronized to another device.
- Full event-log compaction and archival protocol.

## 26. Future Enhancements

- QR code rendering and scanning of the existing invitation string.
- Optional always-on local department relay node.
- Internet relay with end-to-end encrypted channel payloads.
- iOS client with platform-specific background behavior.
- Bluetooth or nearby fallback discovery.
- Multi-device user identities and device revocation.
- Lead transfer and stronger channel governance.
- Attachments, replies, reactions, and mentions.
- Task dependencies, subtasks, recurring tasks, and custom columns.
- Search, export, backup, snapshots, and event-log compaction.
- Administrative network diagnostics.

## 27. Open Implementation Decisions

These decisions must be resolved during Phase 0 or in architecture decision records:

1. Ionic framework choice if not already selected: Angular, React, or Vue.
2. Minimum Android SDK and target SDK.
3. Capacitor SQLite package and exact Drizzle adapter strategy.
4. Whether the Kotlin service directly accesses SQLite or calls a shared native repository layer.
5. NSD only versus NSD plus UDP multicast fallback.
6. WebSocket versus custom framed TCP transport.
7. Canonical JSON versus deterministic binary event encoding.
8. Exact signing, key-agreement, and channel-encryption libraries.
9. Maximum event, batch, channel, member, task, and history sizes.
10. Deterministic authorization behavior for privileged offline events created before role removal but received afterward.
11. Notification policy for general task edits and completions.
12. Whether key rotation is mandatory for the first internal pilot or a release-blocking post-prototype requirement.

Default recommendation for item 10: validate privileges against the accepted causal membership history where possible; if causality cannot be proven, reject privileged events received after the role-removal event and retain them in rejected history for review.

## 28. MVP Definition of Done

Nodic MVP is complete when:

1. All mandatory acceptance criteria pass on at least three physical Android devices.
2. Devices can form a channel, approve membership, exchange chat messages, and relay task events on the department Wi-Fi without internet access.
3. Lead and co-lead task edits converge deterministically after offline conflicts.
4. An assignee receives a task while the UI is closed and the foreground service is running.
5. Completing a task updates every synchronized board and creates one channel completion item.
6. Invalid or unauthorized events cannot mutate accepted state.
7. Database migrations, process interruption, reconnection, and duplicate delivery tests pass.
8. Known Android, network, retention, and revocation limitations are visible in user-facing documentation.
9. No private key, channel key, invitation secret, task body, or message body appears in normal logs.
10. The internal pilot build can be installed and operated from written setup instructions without developer intervention.
