import { Capacitor } from '@capacitor/core';
import type {
  EventType,
  NodicEvent,
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
  selectEventsForRanges,
  type MissingRange,
} from '../domain/sync/sync-engine';
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

const STORAGE_KEYS = {
  IDENTITY: 'nodic_local_identity_v1',
  PEER_IDENTITIES: 'nodic_peer_identities_v1',
  PEER_SESSIONS: 'nodic_peer_sessions_v1',
  SYNC_LOGS: 'nodic_sync_logs_v1',
};

const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY NOT NULL,
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
  private identity: DeviceIdentityRecord | null = null;
  private authorSequence = 0;

  async init(defaultDisplayName?: string): Promise<WorkspaceSnapshot> {
    if (Capacitor.isNativePlatform()) {
      try {
        this.nodicDb = await openNodicDatabase();
        await this.nodicDb.connection.execute(INITIAL_SCHEMA_SQL, false);
      } catch (err) {
        console.warn('Native SQLite init failed, falling back to memory state:', err);
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
    if (Capacitor.isNativePlatform()) {
      await this.syncNativeDiagnostics();
    }
    return this.loadWorkspace();
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
    } else {
      writeStorageJson(STORAGE_KEYS.IDENTITY, identity);
    }

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

    if (this.memoryState) {
      const cur = this.memoryState.members.get(identity.deviceId);
      if (cur) {
        cur.displayName = cleanName;
        cur.initials = cleanName.slice(0, 2).toUpperCase();
        this.memoryState.channel.members = Array.from(this.memoryState.members.values());
      }
    }

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
        const resolvedPublicKey =
          row.public_signing_key &&
          row.public_signing_key !== 'p256-mock-key' &&
          row.public_signing_key !== 'phase-0-key-not-generated'
            ? (row.public_signing_key as string)
            : (nativeId?.publicKey ?? 'p256:nodic-device-key');

        if (resolvedPublicKey !== row.public_signing_key) {
          await this.nodicDb.connection.run(
            'UPDATE device_identity SET public_signing_key = ? WHERE device_id = ?',
            [resolvedPublicKey, row.device_id],
          );
        }

        this.identity = {
          deviceId: row.device_id as string,
          displayName: row.display_name as string,
          publicSigningKey: resolvedPublicKey,
          keystoreAlias: (row.keystore_alias as string) || 'nodic-device-key',
          lamportClock: Number(row.lamport_clock ?? 0),
        };

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

      const deviceId = nativeId?.deviceId ?? crypto.randomUUID();
      const publicSigningKey =
        nativeId?.publicKey && nativeId.publicKey !== 'phase-0-key-not-generated'
          ? nativeId.publicKey
          : `p256:${crypto.randomUUID().replace(/-/g, '')}`;
      const initialName =
        displayName && displayName !== 'Mara'
          ? displayName
          : nativeId?.displayName || `Node-${deviceId.slice(0, 4).toUpperCase()}`;

      const newId: DeviceIdentityRecord = {
        deviceId,
        displayName: initialName,
        publicSigningKey,
        keystoreAlias: nativeId?.keystoreAlias ?? 'nodic-device-key',
        lamportClock: 0,
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

    // Browser / Memory fallback with localStorage persistence
    if (!this.identity) {
      const stored = readStorageJson<DeviceIdentityRecord | null>(STORAGE_KEYS.IDENTITY, null);
      if (stored && stored.deviceId) {
        if (displayName && displayName.trim() && displayName !== 'Mara') {
          stored.displayName = displayName.trim();
          writeStorageJson(STORAGE_KEYS.IDENTITY, stored);
        }
        this.identity = stored;
        return this.identity;
      }

      const fallbackId = `node-${crypto.randomUUID().slice(0, 8)}`;
      this.identity = {
        deviceId: fallbackId,
        displayName:
          displayName && displayName !== 'Mara'
            ? displayName
            : `Node-${fallbackId.slice(5, 9).toUpperCase()}`,
        publicSigningKey: `p256:${crypto.randomUUID().replace(/-/g, '')}`,
        keystoreAlias: 'nodic-device-key',
        lamportClock: 0,
      };
      writeStorageJson(STORAGE_KEYS.IDENTITY, this.identity);
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
        `UPDATE members SET display_name = ?, public_signing_key = ? WHERE device_id = ?`,
        [peer.displayName, peer.publicSigningKey, peer.deviceId],
      );
    } else {
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
    }

    if (this.memoryState) {
      const member = this.memoryState.members.get(peer.deviceId);
      if (member) {
        member.displayName = peer.displayName;
        member.initials = peer.displayName.slice(0, 2).toUpperCase();
        member.presence = peer.status === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
        this.memoryState.channel.members = Array.from(this.memoryState.members.values());
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

  async joinChannel(
    channelId: string,
    channelName?: string,
    leadDeviceId?: string,
  ): Promise<WorkspaceSnapshot> {
    const identity = await this.getIdentity();
    const now = Date.now();
    const effectiveLead = leadDeviceId ?? 'remote-lead';
    const effectiveName = channelName ?? 'Connected Channel';

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        `INSERT INTO channels (id, name, description, lead_device_id, genesis_event_id, key_version, created_at)
         VALUES (?, ?, null, ?, 'joined', 1, ?)
         ON CONFLICT(id) DO NOTHING`,
        [channelId, effectiveName, effectiveLead, now],
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
    } else {
      const existing = this.memoryChannels.get(channelId);
      if (existing) {
        const selfMember: Member = {
          deviceId: identity.deviceId,
          displayName: identity.displayName,
          role: 'MEMBER',
          presence: 'ONLINE',
          initials: identity.displayName.slice(0, 2).toUpperCase(),
        };
        existing.members.set(identity.deviceId, selfMember);
        existing.channel.members = Array.from(existing.members.values());
        this.memoryState = existing;
      } else {
        const channel: Channel = {
          id: channelId,
          name: effectiveName,
          description: null,
          currentUserDeviceId: identity.deviceId,
          leadDeviceId: effectiveLead,
          members: [
            {
              deviceId: identity.deviceId,
              displayName: identity.displayName,
              role: 'MEMBER',
              presence: 'ONLINE',
              initials: identity.displayName.slice(0, 2).toUpperCase(),
            },
          ],
        };
        const matState = createInitialMaterializedState(channel);
        this.memoryChannels.set(channelId, matState);
        this.memoryState = matState;
      }
    }

    await this.recordSyncLog({
      level: 'INFO',
      category: 'SYNC',
      peerDeviceId: identity.deviceId,
      sessionId: null,
      message: `Joined channel workspace (${channelId.slice(0, 8)})`,
      detailsJson: JSON.stringify({ channelId }),
    });

    if (this.nodicDb) {
      this.memoryState = null;
    }
    return this.loadWorkspace(channelId);
  }

  async listChannels(): Promise<ChannelSummary[]> {
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT id, name, description, lead_device_id FROM channels ORDER BY created_at DESC',
      );
      return (res.values ?? []).map((r) => ({
        id: r.id as string,
        name: r.name as string,
        description: (r.description as string) ?? null,
        leadDeviceId: r.lead_device_id as string | undefined,
      }));
    }
    if (this.memoryState?.channel && !this.memoryChannels.has(this.memoryState.channel.id)) {
      this.memoryChannels.set(this.memoryState.channel.id, this.memoryState);
    }
    return Array.from(this.memoryChannels.values()).map((s) => ({
      id: s.channel.id,
      name: s.channel.name,
      description: s.channel.description,
      leadDeviceId: s.channel.leadDeviceId ?? s.channel.currentUserDeviceId,
    }));
  }

  async switchChannel(channelId: string): Promise<WorkspaceSnapshot> {
    return this.loadWorkspace(channelId);
  }

  async leaveChannel(): Promise<WorkspaceSnapshot> {
    this.memoryState = null;
    return { channel: null, tasks: [], messages: [] };
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
      `,
        false,
      );
    }
    this.memoryChannels.clear();
    this.memoryEvents.clear();
    this.memoryPeerIdentities.clear();
    this.memoryPeerSessions.clear();
    this.memorySyncLogs = [];
    this.memoryState = null;
    this.authorSequence = 0;
    writeStorageJson(STORAGE_KEYS.PEER_IDENTITIES, []);
    writeStorageJson(STORAGE_KEYS.PEER_SESSIONS, []);
    writeStorageJson(STORAGE_KEYS.SYNC_LOGS, []);
    await nativeSync.clearLogs();
    return { channel: null, tasks: [], messages: [] };
  }

  async loadWorkspace(targetChannelId?: string): Promise<WorkspaceSnapshot> {
    if (this.nodicDb) {
      const chanRes = targetChannelId
        ? await this.nodicDb.connection.query('SELECT * FROM channels WHERE id = ? LIMIT 1', [
            targetChannelId,
          ])
        : await this.nodicDb.connection.query(
            'SELECT * FROM channels ORDER BY created_at DESC LIMIT 1',
          );
      const chanRows = chanRes.values ?? [];

      if (chanRows.length === 0) {
        this.memoryState = null;
        return { channel: null, tasks: [], messages: [] };
      }

      const chan = chanRows[0];
      const channelId = chan.id as string;

      const peerRes = await this.nodicDb.connection.query(
        'SELECT device_id, status FROM peer_identities',
      );
      const peerOnlineMap = new Map<string, string>();
      for (const p of peerRes.values ?? []) {
        peerOnlineMap.set(p.device_id as string, p.status as string);
      }

      const memRes = await this.nodicDb.connection.query(
        'SELECT * FROM members WHERE channel_id = ? AND status = "ACTIVE"',
        [channelId],
      );
      const members: Member[] = (memRes.values ?? []).map((r) => {
        const devId = r.device_id as string;
        const isSelf = devId === this.identity?.deviceId;
        const peerStatus = peerOnlineMap.get(devId);
        return {
          deviceId: devId,
          displayName: r.display_name as string,
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

      const channel: Channel = {
        id: channelId,
        name: chan.name,
        description: chan.description,
        currentUserDeviceId: this.identity?.deviceId ?? 'unknown',
        leadDeviceId: chan.lead_device_id,
        members,
      };

      this.memoryState = createInitialMaterializedState(channel);
      tasks.forEach((t) => this.memoryState?.tasks.set(t.id, t));
      this.memoryState.messages = [...messages];

      return { channel, tasks, messages };
    }

    if (targetChannelId && this.memoryChannels.has(targetChannelId)) {
      this.memoryState = this.memoryChannels.get(targetChannelId)!;
    } else if (
      this.memoryChannels.size > 0 &&
      (!this.memoryState || !this.memoryChannels.has(this.memoryState.channel.id))
    ) {
      this.memoryState = Array.from(this.memoryChannels.values())[0];
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
      tasks: Array.from(this.memoryState.tasks.values()),
      messages: [...this.memoryState.messages],
    };
  }

  async createChannel(
    name: string,
    description?: string,
  ): Promise<{ snapshot: WorkspaceSnapshot; genesisEvent: NodicEvent }> {
    const channelId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const identity = await this.getIdentity();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    identity.lamportClock += 1;
    this.authorSequence += 1;

    const lead: Member = {
      deviceId: identity.deviceId,
      displayName: identity.displayName,
      role: 'LEAD',
      presence: 'ONLINE',
      initials: identity.displayName.slice(0, 2).toUpperCase(),
    };

    const channel: Channel = {
      id: channelId,
      name,
      description: description ?? null,
      currentUserDeviceId: identity.deviceId,
      leadDeviceId: identity.deviceId,
      members: [lead],
    };

    const eventPayload = {
      name,
      description: description ?? null,
      leadDisplayName: identity.displayName,
      leadPublicKey: identity.publicSigningKey,
    };

    const genesisEvent: NodicEvent = {
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
      signature: `sig-${identity.deviceId.slice(0, 8)}-${identity.lamportClock}`,
    };

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'UPDATE device_identity SET lamport_clock = ? WHERE device_id = ?',
        [identity.lamportClock, identity.deviceId],
      );

      await this.nodicDb.connection.run(
        'INSERT INTO channels (id, name, description, lead_device_id, genesis_event_id, key_version, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [channelId, name, description ?? null, identity.deviceId, eventId, now],
      );

      await this.nodicDb.connection.run(
        'INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id) VALUES (?, ?, ?, ?, "LEAD", "ACTIVE", ?)',
        [
          channelId,
          identity.deviceId,
          identity.displayName,
          identity.publicSigningKey,
          eventId,
        ],
      );

      await this.nodicDb.connection.run(
        'INSERT INTO events (id, channel_id, author_device_id, author_sequence, lamport_clock, type, key_version, payload_json, signature, created_at, received_at) VALUES (?, ?, ?, ?, ?, "CHANNEL_CREATED", 1, ?, ?, ?, ?)',
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
    } else {
      writeStorageJson(STORAGE_KEYS.IDENTITY, identity);
      this.memoryEvents.set(channelId, [genesisEvent]);
    }

    const matState = createInitialMaterializedState(channel);
    this.memoryChannels.set(channelId, matState);
    this.memoryState = matState;

    await this.recordSyncLog({
      level: 'INFO',
      category: 'EVENT',
      peerDeviceId: identity.deviceId,
      sessionId: null,
      message: `Created channel "${name}" with genesis event ${eventId.slice(0, 8)}`,
      detailsJson: JSON.stringify({ channelId, eventId }),
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

    const event: NodicEvent = {
      protocolVersion: 1,
      id: crypto.randomUUID(),
      channelId,
      authorDeviceId: identity.deviceId,
      authorSequence: this.authorSequence,
      lamportClock: identity.lamportClock,
      type,
      entityId,
      keyVersion: 1,
      createdAt: new Date().toISOString(),
      payloadVersion: 1,
      payload,
      signature: `sig-${identity.deviceId.slice(0, 8)}-${identity.lamportClock}`,
    };

    const snapshot = await this.applyEvent(event);
    return { event, snapshot };
  }

  async applyEvent(event: NodicEvent): Promise<WorkspaceSnapshot> {
    const identity = await this.getIdentity();

    if (!this.memoryState) {
      await this.loadWorkspace(event.channelId);
    }

    // If receiving an event for a channel that does not exist locally yet, bootstrap its materialized state
    if (!this.memoryState || this.memoryState.channel.id !== event.channelId) {
      let targetState = this.memoryChannels.get(event.channelId);
      if (!targetState) {
        const payload = event.payload as { name?: string; description?: string };
        const bootstrapChannel: Channel = {
          id: event.channelId,
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
    } else {
      writeStorageJson(STORAGE_KEYS.IDENTITY, identity);
      const list = this.memoryEvents.get(event.channelId) ?? [];
      if (!list.some((e) => e.id === event.id)) {
        list.push(event);
        this.memoryEvents.set(event.channelId, list);
      }
    }

    const result = applyEventToState(this.memoryState!, event);

    if (this.nodicDb) {
      const now = Date.now();
      const createdMs = new Date(event.createdAt).getTime() || now;

      // Insert immutable event
      await this.nodicDb.connection.run(
        'INSERT OR IGNORE INTO events (id, channel_id, author_device_id, author_sequence, lamport_clock, type, entity_id, key_version, payload_json, signature, created_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          event.id,
          event.channelId,
          event.authorDeviceId,
          event.authorSequence,
          event.lamportClock,
          event.type,
          event.entityId ?? null,
          event.keyVersion,
          JSON.stringify(event.payload),
          event.signature,
          createdMs,
          now,
        ],
      );

      if (event.type === 'CHANNEL_CREATED') {
        const payload = event.payload as { name?: string; description?: string };
        await this.nodicDb.connection.run(
          `INSERT INTO channels (id, name, description, lead_device_id, genesis_event_id, key_version, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             lead_device_id = excluded.lead_device_id,
             genesis_event_id = excluded.genesis_event_id`,
          [
            event.channelId,
            payload.name ?? this.memoryState!.channel.name,
            payload.description ?? null,
            event.authorDeviceId,
            event.id,
            createdMs,
          ],
        );
      }

      // Persist updated tasks
      for (const task of result.updatedTasks) {
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
      for (const member of result.updatedMembers) {
        const isRemoved =
          event.type === 'MEMBER_REMOVED' &&
          (event.payload as { deviceId?: string }).deviceId === member.deviceId;
        const payloadKey = (event.payload as { publicKey?: string; leadPublicKey?: string })
          .publicKey ??
          (event.payload as { leadPublicKey?: string }).leadPublicKey ??
          'p256-key';
        await this.nodicDb.connection.run(
          `INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id, removed_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_id, device_id) DO UPDATE SET
             display_name=excluded.display_name,
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

    await this.recordSyncLog({
      level: 'INFO',
      category: 'EVENT',
      peerDeviceId: event.authorDeviceId,
      sessionId: null,
      message: `Applied ${event.type} (seq ${event.authorSequence}, clock ${event.lamportClock})`,
      detailsJson: JSON.stringify({
        eventId: event.id,
        channelId: event.channelId,
        type: event.type,
        authorDeviceId: event.authorDeviceId,
      }),
    });

    this.memoryState!.channel.members = Array.from(this.memoryState!.members.values());

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
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query(
        'SELECT author_device_id, author_sequence FROM events WHERE channel_id = ?',
        [channelId],
      );
      const rows = (res.values ?? []).map((r) => ({
        authorDeviceId: r.author_device_id as string,
        authorSequence: Number(r.author_sequence),
      }));
      return calculateContiguousSummary(rows);
    }
    const list = this.memoryEvents.get(channelId) ?? [];
    return calculateContiguousSummary(list);
  }

  async getAllChannelEvents(channelId: string, limit = 100): Promise<NodicEvent[]> {
    if (this.nodicDb) {
      const allEventsRes = await this.nodicDb.connection.query(
        'SELECT * FROM events WHERE channel_id = ? ORDER BY lamport_clock ASC, author_sequence ASC LIMIT ?',
        [channelId, limit],
      );
      return (allEventsRes.values ?? []).map((r) => ({
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
      }));
    }
    return (this.memoryEvents.get(channelId) ?? []).slice(0, limit);
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
    for (const ev of events) {
      latestSnapshot = await this.applyEvent(ev);
    }
    return latestSnapshot ?? this.loadWorkspace();
  }
}

export const repository = new NodicRepository();
