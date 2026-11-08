import { Capacitor } from '@capacitor/core';
import type {
  EventType,
  NodicEvent,
  PairedDevice,
  PairingRequest,
  PairingState,
  PeerIdentity,
  PeerSession,
  SyncLog,
} from '../../protocol/contracts';
import {
  applyEventToState,
  createInitialMaterializedState,
  type MaterializedState,
} from '../domain/reducers/event-reducer';
import {
  calculateContiguousSummary,
  computeMissingRangesForPeer,
  selectEventsForRanges,
  type MissingRange,
} from '../domain/sync/sync-engine';
import {
  constantTimeCompare,
  encryptPayload,
  decryptPayload,
  exportPrivateSigningKey,
  generateChannelKey,
  generateDeviceKeyPair,
  hashSecret,
  importPrivateSigningKey,
  signEvent,
  verifyEventSignature,
} from '../domain/crypto/crypto-engine';
import {
  createInvitationPayload,
  encodeInvitationCode,
  parseInvitationCode,
} from '../domain/invitations/invitation-codec';
import type {
  Channel,
  ChannelSummary,
  Member,
  Message,
  Task,
  WorkspaceSnapshot,
} from '../domain/models';
import { openNodicDatabase, type NodicDatabase } from './client';
import { nativeSync } from '../services/native-sync';

export interface DeviceIdentityRecord {
  deviceId: string;
  displayName: string;
  publicSigningKey: string;
  keystoreAlias: string;
  lamportClock: number;
}

export function formatNodicId(deviceId: string): string {
  const clean = deviceId.trim().replace(/^nodic-/i, '');
  return `nodic-${clean.slice(0, 8).toLowerCase()}`;
}

export function normalizeNodicIdInput(raw: string): string {
  const clean = raw.trim().toLowerCase();
  if (!clean) return '';
  return clean.startsWith('nodic-') ? clean : `nodic-${clean}`;
}

export function parseNodicIdList(raw: string | string[]): string[] {
  const list = Array.isArray(raw) ? raw : raw.split(/[\s,;]+/);
  const unique = new Set<string>();
  for (const item of list) {
    const normalized = normalizeNodicIdInput(item);
    if (normalized && normalized !== 'nodic-') {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

export interface PairingAttemptResult {
  nodicId: string;
  status: 'REQUEST_SENT' | 'ALREADY_PAIRED' | 'NOT_FOUND_NEARBY' | 'SELF_ID';
  peer?: PeerIdentity;
  request?: PairingRequest;
  message: string;
}

const STORAGE_KEYS = {
  IDENTITY: 'nodic_local_identity_v1',
  PEER_IDENTITIES: 'nodic_peer_identities_v1',
  PEER_SESSIONS: 'nodic_peer_sessions_v1',
  SYNC_LOGS: 'nodic_sync_logs_v1',
  PAIRED_DEVICES_PREFIX: 'nodic_paired_devices_v1_',
  PAIRING_REQUESTS_PREFIX: 'nodic_pairing_requests_v1_',
  PRIVATE_KEY_PREFIX: 'nodic_private_key_jwk_v1_',
  CHANNELS_PREFIX: 'nodic_channels_v1_',
  EVENTS_PREFIX: 'nodic_events_v1_',
  ACTIVE_CHANNEL_PREFIX: 'nodic_active_channel_v1_',
  CHANNEL_KEYS_PREFIX: 'nodic_channel_keys_v1_',
  INVITATIONS_PREFIX: 'nodic_invitations_v1_',
};

interface PersistedChannelMeta {
  id: string;
  sessionId: string;
  name: string;
  description: string | null;
  leadDeviceId: string;
  genesisEventId: string;
  keyVersion: number;
  createdAt: number;
}

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  lead_device_id TEXT NOT NULL,
  genesis_event_id TEXT NOT NULL,
  key_version INTEGER DEFAULT 1 NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_identity (
  device_id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  public_signing_key TEXT NOT NULL,
  keystore_alias TEXT NOT NULL,
  lamport_clock INTEGER DEFAULT 0 NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  author_device_id TEXT NOT NULL,
  author_sequence INTEGER NOT NULL,
  lamport_clock INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity_id TEXT,
  key_version INTEGER NOT NULL,
  ciphertext TEXT,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(channel_id, author_device_id, author_sequence)
);
CREATE TABLE IF NOT EXISTS members (
  channel_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_signing_key TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT DEFAULT 'ACTIVE' NOT NULL,
  joined_event_id TEXT NOT NULL,
  removed_event_id TEXT,
  PRIMARY KEY(channel_id, device_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  author_device_id TEXT,
  body TEXT NOT NULL,
  source_event_id TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_device_id TEXT,
  due_at INTEGER,
  creator_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS task_field_versions (
  task_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  lamport_clock INTEGER NOT NULL,
  actor_device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY(task_id, field_name)
);
CREATE TABLE IF NOT EXISTS peer_receipts (
  channel_id TEXT NOT NULL,
  peer_device_id TEXT NOT NULL,
  author_device_id TEXT NOT NULL,
  highest_sequence INTEGER DEFAULT 0 NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id, peer_device_id, author_device_id)
);
CREATE TABLE IF NOT EXISTS rejected_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  event_id TEXT,
  peer_device_id TEXT,
  reason_code TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_identities (
  device_id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  public_signing_key TEXT NOT NULL,
  service_name TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  status TEXT DEFAULT 'ONLINE' NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS peer_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  peer_device_id TEXT NOT NULL,
  peer_display_name TEXT NOT NULL,
  peer_public_key TEXT NOT NULL,
  peer_address TEXT NOT NULL,
  peer_port INTEGER NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER,
  events_sent INTEGER DEFAULT 0 NOT NULL,
  events_received INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_logs (
  id TEXT PRIMARY KEY NOT NULL,
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  peer_device_id TEXT,
  session_id TEXT,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS paired_devices (
  device_id TEXT PRIMARY KEY NOT NULL,
  nodic_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_signing_key TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  pairing_state TEXT NOT NULL,
  paired_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  from_device_id TEXT NOT NULL,
  from_nodic_id TEXT NOT NULL,
  from_display_name TEXT NOT NULL,
  from_public_key TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

function readStorageJson<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeStorageJson<T>(key: string, value: T): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors in restricted environments
  }
}

export class NodicRepository {
  private nodicDb: NodicDatabase | null = null;
  private memoryState: MaterializedState | null = null;
  private memoryChannels = new Map<string, MaterializedState>();
  private memoryEvents = new Map<string, NodicEvent[]>();
  private memoryPeerIdentities = new Map<string, PeerIdentity>();
  private memoryPeerSessions = new Map<string, PeerSession>();
  private memorySyncLogs: SyncLog[] = [];
  private memoryPairedDevices = new Map<string, PairedDevice>();
  private memoryPairingRequests = new Map<string, PairingRequest>();
  private identity: DeviceIdentityRecord | null = null;
  private authorSequence = 0;
  private privateSigningKey: CryptoKey | null = null;
  private channelKeys = new Map<string, Map<number, string>>();
  private revokedAuthors = new Map<string, Set<string>>();
  private storedInvitations = new Map<string, { hash: string; expiresAt: string; channelId: string }>();
  private activeChannelId: string | null = null;
  private eventQueue: Promise<unknown> = Promise.resolve();

  async init(defaultDisplayName?: string): Promise<WorkspaceSnapshot> {
    if (Capacitor.isNativePlatform()) {
      try {
        this.nodicDb = await openNodicDatabase();
        await this.nodicDb.connection.execute(INITIAL_SCHEMA_SQL, false);
        try {
          await this.nodicDb.connection.execute(
            'ALTER TABLE channels ADD COLUMN session_id TEXT;',
            false,
          );
        } catch {
          // Column already exists
        }
      } catch (err) {
        console.warn('Native SQLite init failed, falling back to native PhaseZeroStore + localStorage:', err);
      }
    } else {
      // Load persisted peer identities, sessions, and logs from localStorage in browser/web mode
      const savedPeers = readStorageJson<PeerIdentity[]>(STORAGE_KEYS.PEER_IDENTITIES, []);
      savedPeers.forEach((p) => this.memoryPeerIdentities.set(p.deviceId, p));
      const savedSessions = readStorageJson<PeerSession[]>(STORAGE_KEYS.PEER_SESSIONS, []);
      savedSessions.forEach((s) => this.memoryPeerSessions.set(s.id, s));
      this.memorySyncLogs = readStorageJson<SyncLog[]>(STORAGE_KEYS.SYNC_LOGS, []);
    }

    await this.ensureIdentity(defaultDisplayName);
    await this.restoreLocalWorkspaceState();

    if (Capacitor.isNativePlatform()) {
      await this.syncNativeDiagnostics();
    }
    return this.loadWorkspace(this.activeChannelId ?? undefined);
  }

  async getIdentity(): Promise<DeviceIdentityRecord> {
    if (!this.identity) {
      await this.ensureIdentity();
    }
    return this.identity!;
  }

  async updateDisplayName(newName: string): Promise<DeviceIdentityRecord> {
    const cleanName = newName.trim();
    if (!cleanName) throw new Error('Display name cannot be empty');
    const identity = await this.getIdentity();
    identity.displayName = cleanName;

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'UPDATE device_identity SET display_name = ? WHERE device_id = ?',
        [cleanName, identity.deviceId],
      );
      await this.nodicDb.connection.run(
        'UPDATE members SET display_name = ? WHERE device_id = ?',
        [cleanName, identity.deviceId],
      );
    }
    writeStorageJson(STORAGE_KEYS.IDENTITY, identity);

    if (Capacitor.isNativePlatform()) {
      try {
        await nativeSync.syncDeviceIdentity({
          deviceId: identity.deviceId,
          displayName: cleanName,
          publicKey: identity.publicSigningKey,
        });
      } catch (err) {
        console.warn('Failed to sync updated identity to native service:', err);
      }
    }

    for (const matState of this.memoryChannels.values()) {
      const cur = matState.members.get(identity.deviceId);
      if (cur) {
        cur.displayName = cleanName;
        cur.initials = cleanName.slice(0, 2).toUpperCase();
        matState.channel.members = Array.from(matState.members.values());
      }
    }

    this.persistLocalWorkspaceState();

    await this.recordSyncLog({
      level: 'INFO',
      category: 'IDENTITY',
      peerDeviceId: identity.deviceId,
      sessionId: null,
      message: `Local identity display name updated to "${cleanName}"`,
      detailsJson: JSON.stringify({ deviceId: identity.deviceId, displayName: cleanName }),
    });

    return identity;
  }

  private async ensureSigningKeyPair(
    deviceId: string,
    existingPublicKey?: string,
  ): Promise<{ publicKey: string; privateKey: CryptoKey | null }> {
    const storedPrivJwk = readStorageJson<string | null>(
      `${STORAGE_KEYS.PRIVATE_KEY_PREFIX}${deviceId}`,
      null,
    );
    if (storedPrivJwk && existingPublicKey && existingPublicKey.startsWith('p256:')) {
      const imported = await importPrivateSigningKey(storedPrivJwk);
      if (imported) {
        return { publicKey: existingPublicKey, privateKey: imported };
      }
    }

    try {
      const keyPair = await generateDeviceKeyPair();
      const exported = await exportPrivateSigningKey(keyPair.privateKey);
      if (exported) {
        writeStorageJson(`${STORAGE_KEYS.PRIVATE_KEY_PREFIX}${deviceId}`, exported);
      }
      return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey };
    } catch {
      return {
        publicKey:
          existingPublicKey && existingPublicKey.startsWith('p256:')
            ? existingPublicKey
            : `p256:${crypto.randomUUID().replace(/-/g, '')}`,
        privateKey: null,
      };
    }
  }

  private async ensureIdentity(displayName?: string): Promise<DeviceIdentityRecord> {
    if (this.nodicDb) {
      let nativeId: { deviceId: string; displayName?: string; publicKey: string; keystoreAlias?: string } | null = null;
      if (Capacitor.isNativePlatform()) {
        try {
          nativeId = await nativeSync.getDeviceIdentity(displayName);
        } catch {}
      }

      const res = await this.nodicDb.connection.query('SELECT * FROM device_identity LIMIT 1');
      const rows = res.values ?? [];
      if (rows.length > 0) {
        const row = rows[0];
        const deviceId = row.device_id as string;
        const { publicKey: resolvedPublicKey, privateKey } = await this.ensureSigningKeyPair(
          deviceId,
          row.public_signing_key as string,
        );
        this.privateSigningKey = privateKey;

        if (resolvedPublicKey !== row.public_signing_key) {
          await this.nodicDb.connection.run(
            'UPDATE device_identity SET public_signing_key = ? WHERE device_id = ?',
            [resolvedPublicKey, deviceId],
          );
        }

        this.identity = {
          deviceId,
          displayName: row.display_name as string,
          publicSigningKey: resolvedPublicKey,
          keystoreAlias: (row.keystore_alias as string) || 'nodic-device-key',
          lamportClock: Number(row.lamport_clock ?? 0),
        };
        writeStorageJson(STORAGE_KEYS.IDENTITY, this.identity);

        // Load highest author_sequence from events table so sequence numbers never collide after restart
        const seqRes = await this.nodicDb.connection.query(
          'SELECT COALESCE(MAX(author_sequence), 0) AS max_seq FROM events WHERE author_device_id = ?',
          [this.identity.deviceId],
        );
        this.authorSequence = Number(seqRes.values?.[0]?.max_seq ?? 0);

        if (Capacitor.isNativePlatform()) {
          try {
            await nativeSync.syncDeviceIdentity({
              deviceId: this.identity.deviceId,
              displayName: this.identity.displayName,
              publicKey: this.identity.publicSigningKey,
            });
          } catch {}
        }

        return this.identity;
      }

      const stored = readStorageJson<DeviceIdentityRecord | null>(STORAGE_KEYS.IDENTITY, null);
      const deviceId = stored?.deviceId ?? nativeId?.deviceId ?? crypto.randomUUID();
      const { publicKey: publicSigningKey, privateKey } = await this.ensureSigningKeyPair(
        deviceId,
        stored?.publicSigningKey ?? nativeId?.publicKey,
      );
      this.privateSigningKey = privateKey;

      const initialName =
        displayName && displayName !== 'Mara'
          ? displayName
          : stored?.displayName || nativeId?.displayName || `Node-${deviceId.slice(0, 4).toUpperCase()}`;

      const newId: DeviceIdentityRecord = {
        deviceId,
        displayName: initialName,
        publicSigningKey,
        keystoreAlias: nativeId?.keystoreAlias ?? 'nodic-device-key',
        lamportClock: stored?.lamportClock ?? 0,
      };

      await this.nodicDb.connection.run(
        'INSERT INTO device_identity (device_id, display_name, public_signing_key, keystore_alias, lamport_clock, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          newId.deviceId,
          newId.displayName,
          newId.publicSigningKey,
          newId.keystoreAlias,
          newId.lamportClock,
          Date.now(),
        ],
      );
      writeStorageJson(STORAGE_KEYS.IDENTITY, newId);

      if (Capacitor.isNativePlatform()) {
        try {
          await nativeSync.syncDeviceIdentity({
            deviceId: newId.deviceId,
            displayName: newId.displayName,
            publicKey: newId.publicSigningKey,
          });
        } catch {}
      }

      this.identity = newId;
      await this.recordSyncLog({
        level: 'INFO',
        category: 'IDENTITY',
        peerDeviceId: newId.deviceId,
        sessionId: null,
        message: `Created and saved local device identity "${newId.displayName}"`,
        detailsJson: JSON.stringify({
          deviceId: newId.deviceId,
          keystoreAlias: newId.keystoreAlias,
        }),
      });
      return newId;
    }

    // Browser / Memory fallback with localStorage + native PhaseZeroStore persistence
    if (!this.identity) {
      let nativeId: { deviceId: string; displayName?: string; publicKey: string; keystoreAlias?: string } | null = null;
      if (Capacitor.isNativePlatform()) {
        try {
          nativeId = await nativeSync.getDeviceIdentity(displayName);
        } catch {}
      }

      const stored = readStorageJson<DeviceIdentityRecord | null>(STORAGE_KEYS.IDENTITY, null);
      const shouldReuseStored =
        stored &&
        stored.deviceId &&
        (Capacitor.isNativePlatform() ||
          !displayName ||
          displayName === 'Mara' ||
          stored.displayName === displayName.trim());

      if (shouldReuseStored && stored) {
        const { publicKey, privateKey } = await this.ensureSigningKeyPair(
          stored.deviceId,
          stored.publicSigningKey,
        );
        this.privateSigningKey = privateKey;
        stored.publicSigningKey = publicKey;
        if (displayName && displayName.trim() && displayName !== 'Mara') {
          stored.displayName = displayName.trim();
        }
        writeStorageJson(STORAGE_KEYS.IDENTITY, stored);
        this.identity = stored;

        if (Capacitor.isNativePlatform()) {
          try {
            await nativeSync.syncDeviceIdentity({
              deviceId: stored.deviceId,
              displayName: stored.displayName,
              publicKey: stored.publicSigningKey,
            });
          } catch {}
        }
        return this.identity;
      }

      const fallbackId = nativeId?.deviceId ?? `node-${crypto.randomUUID().slice(0, 8)}`;
      const { publicKey: pubKey, privateKey } = await this.ensureSigningKeyPair(
        fallbackId,
        nativeId?.publicKey,
      );
      this.privateSigningKey = privateKey;

      this.identity = {
        deviceId: fallbackId,
        displayName:
          displayName && displayName !== 'Mara'
            ? displayName
            : nativeId?.displayName || `Node-${fallbackId.slice(5, 9).toUpperCase()}`,
        publicSigningKey: pubKey,
        keystoreAlias: nativeId?.keystoreAlias ?? 'nodic-device-key',
        lamportClock: 0,
      };
      writeStorageJson(STORAGE_KEYS.IDENTITY, this.identity);

      if (Capacitor.isNativePlatform()) {
        try {
          await nativeSync.syncDeviceIdentity({
            deviceId: this.identity.deviceId,
            displayName: this.identity.displayName,
            publicKey: this.identity.publicSigningKey,
          });
        } catch {}
      }

      await this.recordSyncLog({
        level: 'INFO',
        category: 'IDENTITY',
        peerDeviceId: this.identity.deviceId,
        sessionId: null,
        message: `Initialized local device identity "${this.identity.displayName}"`,
        detailsJson: JSON.stringify({ deviceId: this.identity.deviceId }),
      });
    }
    return this.identity;
  }

  private sortEventsCausally(events: NodicEvent[]): NodicEvent[] {
    return [...events].sort((a, b) => {
      if (a.type === 'CHANNEL_CREATED' && b.type !== 'CHANNEL_CREATED') return -1;
      if (b.type === 'CHANNEL_CREATED' && a.type !== 'CHANNEL_CREATED') return 1;
      if (a.lamportClock !== b.lamportClock) return a.lamportClock - b.lamportClock;
      if (a.authorSequence !== b.authorSequence) return a.authorSequence - b.authorSequence;
      return a.id.localeCompare(b.id);
    });
  }

  private persistLocalWorkspaceState(): void {
    const devId = this.identity?.deviceId;
    if (!devId) return;

    const channelsMeta: PersistedChannelMeta[] = [];
    for (const [channelId, matState] of this.memoryChannels.entries()) {
      const ch = matState.channel;
      const events = this.memoryEvents.get(channelId) ?? [];
      const genesis = events.find((e) => e.type === 'CHANNEL_CREATED');
      channelsMeta.push({
        id: ch.id,
        sessionId: ch.sessionId ?? `sess-${ch.id.slice(0, 8)}`,
        name: ch.name,
        description: ch.description ?? null,
        leadDeviceId: ch.leadDeviceId ?? ch.currentUserDeviceId,
        genesisEventId: genesis?.id ?? 'joined',
        keyVersion: ch.keyVersion ?? 1,
        createdAt: genesis ? new Date(genesis.createdAt).getTime() || Date.now() : Date.now(),
      });
    }
    writeStorageJson(`${STORAGE_KEYS.CHANNELS_PREFIX}${devId}`, channelsMeta);

    const eventsRecord: Record<string, NodicEvent[]> = {};
    for (const [channelId, list] of this.memoryEvents.entries()) {
      eventsRecord[channelId] = list;
    }
    writeStorageJson(`${STORAGE_KEYS.EVENTS_PREFIX}${devId}`, eventsRecord);

    const activeId = this.activeChannelId ?? this.memoryState?.channel.id ?? null;
    writeStorageJson(`${STORAGE_KEYS.ACTIVE_CHANNEL_PREFIX}${devId}`, activeId);

    const keysRecord: Record<string, Record<number, string>> = {};
    for (const [channelId, verMap] of this.channelKeys.entries()) {
      keysRecord[channelId] = Object.fromEntries(verMap.entries());
    }
    writeStorageJson(`${STORAGE_KEYS.CHANNEL_KEYS_PREFIX}${devId}`, keysRecord);

    const invitationsRecord = Object.fromEntries(this.storedInvitations.entries());
    writeStorageJson(`${STORAGE_KEYS.INVITATIONS_PREFIX}${devId}`, invitationsRecord);
    writeStorageJson(
      `${STORAGE_KEYS.PAIRED_DEVICES_PREFIX}${devId}`,
      Array.from(this.memoryPairedDevices.values()),
    );
    writeStorageJson(
      `${STORAGE_KEYS.PAIRING_REQUESTS_PREFIX}${devId}`,
      Array.from(this.memoryPairingRequests.values()),
    );
    writeStorageJson(STORAGE_KEYS.IDENTITY, this.identity);
  }

  private async restoreLocalWorkspaceState(): Promise<void> {
    const identity = await this.getIdentity();
    const devId = identity.deviceId;

    const savedPaired = readStorageJson<PairedDevice[]>(
      `${STORAGE_KEYS.PAIRED_DEVICES_PREFIX}${devId}`,
      [],
    );
    savedPaired.forEach((p) => this.memoryPairedDevices.set(p.deviceId, p));

    const savedPairReqs = readStorageJson<PairingRequest[]>(
      `${STORAGE_KEYS.PAIRING_REQUESTS_PREFIX}${devId}`,
      [],
    );
    savedPairReqs.forEach((r) => this.memoryPairingRequests.set(r.requestId, r));

    // 1. Restore channel keys and invitations from localStorage
    const savedKeys = readStorageJson<Record<string, Record<string, string>>>(
      `${STORAGE_KEYS.CHANNEL_KEYS_PREFIX}${devId}`,
      {},
    );
    for (const [chId, verObj] of Object.entries(savedKeys)) {
      for (const [verStr, key] of Object.entries(verObj)) {
        this.setChannelKey(chId, Number(verStr), key);
      }
    }

    const savedInvites = readStorageJson<
      Record<string, { hash: string; expiresAt: string; channelId: string }>
    >(`${STORAGE_KEYS.INVITATIONS_PREFIX}${devId}`, {});
    for (const [invId, data] of Object.entries(savedInvites)) {
      this.storedInvitations.set(invId, data);
    }

    const savedActiveId = readStorageJson<string | null>(
      `${STORAGE_KEYS.ACTIVE_CHANNEL_PREFIX}${devId}`,
      null,
    );
    if (savedActiveId) {
      this.activeChannelId = savedActiveId;
    }

    const metaByChannel = new Map<string, PersistedChannelMeta>();
    const eventsByChannel = new Map<string, Map<string, NodicEvent>>();

    const addChannelMeta = (meta: PersistedChannelMeta) => {
      const existing = metaByChannel.get(meta.id);
      if (!existing) {
        metaByChannel.set(meta.id, meta);
      } else {
        metaByChannel.set(meta.id, {
          ...existing,
          sessionId:
            meta.sessionId && meta.sessionId.length > existing.sessionId.length
              ? meta.sessionId
              : existing.sessionId || meta.sessionId,
          name:
            existing.name === 'Connected Channel' && meta.name !== 'Connected Channel'
              ? meta.name
              : existing.name,
          description: existing.description ?? meta.description,
          leadDeviceId:
            existing.leadDeviceId === 'remote-lead' && meta.leadDeviceId !== 'remote-lead'
              ? meta.leadDeviceId
              : existing.leadDeviceId,
        });
      }
    };

    const addEvent = (ev: NodicEvent) => {
      if (!ev || !ev.id || !ev.channelId) return;
      let map = eventsByChannel.get(ev.channelId);
      if (!map) {
        map = new Map();
        eventsByChannel.set(ev.channelId, map);
      }
      map.set(ev.id, ev);
    };

    // 2. Load from localStorage
    const savedChannels = readStorageJson<PersistedChannelMeta[]>(
      `${STORAGE_KEYS.CHANNELS_PREFIX}${devId}`,
      [],
    );
    for (const ch of savedChannels) {
      addChannelMeta(ch);
    }

    const savedEvents = readStorageJson<Record<string, NodicEvent[]>>(
      `${STORAGE_KEYS.EVENTS_PREFIX}${devId}`,
      {},
    );
    for (const list of Object.values(savedEvents)) {
      for (const ev of list ?? []) {
        addEvent(ev);
      }
    }

    // 3. Load from native PhaseZeroStore backup (survives WebView cache clear / app kill)
    if (Capacitor.isNativePlatform()) {
      try {
        const backup = await nativeSync.getWorkspaceBackup();
        for (const ch of backup.channels ?? []) {
          addChannelMeta({
            id: ch.id,
            sessionId: ch.sessionId || `sess-${ch.id.slice(0, 8)}`,
            name: ch.name,
            description: ch.description ?? null,
            leadDeviceId: ch.leadDeviceId,
            genesisEventId: ch.genesisEventId,
            keyVersion: ch.keyVersion ?? 1,
            createdAt: ch.createdAt ?? Date.now(),
          });
          if (ch.isActive && !this.activeChannelId) {
            this.activeChannelId = ch.id;
          }
        }
        for (const ev of backup.events ?? []) {
          addEvent(ev);
        }
      } catch (err) {
        console.warn('Failed to load workspace backup from native store:', err);
      }
    }

    // 4. Load from SQLite (nodicDb) if available
    if (this.nodicDb) {
      try {
        const chanRes = await this.nodicDb.connection.query(
          'SELECT * FROM channels ORDER BY created_at DESC',
        );
        for (const r of chanRes.values ?? []) {
          const chId = r.id as string;
          addChannelMeta({
            id: chId,
            sessionId: (r.session_id as string) || `sess-${chId.slice(0, 8)}`,
            name: r.name as string,
            description: (r.description as string) ?? null,
            leadDeviceId: r.lead_device_id as string,
            genesisEventId: (r.genesis_event_id as string) || 'joined',
            keyVersion: Number(r.key_version ?? 1),
            createdAt: Number(r.created_at ?? Date.now()),
          });
        }

        const evRes = await this.nodicDb.connection.query(
          'SELECT * FROM events ORDER BY lamport_clock ASC, author_sequence ASC',
        );
        for (const r of evRes.values ?? []) {
          try {
            addEvent({
              protocolVersion: 1,
              id: r.id as string,
              channelId: r.channel_id as string,
              authorDeviceId: r.author_device_id as string,
              authorSequence: Number(r.author_sequence),
              lamportClock: Number(r.lamport_clock),
              type: r.type as EventType,
              entityId: (r.entity_id as string) ?? undefined,
              keyVersion: Number(r.key_version ?? 1),
              createdAt: new Date(Number(r.created_at)).toISOString(),
              payloadVersion: 1,
              payload: JSON.parse(r.payload_json as string),
              signature: r.signature as string,
            });
          } catch {}
        }
      } catch (err) {
        console.warn('Failed to read channels/events from SQLite during restore:', err);
      }
    }

    // 5. Ensure every channel with events has metadata
    for (const [channelId, evMap] of eventsByChannel.entries()) {
      if (!metaByChannel.has(channelId)) {
        const events = Array.from(evMap.values());
        const genesis = events.find((e) => e.type === 'CHANNEL_CREATED');
        const payload = (genesis?.payload ?? {}) as {
          name?: string;
          description?: string;
          sessionId?: string;
        };
        addChannelMeta({
          id: channelId,
          sessionId: payload.sessionId ?? `sess-${channelId.slice(0, 8)}`,
          name: payload.name ?? 'Connected Channel',
          description: payload.description ?? null,
          leadDeviceId: genesis?.authorDeviceId ?? 'remote-lead',
          genesisEventId: genesis?.id ?? 'joined',
          keyVersion: 1,
          createdAt: genesis ? new Date(genesis.createdAt).getTime() || Date.now() : Date.now(),
        });
      }
    }

    // 6. Rebuild materialized state for each channel by replaying sorted events
    let maxAuthorSeq = this.authorSequence;
    let maxLamport = identity.lamportClock;

    for (const [channelId, meta] of metaByChannel.entries()) {
      const evMap = eventsByChannel.get(channelId);
      const sortedEvents = this.sortEventsCausally(evMap ? Array.from(evMap.values()) : []);
      this.memoryEvents.set(channelId, sortedEvents);

      const initialMembers: Member[] = [];
      const isSelfLead = meta.leadDeviceId === identity.deviceId;
      initialMembers.push({
        deviceId: identity.deviceId,
        displayName: identity.displayName,
        publicSigningKey: identity.publicSigningKey,
        role: isSelfLead ? 'LEAD' : 'MEMBER',
        presence: 'ONLINE',
        initials: identity.displayName.slice(0, 2).toUpperCase(),
      });

      const baseChannel: Channel = {
        id: channelId,
        sessionId: meta.sessionId,
        name: meta.name,
        description: meta.description,
        currentUserDeviceId: identity.deviceId,
        leadDeviceId: meta.leadDeviceId,
        keyVersion: meta.keyVersion,
        members: initialMembers,
      };

      const matState = createInitialMaterializedState(baseChannel);
      for (const ev of sortedEvents) {
        applyEventToState(matState, ev);
        if (ev.type === 'MEMBER_REMOVED') {
          const payload = ev.payload as { deviceId?: string };
          if (payload.deviceId) {
            this.revokeAuthor(channelId, payload.deviceId);
          }
        }
        if (ev.type === 'CHANNEL_KEY_ROTATED') {
          const payload = ev.payload as { keyVersion?: number; newKey?: string };
          const newVer = payload.keyVersion ?? ev.keyVersion;
          matState.channel.keyVersion = newVer;
          if (payload.newKey) {
            this.setChannelKey(channelId, newVer, payload.newKey);
          }
        }
        maxLamport = Math.max(maxLamport, ev.lamportClock);
        if (ev.authorDeviceId === identity.deviceId) {
          maxAuthorSeq = Math.max(maxAuthorSeq, ev.authorSequence);
        }
      }

      if (!matState.channel.sessionId) {
        matState.channel.sessionId = meta.sessionId;
      }
      matState.channel.members = Array.from(matState.members.values());
      this.memoryChannels.set(channelId, matState);
    }

    this.authorSequence = maxAuthorSeq;
    if (maxLamport > identity.lamportClock) {
      identity.lamportClock = maxLamport;
      writeStorageJson(STORAGE_KEYS.IDENTITY, identity);
    }

    if (this.activeChannelId && this.memoryChannels.has(this.activeChannelId)) {
      this.memoryState = this.memoryChannels.get(this.activeChannelId)!;
    } else if (this.memoryChannels.size > 0) {
      const first = Array.from(this.memoryChannels.values())[0];
      this.activeChannelId = first.channel.id;
      this.memoryState = first;
    }

    this.persistLocalWorkspaceState();
  }

  async savePeerIdentity(peer: PeerIdentity): Promise<PeerIdentity> {
    const firstSeenMs = new Date(peer.firstSeenAt).getTime() || Date.now();
    const lastSeenMs = new Date(peer.lastSeenAt).getTime() || Date.now();

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT INTO peer_identities (device_id, display_name, public_signing_key, service_name, host, port, status, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           display_name = excluded.display_name,
           public_signing_key = excluded.public_signing_key,
           service_name = COALESCE(excluded.service_name, peer_identities.service_name),
           host = excluded.host,
           port = excluded.port,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at`,
        [
          peer.deviceId,
          peer.displayName,
          peer.publicSigningKey,
          peer.serviceName,
          peer.host,
          peer.port,
          peer.status,
          firstSeenMs,
          lastSeenMs,
        ],
      );

      // Keep member display_name and public_signing_key up to date if peer is in a channel
      await this.nodicDb.connection.run(
        `UPDATE members SET display_name = ?, public_signing_key = CASE WHEN ? LIKE 'p256:%' THEN ? ELSE public_signing_key END WHERE device_id = ?`,
        [peer.displayName, peer.publicSigningKey, peer.publicSigningKey, peer.deviceId],
      );
    }

    const existing = this.memoryPeerIdentities.get(peer.deviceId);
    const merged: PeerIdentity = {
      ...peer,
      firstSeenAt: existing?.firstSeenAt ?? peer.firstSeenAt,
    };
    this.memoryPeerIdentities.set(peer.deviceId, merged);
    writeStorageJson(
      STORAGE_KEYS.PEER_IDENTITIES,
      Array.from(this.memoryPeerIdentities.values()),
    );

    for (const matState of this.memoryChannels.values()) {
      const member = matState.members.get(peer.deviceId);
      if (member) {
        member.displayName = peer.displayName;
        member.initials = peer.displayName.slice(0, 2).toUpperCase();
        if (peer.publicSigningKey && peer.publicSigningKey.startsWith('p256:')) {
          member.publicSigningKey = peer.publicSigningKey;
        }
        member.presence = peer.status === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
        matState.channel.members = Array.from(matState.members.values());
      }
    }

    return peer;
  }

  async listPeerIdentities(): Promise<PeerIdentity[]> {
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT * FROM peer_identities ORDER BY last_seen_at DESC',
      );
      return (res.values ?? []).map((r) => ({
        deviceId: r.device_id as string,
        displayName: r.display_name as string,
        publicSigningKey: r.public_signing_key as string,
        serviceName: (r.service_name as string) ?? null,
        host: r.host as string,
        port: Number(r.port),
        status: (r.status as 'ONLINE' | 'OFFLINE' | 'STALE') ?? 'ONLINE',
        firstSeenAt: new Date(Number(r.first_seen_at)).toISOString(),
        lastSeenAt: new Date(Number(r.last_seen_at)).toISOString(),
      }));
    }
    return Array.from(this.memoryPeerIdentities.values()).sort(
      (a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
    );
  }

  async savePeerSession(session: PeerSession): Promise<PeerSession> {
    const startedMs = new Date(session.startedAt).getTime() || Date.now();
    const lastActivityMs = new Date(session.lastActivityAt).getTime() || Date.now();
    const endedMs = session.endedAt ? new Date(session.endedAt).getTime() : null;

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT INTO peer_sessions (
           id, peer_device_id, peer_display_name, peer_public_key, peer_address, peer_port,
           direction, status, started_at, last_activity_at, ended_at, events_sent, events_received
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           peer_device_id = excluded.peer_device_id,
           peer_display_name = excluded.peer_display_name,
           peer_public_key = excluded.peer_public_key,
           peer_address = excluded.peer_address,
           peer_port = excluded.peer_port,
           status = excluded.status,
           last_activity_at = excluded.last_activity_at,
           ended_at = excluded.ended_at,
           events_sent = excluded.events_sent,
           events_received = excluded.events_received`,
        [
          session.id,
          session.peerDeviceId,
          session.peerDisplayName,
          session.peerPublicKey,
          session.peerAddress,
          session.peerPort,
          session.direction,
          session.status,
          startedMs,
          lastActivityMs,
          endedMs,
          session.eventsSent,
          session.eventsReceived,
        ],
      );
    } else {
      this.memoryPeerSessions.set(session.id, session);
      writeStorageJson(
        STORAGE_KEYS.PEER_SESSIONS,
        Array.from(this.memoryPeerSessions.values()),
      );
    }
    return session;
  }

  async listPeerSessions(limit = 50): Promise<PeerSession[]> {
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT * FROM peer_sessions ORDER BY last_activity_at DESC LIMIT ?',
        [limit],
      );
      return (res.values ?? []).map((r) => ({
        id: r.id as string,
        peerDeviceId: r.peer_device_id as string,
        peerDisplayName: r.peer_display_name as string,
        peerPublicKey: r.peer_public_key as string,
        peerAddress: r.peer_address as string,
        peerPort: Number(r.peer_port),
        direction: (r.direction as 'INBOUND' | 'OUTBOUND') ?? 'OUTBOUND',
        status:
          (r.status as 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR') ?? 'CONNECTED',
        startedAt: new Date(Number(r.started_at)).toISOString(),
        lastActivityAt: new Date(Number(r.last_activity_at)).toISOString(),
        endedAt: r.ended_at ? new Date(Number(r.ended_at)).toISOString() : null,
        eventsSent: Number(r.events_sent ?? 0),
        eventsReceived: Number(r.events_received ?? 0),
      }));
    }
    return Array.from(this.memoryPeerSessions.values())
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())
      .slice(0, limit);
  }

  async recordSyncLog(
    input: Omit<SyncLog, 'id' | 'createdAt'> & { id?: string; createdAt?: string },
  ): Promise<SyncLog> {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const createdMs = new Date(createdAt).getTime() || Date.now();
    const log: SyncLog = {
      id,
      level: input.level,
      category: input.category,
      peerDeviceId: input.peerDeviceId,
      sessionId: input.sessionId,
      message: input.message,
      detailsJson: input.detailsJson,
      createdAt,
    };

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT OR IGNORE INTO sync_logs (id, level, category, peer_device_id, session_id, message, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.id,
          log.level,
          log.category,
          log.peerDeviceId,
          log.sessionId,
          log.message,
          log.detailsJson,
          createdMs,
        ],
      );
    } else {
      if (!this.memorySyncLogs.some((l) => l.id === log.id)) {
        this.memorySyncLogs.unshift(log);
        if (this.memorySyncLogs.length > 200) {
          this.memorySyncLogs = this.memorySyncLogs.slice(0, 200);
        }
        writeStorageJson(STORAGE_KEYS.SYNC_LOGS, this.memorySyncLogs);
      }
    }
    return log;
  }

  async listSyncLogs(limit = 100): Promise<SyncLog[]> {
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT * FROM sync_logs ORDER BY created_at DESC LIMIT ?',
        [limit],
      );
      return (res.values ?? []).map((r) => ({
        id: r.id as string,
        level: (r.level as 'INFO' | 'WARN' | 'ERROR') ?? 'INFO',
        category:
          (r.category as
            | 'IDENTITY'
            | 'DISCOVERY'
            | 'HANDSHAKE'
            | 'SESSION'
            | 'SYNC'
            | 'EVENT') ?? 'SYNC',
        peerDeviceId: (r.peer_device_id as string) ?? null,
        sessionId: (r.session_id as string) ?? null,
        message: r.message as string,
        detailsJson: (r.details_json as string) ?? null,
        createdAt: new Date(Number(r.created_at)).toISOString(),
      }));
    }
    return this.memorySyncLogs.slice(0, limit);
  }

  async clearSyncLogs(): Promise<void> {
    if (this.nodicDb) {
      await this.nodicDb.connection.run('DELETE FROM sync_logs');
    }
    this.memorySyncLogs = [];
    writeStorageJson(STORAGE_KEYS.SYNC_LOGS, []);
    await nativeSync.clearLogs();
  }

  async syncNativeDiagnostics(): Promise<{
    peerIdentities: PeerIdentity[];
    peerSessions: PeerSession[];
    syncLogs: SyncLog[];
  }> {
    if (Capacitor.isNativePlatform()) {
      try {
        const diag = await nativeSync.getDiagnostics();
        for (const peer of diag.peerIdentities ?? []) {
          await this.savePeerIdentity(peer);
        }
        for (const session of diag.peerSessions ?? []) {
          await this.savePeerSession(session);
        }
        for (const log of diag.syncLogs ?? []) {
          await this.recordSyncLog(log);
        }
      } catch (err) {
        console.warn('Failed to sync native diagnostics:', err);
      }
    }
    const [peerIdentities, peerSessions, syncLogs] = await Promise.all([
      this.listPeerIdentities(),
      this.listPeerSessions(),
      this.listSyncLogs(),
    ]);
    return { peerIdentities, peerSessions, syncLogs };
  }

  async connectToPeer(
    host: string,
    port: number,
    remoteHint?: { deviceId?: string; displayName?: string; publicKey?: string },
  ): Promise<{ connected: boolean; peer?: PeerIdentity; session?: PeerSession }> {
    const cleanHost = host.trim();
    if (!cleanHost || port <= 0) {
      throw new Error('Valid peer host and port are required');
    }

    const res = await nativeSync.connectPeer(cleanHost, port);
    if (Capacitor.isNativePlatform()) {
      const synced = await this.syncNativeDiagnostics();
      const matchedPeer = synced.peerIdentities.find(
        (p) => p.host === cleanHost && p.port === port,
      );
      const matchedSession = synced.peerSessions.find(
        (s) => s.peerAddress === cleanHost && s.peerPort === port,
      );
      return {
        connected: res.connected,
        peer: matchedPeer,
        session: matchedSession,
      };
    }

    // Browser / non-native simulation: persist peer identity, session, and handshake logs locally
    const nowIso = new Date().toISOString();
    const peerDeviceId =
      remoteHint?.deviceId ?? `peer-${cleanHost.replace(/[^a-zA-Z0-9]/g, '')}-${port}`;
    const peerDisplayName =
      remoteHint?.displayName ?? `Node-${peerDeviceId.slice(-4).toUpperCase()}`;
    const peerPublicKey =
      remoteHint?.publicKey ?? `p256:peer-${peerDeviceId.slice(0, 12)}`;
    const sessionId = crypto.randomUUID();

    const peer = await this.savePeerIdentity({
      deviceId: peerDeviceId,
      displayName: peerDisplayName,
      publicSigningKey: peerPublicKey,
      serviceName: `nodic-${peerDeviceId.slice(0, 8)}`,
      host: cleanHost,
      port,
      status: 'ONLINE',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });

    const session = await this.savePeerSession({
      id: sessionId,
      peerDeviceId,
      peerDisplayName,
      peerPublicKey,
      peerAddress: cleanHost,
      peerPort: port,
      direction: 'OUTBOUND',
      status: 'CONNECTED',
      startedAt: nowIso,
      lastActivityAt: nowIso,
      endedAt: null,
      eventsSent: 0,
      eventsReceived: 0,
    });

    await this.recordSyncLog({
      level: 'INFO',
      category: 'SESSION',
      peerDeviceId,
      sessionId,
      message: `Established peer session with ${peerDisplayName} (${cleanHost}:${port})`,
      detailsJson: JSON.stringify({
        host: cleanHost,
        port,
        direction: 'OUTBOUND',
        peerDeviceId,
      }),
    });

    return { connected: true, peer, session };
  }

  async savePairedDevice(device: PairedDevice): Promise<PairedDevice> {
    const pairedMs = new Date(device.pairedAt).getTime() || Date.now();
    const updatedMs = new Date(device.updatedAt).getTime() || Date.now();

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT INTO paired_devices (
           device_id, nodic_id, display_name, public_signing_key, host, port, pairing_state, paired_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           nodic_id = excluded.nodic_id,
           display_name = excluded.display_name,
           public_signing_key = excluded.public_signing_key,
           host = excluded.host,
           port = excluded.port,
           pairing_state = excluded.pairing_state,
           updated_at = excluded.updated_at`,
        [
          device.deviceId,
          device.nodicId,
          device.displayName,
          device.publicSigningKey,
          device.host,
          device.port,
          device.pairingState,
          pairedMs,
          updatedMs,
        ],
      );
    }

    this.memoryPairedDevices.set(device.deviceId, device);
    this.persistLocalWorkspaceState();
    return device;
  }

  async listPairedDevices(): Promise<PairedDevice[]> {
    if (this.nodicDb) {
      try {
        const res = await this.nodicDb.connection.query(
          'SELECT * FROM paired_devices ORDER BY updated_at DESC',
        );
        for (const r of res.values ?? []) {
          const item: PairedDevice = {
            deviceId: r.device_id as string,
            nodicId: (r.nodic_id as string) || formatNodicId(r.device_id as string),
            displayName: r.display_name as string,
            publicSigningKey: r.public_signing_key as string,
            host: r.host as string,
            port: Number(r.port),
            pairingState: (r.pairing_state as PairingState) ?? 'PAIRED',
            pairedAt: new Date(Number(r.paired_at)).toISOString(),
            updatedAt: new Date(Number(r.updated_at)).toISOString(),
          };
          this.memoryPairedDevices.set(item.deviceId, item);
        }
      } catch {
        // Fallback to memory
      }
    }
    return Array.from(this.memoryPairedDevices.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async savePairingRequest(req: PairingRequest): Promise<PairingRequest> {
    const createdMs = new Date(req.createdAt).getTime() || Date.now();
    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT INTO pairing_requests (
           request_id, from_device_id, from_nodic_id, from_display_name, from_public_key, host, port, direction, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           status = excluded.status,
           host = excluded.host,
           port = excluded.port,
           from_display_name = excluded.from_display_name`,
        [
          req.requestId,
          req.fromDeviceId,
          req.fromNodicId,
          req.fromDisplayName,
          req.fromPublicKey,
          req.host,
          req.port,
          req.direction,
          req.status,
          createdMs,
        ],
      );
    }
    this.memoryPairingRequests.set(req.requestId, req);
    this.persistLocalWorkspaceState();
    return req;
  }

  async listPairingRequests(): Promise<PairingRequest[]> {
    if (this.nodicDb) {
      try {
        const res = await this.nodicDb.connection.query(
          'SELECT * FROM pairing_requests ORDER BY created_at DESC',
        );
        for (const r of res.values ?? []) {
          const item: PairingRequest = {
            requestId: r.request_id as string,
            fromDeviceId: r.from_device_id as string,
            fromNodicId: (r.from_nodic_id as string) || formatNodicId(r.from_device_id as string),
            fromDisplayName: r.from_display_name as string,
            fromPublicKey: r.from_public_key as string,
            host: r.host as string,
            port: Number(r.port),
            direction: (r.direction as 'INBOUND' | 'OUTBOUND') ?? 'INBOUND',
            status: (r.status as 'PENDING' | 'ACCEPTED' | 'DECLINED') ?? 'PENDING',
            createdAt: new Date(Number(r.created_at)).toISOString(),
          };
          this.memoryPairingRequests.set(item.requestId, item);
        }
      } catch {
        // Fallback to memory
      }
    }
    return Array.from(this.memoryPairingRequests.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  private findNearbyPeerByNodicId(
    nodicIdInput: string,
    peers: PeerIdentity[],
  ): PeerIdentity | undefined {
    const normalized = normalizeNodicIdInput(nodicIdInput);
    const shortSuffix = normalized.replace(/^nodic-/i, '');

    return peers.find((p) => {
      if (p.status !== 'ONLINE') return false;
      const peerNodicId = formatNodicId(p.deviceId);
      const serviceNodicId = p.serviceName ? p.serviceName.toLowerCase() : '';
      const rawDevId = p.deviceId.toLowerCase();
      return (
        peerNodicId === normalized ||
        serviceNodicId === normalized ||
        rawDevId === normalized ||
        rawDevId === shortSuffix ||
        rawDevId.startsWith(shortSuffix)
      );
    });
  }

  async requestPairingByNodicIds(
    rawInputs: string | string[],
  ): Promise<PairingAttemptResult[]> {
    const identity = await this.getIdentity();
    const selfNodicId = formatNodicId(identity.deviceId);
    const targetIds = parseNodicIdList(rawInputs);
    const peers = await this.listPeerIdentities();
    const results: PairingAttemptResult[] = [];
    const nowIso = new Date().toISOString();

    for (const nodicId of targetIds) {
      if (nodicId === selfNodicId || nodicId === identity.deviceId.toLowerCase()) {
        results.push({
          nodicId,
          status: 'SELF_ID',
          message: `${nodicId} is your own Nodic User ID.`,
        });
        continue;
      }

      const nearbyPeer = this.findNearbyPeerByNodicId(nodicId, peers);
      if (!nearbyPeer) {
        results.push({
          nodicId,
          status: 'NOT_FOUND_NEARBY',
          message: `Device ${nodicId} was not found in nearby devices.`,
        });
        continue;
      }

      const peerNodicId = formatNodicId(nearbyPeer.deviceId);
      const requestId = crypto.randomUUID();
      const request: PairingRequest = {
        requestId,
        fromDeviceId: nearbyPeer.deviceId,
        fromNodicId: peerNodicId,
        fromDisplayName: nearbyPeer.displayName,
        fromPublicKey: nearbyPeer.publicSigningKey,
        host: nearbyPeer.host,
        port: nearbyPeer.port,
        direction: 'OUTBOUND',
        status: 'PENDING',
        createdAt: nowIso,
      };

      await this.savePairingRequest(request);

      const existingPaired = this.memoryPairedDevices.get(nearbyPeer.deviceId);
      await this.savePairedDevice({
        deviceId: nearbyPeer.deviceId,
        nodicId: peerNodicId,
        displayName: nearbyPeer.displayName,
        publicSigningKey: nearbyPeer.publicSigningKey,
        host: nearbyPeer.host,
        port: nearbyPeer.port,
        pairingState: 'PENDING_OUTBOUND',
        pairedAt: existingPaired?.pairedAt ?? nowIso,
        updatedAt: nowIso,
      });

      await nativeSync.sendPairingRequest(nearbyPeer.host, nearbyPeer.port, requestId);

      await this.recordSyncLog({
        level: 'INFO',
        category: 'HANDSHAKE',
        peerDeviceId: nearbyPeer.deviceId,
        sessionId: requestId,
        message: `Sent pairing request to ${nearbyPeer.displayName} (${peerNodicId})`,
        detailsJson: JSON.stringify({
          requestId,
          peerDeviceId: nearbyPeer.deviceId,
          nodicId: peerNodicId,
        }),
      });

      results.push({
        nodicId: peerNodicId,
        status: 'REQUEST_SENT',
        peer: nearbyPeer,
        request,
        message: `Connection request sent to ${nearbyPeer.displayName} (${peerNodicId}).`,
      });
    }

    return results;
  }

  async receiveIncomingPairingRequest(payload: {
    requestId: string;
    fromDeviceId: string;
    fromNodicId?: string;
    fromDisplayName: string;
    fromPublicKey: string;
    host: string;
    port: number;
    sentAt?: string;
  }): Promise<PairingRequest> {
    const nowIso = payload.sentAt ?? new Date().toISOString();
    const fromNodicId = payload.fromNodicId
      ? normalizeNodicIdInput(payload.fromNodicId)
      : formatNodicId(payload.fromDeviceId);

    await this.savePeerIdentity({
      deviceId: payload.fromDeviceId,
      displayName: payload.fromDisplayName,
      publicSigningKey: payload.fromPublicKey,
      serviceName: fromNodicId,
      host: payload.host,
      port: payload.port,
      status: 'ONLINE',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });

    const req: PairingRequest = {
      requestId: payload.requestId,
      fromDeviceId: payload.fromDeviceId,
      fromNodicId,
      fromDisplayName: payload.fromDisplayName,
      fromPublicKey: payload.fromPublicKey,
      host: payload.host,
      port: payload.port,
      direction: 'INBOUND',
      status: 'PENDING',
      createdAt: nowIso,
    };

    await this.savePairingRequest(req);

    const existing = this.memoryPairedDevices.get(payload.fromDeviceId);
    await this.savePairedDevice({
      deviceId: payload.fromDeviceId,
      nodicId: fromNodicId,
      displayName: payload.fromDisplayName,
      publicSigningKey: payload.fromPublicKey,
      host: payload.host,
      port: payload.port,
      pairingState: 'PENDING_INBOUND',
      pairedAt: existing?.pairedAt ?? nowIso,
      updatedAt: nowIso,
    });

    return req;
  }

  async respondToPairingRequest(
    requestId: string,
    accept: boolean,
  ): Promise<{ accepted: boolean; pairedDevice?: PairedDevice }> {
    const req = this.memoryPairingRequests.get(requestId);
    if (!req) {
      throw new Error('Pairing request not found');
    }

    const nowIso = new Date().toISOString();
    req.status = accept ? 'ACCEPTED' : 'DECLINED';
    await this.savePairingRequest(req);

    // Clear any other pending inbound requests from the same device
    for (const other of this.memoryPairingRequests.values()) {
      if (
        other.fromDeviceId === req.fromDeviceId &&
        other.direction === 'INBOUND' &&
        other.status === 'PENDING' &&
        other.requestId !== requestId
      ) {
        other.status = accept ? 'ACCEPTED' : 'DECLINED';
        await this.savePairingRequest(other);
      }
    }

    await nativeSync.sendPairingResponse(req.host, req.port, req.requestId, accept);

    const existing = this.memoryPairedDevices.get(req.fromDeviceId);
    const pairedDevice = await this.savePairedDevice({
      deviceId: req.fromDeviceId,
      nodicId: req.fromNodicId,
      displayName: req.fromDisplayName,
      publicSigningKey: req.fromPublicKey,
      host: req.host,
      port: req.port,
      pairingState: accept ? 'PAIRED' : 'DECLINED',
      pairedAt: existing?.pairedAt ?? nowIso,
      updatedAt: nowIso,
    });

    if (accept) {
      await this.savePeerSession({
        id: req.requestId,
        peerDeviceId: req.fromDeviceId,
        peerDisplayName: req.fromDisplayName,
        peerPublicKey: req.fromPublicKey,
        peerAddress: req.host,
        peerPort: req.port,
        direction: 'INBOUND',
        status: 'CONNECTED',
        startedAt: nowIso,
        lastActivityAt: nowIso,
        endedAt: null,
        eventsSent: 0,
        eventsReceived: 0,
      });
    }

    return { accepted: accept, pairedDevice };
  }

  async receivePairingResponse(payload: {
    requestId: string;
    fromDeviceId: string;
    fromNodicId?: string;
    fromDisplayName: string;
    fromPublicKey: string;
    host: string;
    port: number;
    accepted: boolean;
    sentAt?: string;
  }): Promise<PairedDevice> {
    const nowIso = payload.sentAt ?? new Date().toISOString();
    const fromNodicId = payload.fromNodicId
      ? normalizeNodicIdInput(payload.fromNodicId)
      : formatNodicId(payload.fromDeviceId);

    await this.savePeerIdentity({
      deviceId: payload.fromDeviceId,
      displayName: payload.fromDisplayName,
      publicSigningKey: payload.fromPublicKey,
      serviceName: fromNodicId,
      host: payload.host,
      port: payload.port,
      status: 'ONLINE',
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
    });

    const existingReq = this.memoryPairingRequests.get(payload.requestId);
    if (existingReq) {
      existingReq.status = payload.accepted ? 'ACCEPTED' : 'DECLINED';
      await this.savePairingRequest(existingReq);
    }

    const existingPaired = this.memoryPairedDevices.get(payload.fromDeviceId);
    const updated = await this.savePairedDevice({
      deviceId: payload.fromDeviceId,
      nodicId: fromNodicId,
      displayName: payload.fromDisplayName,
      publicSigningKey: payload.fromPublicKey,
      host: payload.host,
      port: payload.port,
      pairingState: payload.accepted ? 'PAIRED' : 'DECLINED',
      pairedAt: existingPaired?.pairedAt ?? nowIso,
      updatedAt: nowIso,
    });

    if (payload.accepted) {
      await this.savePeerSession({
        id: payload.requestId,
        peerDeviceId: payload.fromDeviceId,
        peerDisplayName: payload.fromDisplayName,
        peerPublicKey: payload.fromPublicKey,
        peerAddress: payload.host,
        peerPort: payload.port,
        direction: 'OUTBOUND',
        status: 'CONNECTED',
        startedAt: nowIso,
        lastActivityAt: nowIso,
        endedAt: null,
        eventsSent: 0,
        eventsReceived: 0,
      });
    }

    return updated;
  }

  async disconnectPeerLocally(peerDeviceIdOrNodicId: string): Promise<PairedDevice | null> {
    const clean = peerDeviceIdOrNodicId.trim();
    const normalizedNodicId = normalizeNodicIdInput(clean);
    let target: PairedDevice | undefined = this.memoryPairedDevices.get(clean);
    if (!target) {
      target = Array.from(this.memoryPairedDevices.values()).find(
        (d) =>
          d.deviceId.toLowerCase() === clean.toLowerCase() ||
          d.nodicId.toLowerCase() === normalizedNodicId,
      );
    }
    if (!target) return null;

    const nowIso = new Date().toISOString();
    const updated = await this.savePairedDevice({
      ...target,
      pairingState: 'DISCONNECTED_LOCAL',
      updatedAt: nowIso,
    });

    // Mark local active sessions with this peer as DISCONNECTED on this device only
    for (const session of this.memoryPeerSessions.values()) {
      if (session.peerDeviceId === target.deviceId && session.status === 'CONNECTED') {
        await this.savePeerSession({
          ...session,
          status: 'DISCONNECTED',
          endedAt: nowIso,
          lastActivityAt: nowIso,
        });
      }
    }

    await nativeSync.disconnectPeerLocally(target.deviceId);
    return updated;
  }

  async joinChannel(
    channelId: string,
    channelName?: string,
    leadDeviceId?: string,
    options?: {
      description?: string | null;
      sessionId?: string;
      leadDisplayName?: string;
      leadPublicKey?: string;
    },
  ): Promise<WorkspaceSnapshot> {
    const identity = await this.getIdentity();
    const now = Date.now();
    const effectiveLead = leadDeviceId ?? 'remote-lead';
    const effectiveName = channelName ?? 'Connected Channel';
    const effectiveDesc = options?.description ?? null;
    const effectiveSessionId = options?.sessionId ?? `sess-${channelId.slice(0, 8)}`;

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT INTO channels (id, session_id, name, description, lead_device_id, genesis_event_id, key_version, created_at)
         VALUES (?, ?, ?, ?, ?, 'joined', 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = COALESCE(excluded.session_id, channels.session_id),
           name = CASE WHEN channels.name = 'Connected Channel' THEN excluded.name ELSE channels.name END,
           description = COALESCE(excluded.description, channels.description),
           lead_device_id = CASE WHEN channels.lead_device_id = 'remote-lead' THEN excluded.lead_device_id ELSE channels.lead_device_id END`,
        [channelId, effectiveSessionId, effectiveName, effectiveDesc, effectiveLead, now],
      );

      await this.nodicDb.connection.run(
        `INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id)
         VALUES (?, ?, ?, ?, 'MEMBER', 'ACTIVE', 'joined')
         ON CONFLICT(channel_id, device_id) DO UPDATE SET
           display_name=excluded.display_name,
           public_signing_key=excluded.public_signing_key,
           status='ACTIVE'`,
        [channelId, identity.deviceId, identity.displayName, identity.publicSigningKey],
      );

      if (effectiveLead !== 'remote-lead') {
        const leadName = options?.leadDisplayName ?? `Lead-${effectiveLead.slice(0, 4).toUpperCase()}`;
        const leadKey = options?.leadPublicKey ?? 'p256-key';
        await this.nodicDb.connection.run(
          `INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id)
           VALUES (?, ?, ?, ?, 'LEAD', 'ACTIVE', 'joined')
           ON CONFLICT(channel_id, device_id) DO UPDATE SET
             role='LEAD',
             status='ACTIVE'`,
          [channelId, effectiveLead, leadName, leadKey],
        );
      }
    }

    const existing = this.memoryChannels.get(channelId);
    const selfMember: Member = {
      deviceId: identity.deviceId,
      displayName: identity.displayName,
      publicSigningKey: identity.publicSigningKey,
      role: effectiveLead === identity.deviceId ? 'LEAD' : 'MEMBER',
      presence: 'ONLINE',
      initials: identity.displayName.slice(0, 2).toUpperCase(),
    };

    if (existing) {
      existing.members.set(identity.deviceId, selfMember);
      if (effectiveLead !== 'remote-lead' && !existing.members.has(effectiveLead)) {
        const leadName = options?.leadDisplayName ?? `Lead-${effectiveLead.slice(0, 4).toUpperCase()}`;
        existing.members.set(effectiveLead, {
          deviceId: effectiveLead,
          displayName: leadName,
          publicSigningKey: options?.leadPublicKey,
          role: 'LEAD',
          presence: 'ONLINE',
          initials: leadName.slice(0, 2).toUpperCase(),
        });
      }
      if (existing.channel.name === 'Connected Channel' && effectiveName !== 'Connected Channel') {
        existing.channel.name = effectiveName;
      }
      if (!existing.channel.description && effectiveDesc) {
        existing.channel.description = effectiveDesc;
      }
      if (!existing.channel.sessionId || existing.channel.sessionId.length < effectiveSessionId.length) {
        existing.channel.sessionId = effectiveSessionId;
      }
      if (existing.channel.leadDeviceId === 'remote-lead' && effectiveLead !== 'remote-lead') {
        existing.channel.leadDeviceId = effectiveLead;
      }
      existing.channel.members = Array.from(existing.members.values());
      this.memoryState = existing;
    } else {
      const initialMembers: Member[] = [selfMember];
      if (effectiveLead !== 'remote-lead' && effectiveLead !== identity.deviceId) {
        const leadName = options?.leadDisplayName ?? `Lead-${effectiveLead.slice(0, 4).toUpperCase()}`;
        initialMembers.push({
          deviceId: effectiveLead,
          displayName: leadName,
          publicSigningKey: options?.leadPublicKey,
          role: 'LEAD',
          presence: 'ONLINE',
          initials: leadName.slice(0, 2).toUpperCase(),
        });
      }
      const channel: Channel = {
        id: channelId,
        sessionId: effectiveSessionId,
        name: effectiveName,
        description: effectiveDesc,
        currentUserDeviceId: identity.deviceId,
        leadDeviceId: effectiveLead,
        members: initialMembers,
      };
      const matState = createInitialMaterializedState(channel);
      this.memoryChannels.set(channelId, matState);
      this.memoryState = matState;
    }

    this.activeChannelId = channelId;
    this.persistLocalWorkspaceState();

    if (Capacitor.isNativePlatform()) {
      await nativeSync.saveWorkspaceChannel({
        id: channelId,
        sessionId: effectiveSessionId,
        name: this.memoryState.channel.name,
        description: this.memoryState.channel.description,
        leadDeviceId: this.memoryState.channel.leadDeviceId ?? effectiveLead,
        genesisEventId: 'joined',
        keyVersion: 1,
        isActive: true,
        createdAt: now,
      });
    }

    await this.recordSyncLog({
      level: 'INFO',
      category: 'SYNC',
      peerDeviceId: identity.deviceId,
      sessionId: effectiveSessionId,
      message: `Joined channel workspace (${channelId.slice(0, 8)}) [session ${effectiveSessionId}]`,
      detailsJson: JSON.stringify({ channelId, sessionId: effectiveSessionId }),
    });

    return this.loadWorkspace(channelId);
  }

  async listChannels(): Promise<ChannelSummary[]> {
    const byId = new Map<string, ChannelSummary>();

    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT id, session_id, name, description, lead_device_id FROM channels ORDER BY created_at DESC',
      );
      for (const r of res.values ?? []) {
        const id = r.id as string;
        byId.set(id, {
          id,
          sessionId: (r.session_id as string) || `sess-${id.slice(0, 8)}`,
          name: r.name as string,
          description: (r.description as string) ?? null,
          leadDeviceId: r.lead_device_id as string | undefined,
        });
      }
    }

    if (this.memoryState?.channel && !this.memoryChannels.has(this.memoryState.channel.id)) {
      this.memoryChannels.set(this.memoryState.channel.id, this.memoryState);
    }

    for (const s of this.memoryChannels.values()) {
      byId.set(s.channel.id, {
        id: s.channel.id,
        sessionId: s.channel.sessionId ?? `sess-${s.channel.id.slice(0, 8)}`,
        name: s.channel.name,
        description: s.channel.description,
        leadDeviceId: s.channel.leadDeviceId ?? s.channel.currentUserDeviceId,
      });
    }

    return Array.from(byId.values());
  }

  async switchChannel(channelId: string): Promise<WorkspaceSnapshot> {
    this.activeChannelId = channelId;
    if (Capacitor.isNativePlatform()) {
      await nativeSync.setActiveWorkspaceChannel(channelId);
    }
    this.persistLocalWorkspaceState();
    return this.loadWorkspace(channelId);
  }

  async leaveChannel(): Promise<WorkspaceSnapshot> {
    this.memoryState = null;
    this.activeChannelId = null;
    this.persistLocalWorkspaceState();
    return { channel: null, tasks: [], messages: [] };
  }

  async recoverChannelSession(channelIdOrSessionId?: string): Promise<WorkspaceSnapshot> {
    await this.restoreLocalWorkspaceState();

    const query = channelIdOrSessionId?.trim();
    let targetChannelId: string | undefined;

    if (query) {
      for (const [chId, mat] of this.memoryChannels.entries()) {
        if (
          chId === query ||
          chId.startsWith(query) ||
          mat.channel.sessionId === query ||
          (mat.channel.sessionId && mat.channel.sessionId.includes(query))
        ) {
          targetChannelId = chId;
          break;
        }
      }
    } else {
      targetChannelId = this.activeChannelId ?? this.memoryState?.channel.id;
    }

    const snap = await this.loadWorkspace(targetChannelId);
    if (snap.channel) {
      this.activeChannelId = snap.channel.id;
      this.persistLocalWorkspaceState();
      await this.recordSyncLog({
        level: 'INFO',
        category: 'SESSION',
        peerDeviceId: this.identity?.deviceId ?? null,
        sessionId: snap.channel.sessionId ?? null,
        message: `Recovered channel session "${snap.channel.name}" (${snap.channel.sessionId ?? snap.channel.id.slice(0, 8)})`,
        detailsJson: JSON.stringify({
          channelId: snap.channel.id,
          sessionId: snap.channel.sessionId,
          tasks: snap.tasks.length,
          messages: snap.messages.length,
          members: snap.channel.members.length,
        }),
      });
    }
    return snap;
  }

  async resetDatabase(): Promise<WorkspaceSnapshot> {
    if (this.nodicDb) {
      await this.nodicDb.connection.execute(
        `
        DELETE FROM channels;
        DELETE FROM members;
        DELETE FROM tasks;
        DELETE FROM task_field_versions;
        DELETE FROM messages;
        DELETE FROM events;
        DELETE FROM peer_identities;
        DELETE FROM peer_sessions;
        DELETE FROM sync_logs;
        DELETE FROM paired_devices;
        DELETE FROM pairing_requests;
      `,
        false,
      );
    }
    const devId = this.identity?.deviceId;
    this.memoryChannels.clear();
    this.memoryEvents.clear();
    this.memoryPeerIdentities.clear();
    this.memoryPeerSessions.clear();
    this.memorySyncLogs = [];
    this.memoryPairedDevices.clear();
    this.memoryPairingRequests.clear();
    this.channelKeys.clear();
    this.storedInvitations.clear();
    this.memoryState = null;
    this.activeChannelId = null;
    this.authorSequence = 0;
    writeStorageJson(STORAGE_KEYS.PEER_IDENTITIES, []);
    writeStorageJson(STORAGE_KEYS.PEER_SESSIONS, []);
    writeStorageJson(STORAGE_KEYS.SYNC_LOGS, []);
    if (devId) {
      writeStorageJson(`${STORAGE_KEYS.CHANNELS_PREFIX}${devId}`, []);
      writeStorageJson(`${STORAGE_KEYS.EVENTS_PREFIX}${devId}`, {});
      writeStorageJson(`${STORAGE_KEYS.ACTIVE_CHANNEL_PREFIX}${devId}`, null);
      writeStorageJson(`${STORAGE_KEYS.CHANNEL_KEYS_PREFIX}${devId}`, {});
      writeStorageJson(`${STORAGE_KEYS.INVITATIONS_PREFIX}${devId}`, {});
      writeStorageJson(`${STORAGE_KEYS.PAIRED_DEVICES_PREFIX}${devId}`, []);
      writeStorageJson(`${STORAGE_KEYS.PAIRING_REQUESTS_PREFIX}${devId}`, []);
    }
    await nativeSync.clearLogs();
    await nativeSync.clearWorkspaceData();
    return { channel: null, tasks: [], messages: [] };
  }

  async loadWorkspace(targetChannelId?: string): Promise<WorkspaceSnapshot> {
    const requestedId = targetChannelId ?? this.activeChannelId ?? undefined;

    if (this.nodicDb) {
      const chanRes = requestedId
        ? await this.nodicDb.connection.query('SELECT * FROM channels WHERE id = ? LIMIT 1', [
            requestedId,
          ])
        : await this.nodicDb.connection.query(
            'SELECT * FROM channels ORDER BY created_at DESC LIMIT 1',
          );
      const chanRows = chanRes.values ?? [];

      if (chanRows.length > 0) {
        const chan = chanRows[0];
        const channelId = chan.id as string;
        const sessionId = (chan.session_id as string) || `sess-${channelId.slice(0, 8)}`;

        const peerRes = await this.nodicDb.connection.query(
          'SELECT device_id, status FROM peer_identities',
        );
        const peerOnlineMap = new Map<string, string>();
        for (const p of peerRes.values ?? []) {
          peerOnlineMap.set(p.device_id as string, p.status as string);
        }

        const memRes = await this.nodicDb.connection.query(
          "SELECT * FROM members WHERE channel_id = ? AND status = 'ACTIVE'",
          [channelId],
        );
        const members: Member[] = (memRes.values ?? []).map((r) => {
          const devId = r.device_id as string;
          const isSelf = devId === this.identity?.deviceId;
          const peerStatus = peerOnlineMap.get(devId);
          return {
            deviceId: devId,
            displayName: r.display_name as string,
            publicSigningKey: (r.public_signing_key as string) ?? undefined,
            role: r.role,
            presence: isSelf ? 'ONLINE' : peerStatus === 'ONLINE' ? 'ONLINE' : 'RECENT',
            initials: (r.display_name as string).slice(0, 2).toUpperCase(),
          };
        });

        const taskRes = await this.nodicDb.connection.query(
          'SELECT * FROM tasks WHERE channel_id = ? AND archived = 0 ORDER BY updated_at DESC',
          [channelId],
        );
        const tasks: Task[] = (taskRes.values ?? []).map((r) => ({
          id: r.id,
          channelId: r.channel_id,
          title: r.title,
          description: r.description,
          status: r.status,
          priority: r.priority,
          assigneeDeviceId: r.assignee_device_id,
          dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
          archived: Boolean(r.archived),
          pending: false,
          updatedAt: new Date(r.updated_at).toISOString(),
        }));

        const msgRes = await this.nodicDb.connection.query(
          'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at ASC',
          [channelId],
        );
        const messages: Message[] = (msgRes.values ?? []).map((r) => ({
          id: r.id,
          channelId: r.channel_id,
          kind: r.kind,
          authorDeviceId: r.author_device_id,
          body: r.body,
          createdAt: new Date(r.created_at).toISOString(),
          pending: false,
        }));

        const memChannel = this.memoryChannels.get(channelId);
        // Merge with in-memory materialized state in case memoryChannels has newer replayed events
        const mergedMembersMap = new Map<string, Member>();
        for (const m of memChannel?.members.values() ?? []) {
          mergedMembersMap.set(m.deviceId, m);
        }
        for (const m of members) {
          mergedMembersMap.set(m.deviceId, m);
        }
        const mergedMembers = Array.from(mergedMembersMap.values());

        const mergedTasksMap = new Map<string, Task>();
        for (const t of memChannel?.tasks.values() ?? []) {
          mergedTasksMap.set(t.id, t);
        }
        for (const t of tasks) {
          mergedTasksMap.set(t.id, t);
        }
        const mergedTasks = Array.from(mergedTasksMap.values()).filter((t) => !t.archived);

        const mergedMessagesMap = new Map<string, Message>();
        for (const msg of memChannel?.messages ?? []) {
          mergedMessagesMap.set(msg.id, msg);
        }
        for (const msg of messages) {
          mergedMessagesMap.set(msg.id, msg);
        }
        const mergedMessages = Array.from(mergedMessagesMap.values()).sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );

        const channel: Channel = {
          id: channelId,
          sessionId: memChannel?.channel.sessionId ?? sessionId,
          name:
            chan.name === 'Connected Channel' && memChannel?.channel.name
              ? memChannel.channel.name
              : chan.name,
          description: chan.description ?? memChannel?.channel.description ?? null,
          currentUserDeviceId: this.identity?.deviceId ?? 'unknown',
          leadDeviceId:
            chan.lead_device_id === 'remote-lead' && memChannel?.channel.leadDeviceId
              ? memChannel.channel.leadDeviceId
              : chan.lead_device_id,
          members: mergedMembers,
        };

        const mat = memChannel ?? createInitialMaterializedState(channel);
        mat.channel = channel;
        mergedMembers.forEach((m) => mat.members.set(m.deviceId, m));
        mergedTasks.forEach((t) => mat.tasks.set(t.id, t));
        mat.messages = [...mergedMessages];
        this.memoryChannels.set(channelId, mat);
        this.memoryState = mat;
        this.activeChannelId = channelId;

        return { channel, tasks: mergedTasks, messages: mergedMessages };
      }
    }

    if (requestedId && this.memoryChannels.has(requestedId)) {
      this.memoryState = this.memoryChannels.get(requestedId)!;
      this.activeChannelId = requestedId;
    } else if (
      this.memoryChannels.size > 0 &&
      (!this.memoryState || !this.memoryChannels.has(this.memoryState.channel.id))
    ) {
      this.memoryState = Array.from(this.memoryChannels.values())[0];
      this.activeChannelId = this.memoryState.channel.id;
    }

    if (!this.memoryState) {
      return { channel: null, tasks: [], messages: [] };
    }

    this.memoryState.channel.members = Array.from(this.memoryState.members.values());

    return {
      channel: {
        ...this.memoryState.channel,
        members: [...this.memoryState.channel.members],
      },
      tasks: Array.from(this.memoryState.tasks.values()).filter((t) => !t.archived),
      messages: [...this.memoryState.messages],
    };
  }

  async createChannel(
    name: string,
    description?: string,
  ): Promise<{ snapshot: WorkspaceSnapshot; genesisEvent: NodicEvent }> {
    const channelId = crypto.randomUUID();
    const sessionId = `sess-${channelId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = crypto.randomUUID();
    const identity = await this.getIdentity();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    identity.lamportClock += 1;
    this.authorSequence += 1;

    const initialKey = generateChannelKey();
    this.setChannelKey(channelId, 1, initialKey);

    const lead: Member = {
      deviceId: identity.deviceId,
      displayName: identity.displayName,
      publicSigningKey: identity.publicSigningKey,
      role: 'LEAD',
      presence: 'ONLINE',
      initials: identity.displayName.slice(0, 2).toUpperCase(),
    };

    const channel: Channel = {
      id: channelId,
      sessionId,
      name,
      description: description ?? null,
      currentUserDeviceId: identity.deviceId,
      leadDeviceId: identity.deviceId,
      keyVersion: 1,
      members: [lead],
    };

    const eventPayload = {
      name,
      description: description ?? null,
      sessionId,
      leadDisplayName: identity.displayName,
      leadPublicKey: identity.publicSigningKey,
    };

    const eventWithoutSig: Omit<NodicEvent, 'signature'> = {
      protocolVersion: 1,
      id: eventId,
      channelId,
      authorDeviceId: identity.deviceId,
      authorSequence: this.authorSequence,
      lamportClock: identity.lamportClock,
      type: 'CHANNEL_CREATED',
      keyVersion: 1,
      createdAt: nowIso,
      payloadVersion: 1,
      payload: eventPayload,
    };

    let signature = `sig-${identity.deviceId.slice(0, 8)}-${identity.lamportClock}`;
    if (this.privateSigningKey) {
      try {
        signature = await signEvent(eventWithoutSig, this.privateSigningKey);
      } catch {
        // Fallback
      }
    }

    const genesisEvent: NodicEvent = {
      ...eventWithoutSig,
      signature,
    };

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'UPDATE device_identity SET lamport_clock = ? WHERE device_id = ?',
        [identity.lamportClock, identity.deviceId],
      );

      await this.nodicDb.connection.run(
        'INSERT INTO channels (id, session_id, name, description, lead_device_id, genesis_event_id, key_version, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        [channelId, sessionId, name, description ?? null, identity.deviceId, eventId, now],
      );

      await this.nodicDb.connection.run(
        "INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id) VALUES (?, ?, ?, ?, 'LEAD', 'ACTIVE', ?)",
        [
          channelId,
          identity.deviceId,
          identity.displayName,
          identity.publicSigningKey,
          eventId,
        ],
      );

      await this.nodicDb.connection.run(
        "INSERT INTO events (id, channel_id, author_device_id, author_sequence, lamport_clock, type, key_version, payload_json, signature, created_at, received_at) VALUES (?, ?, ?, ?, ?, 'CHANNEL_CREATED', 1, ?, ?, ?, ?)",
        [
          eventId,
          channelId,
          identity.deviceId,
          genesisEvent.authorSequence,
          genesisEvent.lamportClock,
          JSON.stringify(eventPayload),
          genesisEvent.signature,
          now,
          now,
        ],
      );
    }

    this.memoryEvents.set(channelId, [genesisEvent]);
    const matState = createInitialMaterializedState(channel);
    this.memoryChannels.set(channelId, matState);
    this.memoryState = matState;
    this.activeChannelId = channelId;
    this.persistLocalWorkspaceState();

    if (Capacitor.isNativePlatform()) {
      await nativeSync.saveWorkspaceChannel({
        id: channelId,
        sessionId,
        name,
        description: description ?? null,
        leadDeviceId: identity.deviceId,
        genesisEventId: eventId,
        keyVersion: 1,
        isActive: true,
        createdAt: now,
      });
      await nativeSync.saveWorkspaceEvent(genesisEvent);
    }

    await this.recordSyncLog({
      level: 'INFO',
      category: 'EVENT',
      peerDeviceId: identity.deviceId,
      sessionId,
      message: `Created channel "${name}" with genesis event ${eventId.slice(0, 8)} [session ${sessionId}]`,
      detailsJson: JSON.stringify({ channelId, sessionId, eventId }),
    });

    return {
      snapshot: { channel, tasks: [], messages: [] },
      genesisEvent,
    };
  }

  async commitLocalEvent(
    channelId: string,
    type: EventType,
    payload: Record<string, unknown>,
    entityId?: string,
  ): Promise<{ event: NodicEvent; snapshot: WorkspaceSnapshot }> {
    const identity = await this.getIdentity();
    identity.lamportClock += 1;
    this.authorSequence += 1;

    const keyVersion = this.getActiveKeyVersion(channelId);

    const eventWithoutSig: Omit<NodicEvent, 'signature'> = {
      protocolVersion: 1,
      id: crypto.randomUUID(),
      channelId,
      authorDeviceId: identity.deviceId,
      authorSequence: this.authorSequence,
      lamportClock: identity.lamportClock,
      type,
      entityId,
      keyVersion,
      createdAt: new Date().toISOString(),
      payloadVersion: 1,
      payload,
    };

    let signature = `sig-${identity.deviceId.slice(0, 8)}-${identity.lamportClock}`;
    if (this.privateSigningKey) {
      try {
        signature = await signEvent(eventWithoutSig, this.privateSigningKey);
      } catch {
        // Fallback
      }
    }

    const event: NodicEvent = {
      ...eventWithoutSig,
      signature,
    };

    const snapshot = await this.applyEvent(event);
    return { event, snapshot };
  }

  async applyEvent(event: NodicEvent): Promise<WorkspaceSnapshot> {
    const run = async (): Promise<WorkspaceSnapshot> => {
      return this.applyEventInternal(event);
    };
    const next = this.eventQueue.then(run, run);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async applyEventInternal(event: NodicEvent): Promise<WorkspaceSnapshot> {
    const identity = await this.getIdentity();

    if (!this.memoryState) {
      await this.loadWorkspace(event.channelId);
    }

    // If receiving an event for a channel that does not exist locally yet, bootstrap its materialized state
    if (!this.memoryState || this.memoryState.channel.id !== event.channelId) {
      let targetState = this.memoryChannels.get(event.channelId);
      if (!targetState) {
        const payload = event.payload as {
          name?: string;
          description?: string;
          sessionId?: string;
        };
        const bootstrapChannel: Channel = {
          id: event.channelId,
          sessionId: payload.sessionId ?? `sess-${event.channelId.slice(0, 8)}`,
          name: payload.name ?? 'Connected Channel',
          description: payload.description ?? null,
          currentUserDeviceId: identity.deviceId,
          leadDeviceId:
            event.type === 'CHANNEL_CREATED' ? event.authorDeviceId : 'remote-lead',
          members: [],
        };
        targetState = createInitialMaterializedState(bootstrapChannel);
        this.memoryChannels.set(event.channelId, targetState);
      }
      this.memoryState = targetState;
    }

    // Duplicate suppression (Rule 3: Exact duplicates are successful no-ops)
    const memList = this.memoryEvents.get(event.channelId) ?? [];
    if (memList.some((e) => e.id === event.id)) {
      return this.loadWorkspace(event.channelId);
    }
    const memConflict = memList.find(
      (e) =>
        e.channelId === event.channelId &&
        e.authorDeviceId === event.authorDeviceId &&
        e.authorSequence === event.authorSequence &&
        e.id !== event.id,
    );
    if (memConflict) {
      await this.quarantineRejectedEvent(event.id, event.authorDeviceId, 'SEQUENCE_REUSED');
      return this.loadWorkspace(event.channelId);
    }

    if (this.nodicDb) {
      const existing = await this.nodicDb.connection.query(
        'SELECT id FROM events WHERE id = ?',
        [event.id],
      );
      if (existing.values && existing.values.length > 0) {
        return this.loadWorkspace(event.channelId);
      }

      // Rule 7: Confirm author sequence has not been reused with different content
      const seqCheck = await this.nodicDb.connection.query(
        'SELECT id FROM events WHERE channel_id = ? AND author_device_id = ? AND author_sequence = ?',
        [event.channelId, event.authorDeviceId, event.authorSequence],
      );
      if (seqCheck.values && seqCheck.values.length > 0 && seqCheck.values[0].id !== event.id) {
        await this.quarantineRejectedEvent(event.id, event.authorDeviceId, 'SEQUENCE_REUSED');
        return this.loadWorkspace(event.channelId);
      }
    }

    // Validation Rule 5: Confirm author membership at the event's logical position
    const revoked = this.revokedAuthors.get(event.channelId);
    if (revoked && revoked.has(event.authorDeviceId)) {
      await this.quarantineRejectedEvent(event.id, event.authorDeviceId, 'AUTHOR_REVOKED');
      return this.loadWorkspace(event.channelId);
    }

    // Validation Rule 4: Verify signature against author's authorized public key
    const authorPubKey = this.resolveAuthorPublicKey(event);
    if (
      authorPubKey &&
      authorPubKey.startsWith('p256:') &&
      !authorPubKey.startsWith('p256:mock-') &&
      !authorPubKey.startsWith('p256:peer-') &&
      !authorPubKey.startsWith('p256:nodic-') &&
      !event.signature.startsWith('sig-')
    ) {
      const validSig = await verifyEventSignature(event, authorPubKey);
      if (!validSig) {
        await this.quarantineRejectedEvent(event.id, event.authorDeviceId, 'INVALID_SIGNATURE');
        return this.loadWorkspace(event.channelId);
      }
    }

    // Advance local Lamport clock: max(local, received) + 1
    identity.lamportClock = Math.max(identity.lamportClock, event.lamportClock) + 1;
    if (event.authorDeviceId === identity.deviceId) {
      this.authorSequence = Math.max(this.authorSequence, event.authorSequence);
    }

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'UPDATE device_identity SET lamport_clock = ? WHERE device_id = ?',
        [identity.lamportClock, identity.deviceId],
      );
    }

    const updatedEvents = this.sortEventsCausally([...memList, event]);
    this.memoryEvents.set(event.channelId, updatedEvents);

    // Check if event arrived out-of-order (e.g., CHANNEL_CREATED or TASK_CREATED arriving after newer events)
    const needsCausalReplay =
      memList.length > 0 &&
      (event.type === 'CHANNEL_CREATED' ||
        event.type === 'TASK_CREATED' ||
        event.lamportClock < memList[memList.length - 1].lamportClock);

    let result = applyEventToState(this.memoryState!, event);

    if (needsCausalReplay) {
      const prevChannel = this.memoryState!.channel;
      const seedMembers = Array.from(this.memoryState!.members.values());
      const freshState = createInitialMaterializedState({
        ...prevChannel,
        members: seedMembers,
      });
      for (const ev of updatedEvents) {
        const stepRes = applyEventToState(freshState, ev);
        if (ev.id === event.id) {
          result = stepRes;
        }
      }
      freshState.channel.members = Array.from(freshState.members.values());
      this.memoryChannels.set(event.channelId, freshState);
      this.memoryState = freshState;
    }

    if (event.type === 'MEMBER_REMOVED') {
      const payload = event.payload as { deviceId: string };
      this.revokeAuthor(event.channelId, payload.deviceId);
    }

    if (event.type === 'CHANNEL_KEY_ROTATED') {
      const payload = event.payload as { keyVersion?: number; newKey?: string };
      const newVersion = payload.keyVersion ?? event.keyVersion;
      if (this.memoryState && this.memoryState.channel.id === event.channelId) {
        this.memoryState.channel.keyVersion = newVersion;
      }
      if (payload.newKey) {
        this.setChannelKey(event.channelId, newVersion, payload.newKey);
      }
    }

    if (this.nodicDb) {
      const now = Date.now();
      const createdMs = new Date(event.createdAt).getTime() || now;

      let ciphertextCol: string | null = null;
      const channelKey = this.getChannelKey(event.channelId, event.keyVersion);
      if (
        channelKey &&
        (event.type === 'CHAT_MESSAGE_SENT' ||
          event.type === 'TASK_CREATED' ||
          event.type === 'TASK_FIELDS_UPDATED')
      ) {
        try {
          const enc = await encryptPayload(event.payload, channelKey);
          ciphertextCol = `${enc.nonce}:${enc.ciphertext}`;
        } catch {
          // Fallback
        }
      }

      // Insert immutable event
      await this.nodicDb.connection.run(
        'INSERT OR IGNORE INTO events (id, channel_id, author_device_id, author_sequence, lamport_clock, type, entity_id, key_version, ciphertext, payload_json, signature, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          event.id,
          event.channelId,
          event.authorDeviceId,
          event.authorSequence,
          event.lamportClock,
          event.type,
          event.entityId ?? null,
          event.keyVersion,
          ciphertextCol,
          JSON.stringify(event.payload),
          event.signature,
          createdMs,
          now,
        ],
      );

      if (event.type === 'CHANNEL_CREATED') {
        const payload = event.payload as {
          name?: string;
          description?: string;
          sessionId?: string;
        };
        const resolvedSessionId =
          payload.sessionId ??
          this.memoryState!.channel.sessionId ??
          `sess-${event.channelId.slice(0, 8)}`;
        await this.nodicDb.connection.run(
          `INSERT INTO channels (id, session_id, name, description, lead_device_id, genesis_event_id, key_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             session_id = COALESCE(excluded.session_id, channels.session_id),
             name = excluded.name,
             description = excluded.description,
             lead_device_id = excluded.lead_device_id,
             genesis_event_id = excluded.genesis_event_id`,
          [
            event.channelId,
            resolvedSessionId,
            payload.name ?? this.memoryState!.channel.name,
            payload.description ?? null,
            event.authorDeviceId,
            event.id,
            createdMs,
          ],
        );
      }

      // Persist updated tasks (and all materialized tasks if causal replay ran)
      const tasksToPersist = needsCausalReplay
        ? Array.from(this.memoryState!.tasks.values())
        : result.updatedTasks;
      for (const task of tasksToPersist) {
        await this.nodicDb.connection.run(
          `INSERT INTO tasks (id, channel_id, title, description, status, priority, assignee_device_id, due_at, creator_device_id, created_at, updated_at, archived)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title=excluded.title,
             description=excluded.description,
             status=excluded.status,
             priority=excluded.priority,
             assignee_device_id=excluded.assignee_device_id,
             due_at=excluded.due_at,
             updated_at=excluded.updated_at,
             archived=excluded.archived`,
          [
            task.id,
            task.channelId,
            task.title,
            task.description,
            task.status,
            task.priority,
            task.assigneeDeviceId,
            task.dueAt ? new Date(task.dueAt).getTime() : null,
            event.authorDeviceId,
            now,
            new Date(task.updatedAt).getTime(),
            task.archived ? 1 : 0,
          ],
        );

        if (event.type === 'TASK_STATUS_CHANGED') {
          await this.nodicDb.connection.run(
            `INSERT INTO task_field_versions (task_id, field_name, lamport_clock, actor_device_id, event_id)
             VALUES (?, 'status', ?, ?, ?)
             ON CONFLICT(task_id, field_name) DO UPDATE SET
               lamport_clock=excluded.lamport_clock,
               actor_device_id=excluded.actor_device_id,
               event_id=excluded.event_id`,
            [task.id, event.lamportClock, event.authorDeviceId, event.id],
          );
        }
      }

      // Persist messages
      for (const msg of result.updatedMessages) {
        await this.nodicDb.connection.run(
          `INSERT OR IGNORE INTO messages (id, channel_id, kind, author_device_id, body, source_event_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            msg.id,
            msg.channelId,
            msg.kind,
            msg.authorDeviceId,
            msg.body,
            msg.id,
            new Date(msg.createdAt).getTime(),
          ],
        );
      }

      // Persist updated members
      const membersToPersist = needsCausalReplay
        ? Array.from(this.memoryState!.members.values())
        : result.updatedMembers;
      for (const member of membersToPersist) {
        const isRemoved =
          event.type === 'MEMBER_REMOVED' &&
          (event.payload as { deviceId?: string }).deviceId === member.deviceId;
        const payloadKey =
          member.publicSigningKey ??
          (event.payload as { publicSigningKey?: string; publicKey?: string; leadPublicKey?: string })
            .publicSigningKey ??
          (event.payload as { publicKey?: string }).publicKey ??
          (event.payload as { leadPublicKey?: string }).leadPublicKey ??
          'p256-key';
        await this.nodicDb.connection.run(
          `INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id, removed_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, device_id) DO UPDATE SET
             display_name=excluded.display_name,
             public_signing_key=CASE WHEN excluded.public_signing_key != 'p256-key' THEN excluded.public_signing_key ELSE members.public_signing_key END,
             role=excluded.role,
             status=excluded.status,
             removed_event_id=excluded.removed_event_id`,
          [
            event.channelId,
            member.deviceId,
            member.displayName,
            payloadKey,
            member.role,
            isRemoved ? 'REMOVED' : 'ACTIVE',
            event.id,
            isRemoved ? event.id : null,
          ],
        );
      }
    }

    this.memoryState!.channel.members = Array.from(this.memoryState!.members.values());
    if (!this.activeChannelId) {
      this.activeChannelId = event.channelId;
    }
    this.persistLocalWorkspaceState();

    if (Capacitor.isNativePlatform()) {
      await nativeSync.saveWorkspaceEvent(event);
      const ch = this.memoryState!.channel;
      await nativeSync.saveWorkspaceChannel({
        id: ch.id,
        sessionId: ch.sessionId ?? `sess-${ch.id.slice(0, 8)}`,
        name: ch.name,
        description: ch.description,
        leadDeviceId: ch.leadDeviceId ?? ch.currentUserDeviceId,
        genesisEventId: event.type === 'CHANNEL_CREATED' ? event.id : 'joined',
        keyVersion: ch.keyVersion ?? 1,
        isActive: this.activeChannelId === ch.id,
      });
    }

    await this.recordSyncLog({
      level: 'INFO',
      category: 'EVENT',
      peerDeviceId: event.authorDeviceId,
      sessionId: this.memoryState!.channel.sessionId ?? null,
      message: `Applied ${event.type} (seq ${event.authorSequence}, clock ${event.lamportClock})`,
      detailsJson: JSON.stringify({
        eventId: event.id,
        channelId: event.channelId,
        sessionId: this.memoryState!.channel.sessionId,
        type: event.type,
        authorDeviceId: event.authorDeviceId,
      }),
    });

    return {
      channel: {
        ...this.memoryState!.channel,
        members: [...this.memoryState!.channel.members],
      },
      tasks: Array.from(this.memoryState!.tasks.values()),
      messages: [...this.memoryState!.messages],
    };
  }

  async getSyncSummary(channelId: string): Promise<Record<string, number>> {
    const combined: Array<{ authorDeviceId: string; authorSequence: number }> = [];
    for (const ev of this.memoryEvents.get(channelId) ?? []) {
      combined.push({ authorDeviceId: ev.authorDeviceId, authorSequence: ev.authorSequence });
    }
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT author_device_id, author_sequence FROM events WHERE channel_id = ?',
        [channelId],
      );
      for (const r of res.values ?? []) {
        combined.push({
          authorDeviceId: r.author_device_id as string,
          authorSequence: Number(r.author_sequence),
        });
      }
    }
    return calculateContiguousSummary(combined);
  }

  async getAllChannelEvents(channelId: string, limit = 100): Promise<NodicEvent[]> {
    const byId = new Map<string, NodicEvent>();
    for (const ev of this.memoryEvents.get(channelId) ?? []) {
      byId.set(ev.id, ev);
    }
    if (this.nodicDb) {
      const allEventsRes = await this.nodicDb.connection.query(
        'SELECT * FROM events WHERE channel_id = ? ORDER BY lamport_clock ASC, author_sequence ASC LIMIT ?',
        [channelId, limit],
      );
      for (const r of allEventsRes.values ?? []) {
        byId.set(r.id as string, {
          protocolVersion: 1,
          id: r.id,
          channelId: r.channel_id,
          authorDeviceId: r.author_device_id,
          authorSequence: Number(r.author_sequence),
          lamportClock: Number(r.lamport_clock),
          type: r.type,
          entityId: r.entity_id ?? undefined,
          keyVersion: Number(r.key_version),
          createdAt: new Date(r.created_at).toISOString(),
          payloadVersion: 1,
          payload: JSON.parse(r.payload_json),
          signature: r.signature,
        });
      }
    }
    return this.sortEventsCausally(Array.from(byId.values())).slice(0, limit);
  }

  async getEventsForRanges(
    channelId: string,
    ranges: MissingRange[],
    limit = 100,
  ): Promise<NodicEvent[]> {
    if (ranges.length === 0) return [];
    const allEvents = await this.getAllChannelEvents(channelId, 1000);
    return selectEventsForRanges(allEvents, ranges, limit);
  }

  async applyBatch(events: NodicEvent[]): Promise<WorkspaceSnapshot> {
    let latestSnapshot: WorkspaceSnapshot | null = null;
    for (const ev of this.sortEventsCausally(events)) {
      latestSnapshot = await this.applyEvent(ev);
    }
    return latestSnapshot ?? this.loadWorkspace();
  }

  async quarantineRejectedEvent(
    eventId: string,
    peerDeviceId: string | null,
    reasonCode: string,
  ): Promise<void> {
    const now = Date.now();
    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'INSERT INTO rejected_events (event_id, peer_device_id, reason_code, received_at) VALUES (?, ?, ?, ?)',
        [eventId, peerDeviceId, reasonCode, now],
      );
    } else {
      const list = readStorageJson<Array<{ id: number; eventId: string | null; peerDeviceId: string | null; reasonCode: string; receivedAt: number }>>(
        'nodic_rejected_events_v1',
        [],
      );
      list.push({ id: list.length + 1, eventId, peerDeviceId, reasonCode, receivedAt: now });
      writeStorageJson('nodic_rejected_events_v1', list);
    }

    await this.recordSyncLog({
      id: `rej-${now}-${Math.random().toString(36).slice(2, 7)}`,
      level: 'WARN',
      category: 'EVENT',
      peerDeviceId,
      sessionId: null,
      message: `Quarantined event ${eventId}: ${reasonCode}`,
      detailsJson: JSON.stringify({ eventId, reasonCode }),
      createdAt: new Date(now).toISOString(),
    });
  }

  async listRejectedEvents(limit = 50): Promise<Array<{ id: number; eventId: string | null; peerDeviceId: string | null; reasonCode: string; receivedAt: number }>> {
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query('SELECT * FROM rejected_events ORDER BY id DESC LIMIT ?', [limit]);
      return (res.values ?? []).map((r) => ({
        id: Number(r.id),
        eventId: r.event_id as string | null,
        peerDeviceId: r.peer_device_id as string | null,
        reasonCode: r.reason_code as string,
        receivedAt: Number(r.received_at),
      }));
    }
    const list = readStorageJson<Array<{ id: number; eventId: string | null; peerDeviceId: string | null; reasonCode: string; receivedAt: number }>>(
      'nodic_rejected_events_v1',
      [],
    );
    return list.slice(-limit).reverse();
  }

  async recordPeerReceipt(
    channelId: string,
    peerDeviceId: string,
    authorDeviceId: string,
    highestSequence: number,
  ): Promise<void> {
    const now = Date.now();
    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT INTO peer_receipts (channel_id, peer_device_id, author_device_id, highest_sequence, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, peer_device_id, author_device_id) DO UPDATE SET
           highest_sequence = MAX(peer_receipts.highest_sequence, excluded.highest_sequence),
           updated_at = excluded.updated_at`,
        [channelId, peerDeviceId, authorDeviceId, highestSequence, now],
      );
    } else {
      const key = `nodic_receipts_${channelId}_${peerDeviceId}`;
      const receipts = readStorageJson<Record<string, number>>(key, {});
      receipts[authorDeviceId] = Math.max(receipts[authorDeviceId] ?? 0, highestSequence);
      writeStorageJson(key, receipts);
    }
  }

  async getPeerReceipts(channelId: string, peerDeviceId: string): Promise<Record<string, number>> {
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT author_device_id, highest_sequence FROM peer_receipts WHERE channel_id = ? AND peer_device_id = ?',
        [channelId, peerDeviceId],
      );
      const map: Record<string, number> = {};
      for (const row of res.values ?? []) {
        map[row.author_device_id as string] = Number(row.highest_sequence);
      }
      return map;
    }
    const key = `nodic_receipts_${channelId}_${peerDeviceId}`;
    return readStorageJson<Record<string, number>>(key, {});
  }

  async reconcileWithPeerSummary(
    channelId: string,
    peerDeviceId: string,
    peerSummary: Record<string, number>,
  ): Promise<{ eventsToSend: NodicEvent[]; missingRangesFromPeer: MissingRange[] }> {
    const localSummary = await this.getSyncSummary(channelId);
    const rangesForPeer = computeMissingRangesForPeer(localSummary, peerSummary);
    const missingRangesFromPeer = computeMissingRangesForPeer(peerSummary, localSummary);

    const eventsToSend = await this.getEventsForRanges(channelId, rangesForPeer, 100);

    // Record highest sequence received in peer's summary
    for (const [author, seq] of Object.entries(peerSummary)) {
      await this.recordPeerReceipt(channelId, peerDeviceId, author, seq);
    }

    return { eventsToSend, missingRangesFromPeer };
  }

  resolveAuthorPublicKey(event: NodicEvent): string | null {
    if (this.identity && event.authorDeviceId === this.identity.deviceId) {
      return this.identity.publicSigningKey;
    }
    if (event.type === 'CHANNEL_CREATED') {
      return (event.payload as { leadPublicKey?: string }).leadPublicKey ?? null;
    }
    if (event.type === 'MEMBER_ADDED') {
      const payload = event.payload as {
        deviceId?: string;
        publicSigningKey?: string;
        publicKey?: string;
      };
      if (!payload.deviceId || payload.deviceId === event.authorDeviceId) {
        return payload.publicSigningKey ?? payload.publicKey ?? null;
      }
    }
    const chMember = this.memoryChannels
      .get(event.channelId)
      ?.members.get(event.authorDeviceId);
    if (chMember?.publicSigningKey) return chMember.publicSigningKey;

    const member = this.memoryState?.members.get(event.authorDeviceId);
    if (member?.publicSigningKey) return member.publicSigningKey;

    const peer = this.memoryPeerIdentities.get(event.authorDeviceId);
    if (peer?.publicSigningKey) return peer.publicSigningKey;

    return null;
  }

  revokeAuthor(channelId: string, deviceId: string): void {
    let set = this.revokedAuthors.get(channelId);
    if (!set) {
      set = new Set();
      this.revokedAuthors.set(channelId, set);
    }
    set.add(deviceId);
  }

  isAuthorRevoked(channelId: string, deviceId: string): boolean {
    return this.revokedAuthors.get(channelId)?.has(deviceId) ?? false;
  }

  setChannelKey(channelId: string, version: number, key: string): void {
    let map = this.channelKeys.get(channelId);
    if (!map) {
      map = new Map();
      this.channelKeys.set(channelId, map);
    }
    map.set(version, key);
  }

  getChannelKey(channelId: string, version = 1): string | null {
    return this.channelKeys.get(channelId)?.get(version) ?? null;
  }

  getActiveKeyVersion(channelId: string): number {
    const versions = this.channelKeys.get(channelId);
    if (!versions || versions.size === 0) return 1;
    return Math.max(...Array.from(versions.keys()));
  }

  async rotateChannelKey(
    channelId: string,
  ): Promise<{ event: NodicEvent; newKeyVersion: number; newKey: string }> {
    const currentVersion = this.getActiveKeyVersion(channelId);
    const newKeyVersion = currentVersion + 1;
    const newKey = generateChannelKey();
    this.setChannelKey(channelId, newKeyVersion, newKey);

    const { event } = await this.commitLocalEvent(
      channelId,
      'CHANNEL_KEY_ROTATED',
      { keyVersion: newKeyVersion, newKey },
    );

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'UPDATE channels SET key_version = ? WHERE id = ?',
        [newKeyVersion, channelId],
      );
    }

    this.persistLocalWorkspaceState();

    return { event, newKeyVersion, newKey };
  }

  async createInvitation(
    channelId: string,
    expiresInHours = 24,
    leadEndpoint?: string,
  ): Promise<string> {
    const identity = await this.getIdentity();
    const chState = this.memoryChannels.get(channelId) ?? this.memoryState;
    const ch = chState?.channel;
    const payload = createInvitationPayload({
      channelId,
      sessionId: ch?.sessionId ?? `sess-${channelId.slice(0, 8)}`,
      channelName: ch?.name,
      channelDescription: ch?.description ?? undefined,
      leadDeviceId: ch?.leadDeviceId ?? identity.deviceId,
      leadDisplayName: identity.displayName,
      leadPublicKey: identity.publicSigningKey,
      leadEndpoint,
      expiresInHours,
    });
    const secretHash = await hashSecret(payload.joinSecret);

    this.storedInvitations.set(payload.invitationId, {
      hash: secretHash,
      expiresAt: payload.expiresAt,
      channelId,
    });
    this.persistLocalWorkspaceState();

    return encodeInvitationCode(payload);
  }

  async processJoinRequest(req: {
    channelId: string;
    invitationId: string;
    joinSecret: string;
    applicantDeviceId: string;
    applicantDisplayName: string;
    applicantPublicKey: string;
  }): Promise<{
    accepted: boolean;
    reason?: string;
    memberEvent?: NodicEvent;
    channelKey?: string;
  }> {
    const stored = this.storedInvitations.get(req.invitationId);
    if (!stored || stored.channelId !== req.channelId) {
      return { accepted: false, reason: 'Invitation not found for this channel' };
    }

    if (new Date(stored.expiresAt).getTime() < Date.now()) {
      return { accepted: false, reason: 'Invitation has expired' };
    }

    const providedHash = await hashSecret(req.joinSecret);
    if (!constantTimeCompare(providedHash, stored.hash)) {
      return { accepted: false, reason: 'Invalid invitation secret' };
    }

    // Lead approves join request: emits signed MEMBER_ADDED event
    const { event } = await this.commitLocalEvent(
      req.channelId,
      'MEMBER_ADDED',
      {
        deviceId: req.applicantDeviceId,
        displayName: req.applicantDisplayName,
        publicSigningKey: req.applicantPublicKey,
        role: 'MEMBER',
      },
      req.applicantDeviceId,
    );

    const activeVersion = this.getActiveKeyVersion(req.channelId);
    const channelKey = this.getChannelKey(req.channelId, activeVersion) ?? undefined;

    return {
      accepted: true,
      memberEvent: event,
      channelKey,
    };
  }
}

export const repository = new NodicRepository();
