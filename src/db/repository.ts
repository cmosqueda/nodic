import { Capacitor } from '@capacitor/core';
import type { EventType, NodicEvent, TaskPriority, TaskStatus } from '../../protocol/contracts';
import { canAuthorEvent, canChangeTaskStatus } from '../domain/permissions/permissions';
import { applyEventToState, createInitialMaterializedState, type MaterializedState } from '../domain/reducers/event-reducer';
import { calculateContiguousSummary, selectEventsForRanges, type MissingRange } from '../domain/sync/sync-engine';
import type { Channel, Member, Message, Task, WorkspaceSnapshot } from '../domain/models';
import { openNodicDatabase, type NodicDatabase } from './client';
import { nativeSync } from '../services/native-sync';
import { demoWorkspace } from '../services/demo-data';

export interface DeviceIdentityRecord {
  deviceId: string;
  displayName: string;
  publicSigningKey: string;
  keystoreAlias: string;
  lamportClock: number;
}

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
`;

export class NodicRepository {
  private nodicDb: NodicDatabase | null = null;
  private memoryState: MaterializedState | null = null;
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
    }

    await this.ensureIdentity(defaultDisplayName);
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
      if (this.memoryState?.channel.id) {
        await this.nodicDb.connection.run(
          'UPDATE members SET display_name = ? WHERE device_id = ? AND channel_id = ?',
          [cleanName, identity.deviceId, this.memoryState.channel.id],
        );
      }
    }

    if (this.memoryState) {
      const cur = this.memoryState.members.get(identity.deviceId);
      if (cur) {
        cur.displayName = cleanName;
        cur.initials = cleanName.slice(0, 2).toUpperCase();
      }
    }
    return identity;
  }

  private async ensureIdentity(displayName?: string): Promise<DeviceIdentityRecord> {
    if (this.nodicDb) {
      const res = await this.nodicDb.connection.query('SELECT * FROM device_identity LIMIT 1');
      const rows = res.values ?? [];
      if (rows.length > 0) {
        const row = rows[0];
        this.identity = {
          deviceId: row.device_id,
          displayName: row.display_name,
          publicSigningKey: row.public_signing_key,
          keystoreAlias: row.keystore_alias,
          lamportClock: Number(row.lamport_clock ?? 0),
        };
        return this.identity;
      }

      // First-time setup: get native device ID if available
      let deviceId: string = crypto.randomUUID();
      if (Capacitor.isNativePlatform()) {
        try {
          const nativeId = await nativeSync.plugin.getDeviceIdentity();
          if (nativeId.deviceId) deviceId = nativeId.deviceId;
        } catch {}
      }

      const initialName = displayName && displayName !== 'Mara'
        ? displayName
        : `Node-${deviceId.slice(0, 4).toUpperCase()}`;

      const newId: DeviceIdentityRecord = {
        deviceId,
        displayName: initialName,
        publicSigningKey: 'p256-mock-key',
        keystoreAlias: 'nodic-device-key',
        lamportClock: 0,
      };

      await this.nodicDb.connection.run(
        'INSERT INTO device_identity (device_id, display_name, public_signing_key, keystore_alias, lamport_clock, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [newId.deviceId, newId.displayName, newId.publicSigningKey, newId.keystoreAlias, newId.lamportClock, Date.now()],
      );

      this.identity = newId;
      return newId;
    }

    // Memory / browser fallback
    if (!this.identity) {
      const fallbackId = `web-${crypto.randomUUID().slice(0, 4)}`;
      this.identity = {
        deviceId: fallbackId,
        displayName: displayName && displayName !== 'Mara' ? displayName : `User-${fallbackId}`,
        publicSigningKey: 'web-preview-key',
        keystoreAlias: 'web-key',
        lamportClock: 0,
      };
    }
    return this.identity;
  }

  async joinChannel(channelId: string, channelName?: string, leadDeviceId?: string): Promise<WorkspaceSnapshot> {
    const identity = await this.getIdentity();
    const now = Date.now();
    const effectiveLead = leadDeviceId ?? 'remote-lead';
    const effectiveName = channelName ?? 'Connected Channel';

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'INSERT OR REPLACE INTO channels (id, name, description, lead_device_id, genesis_event_id, key_version, created_at) VALUES (?, ?, null, ?, "joined", 1, ?)',
        [channelId, effectiveName, effectiveLead, now],
      );

      await this.nodicDb.connection.run(
        `INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id)
         VALUES (?, ?, ?, ?, 'MEMBER', 'ACTIVE', 'joined')
         ON CONFLICT(channel_id, device_id) DO UPDATE SET display_name=excluded.display_name, status='ACTIVE'`,
        [channelId, identity.deviceId, identity.displayName, identity.publicSigningKey],
      );
    }
    this.memoryState = null;
    return this.loadWorkspace(channelId);
  }

  async leaveChannel(): Promise<WorkspaceSnapshot> {
    this.memoryState = null;
    return { channel: null, tasks: [], messages: [] };
  }

  async resetDatabase(): Promise<WorkspaceSnapshot> {
    if (this.nodicDb) {
      await this.nodicDb.connection.execute(`
        DELETE FROM channels;
        DELETE FROM members;
        DELETE FROM tasks;
        DELETE FROM task_field_versions;
        DELETE FROM messages;
        DELETE FROM events;
      `, false);
    }
    this.memoryState = null;
    return { channel: null, tasks: [], messages: [] };
  }

  async loadWorkspace(targetChannelId?: string): Promise<WorkspaceSnapshot> {
    if (this.nodicDb) {
      // Query channel (target or first)
      const chanRes = targetChannelId
        ? await this.nodicDb.connection.query('SELECT * FROM channels WHERE id = ? LIMIT 1', [targetChannelId])
        : await this.nodicDb.connection.query('SELECT * FROM channels ORDER BY created_at DESC LIMIT 1');
      const chanRows = chanRes.values ?? [];

      if (chanRows.length === 0) {
        this.memoryState = null;
        return { channel: null, tasks: [], messages: [] };
      }

      const chan = chanRows[0];
      const channelId = chan.id;

      // Query members
      const memRes = await this.nodicDb.connection.query('SELECT * FROM members WHERE channel_id = ? AND status = "ACTIVE"', [channelId]);
      const members: Member[] = (memRes.values ?? []).map((r) => ({
        deviceId: r.device_id,
        displayName: r.display_name,
        role: r.role,
        presence: r.device_id === this.identity?.deviceId ? 'ONLINE' : 'RECENT',
        initials: (r.display_name as string).slice(0, 2).toUpperCase(),
      }));

      // Query tasks
      const taskRes = await this.nodicDb.connection.query('SELECT * FROM tasks WHERE channel_id = ? AND archived = 0 ORDER BY updated_at DESC', [channelId]);
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

      // Query messages
      const msgRes = await this.nodicDb.connection.query('SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at ASC', [channelId]);
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
        members,
      };

      this.memoryState = createInitialMaterializedState(channel);
      tasks.forEach((t) => this.memoryState?.tasks.set(t.id, t));
      this.memoryState.messages = [...messages];

      return { channel, tasks, messages };
    }

    if (!this.memoryState) {
      return { channel: null, tasks: [], messages: [] };
    }

    return {
      channel: this.memoryState.channel,
      tasks: Array.from(this.memoryState.tasks.values()),
      messages: this.memoryState.messages,
    };
  }

  async createChannel(name: string, description?: string): Promise<WorkspaceSnapshot> {
    const channelId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const identity = await this.getIdentity();
    const now = Date.now();

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

    if (this.nodicDb) {
      await this.nodicDb.connection.run(
        'INSERT INTO channels (id, name, description, lead_device_id, genesis_event_id, key_version, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [channelId, name, description ?? null, identity.deviceId, eventId, now],
      );

      await this.nodicDb.connection.run(
        'INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id) VALUES (?, ?, ?, ?, "LEAD", "ACTIVE", ?)',
        [channelId, identity.deviceId, identity.displayName, identity.publicSigningKey, eventId],
      );

      const eventPayload = JSON.stringify({ name, description });
      await this.nodicDb.connection.run(
        'INSERT INTO events (id, channel_id, author_device_id, author_sequence, lamport_clock, type, key_version, payload_json, signature, created_at, received_at) VALUES (?, ?, ?, 1, 1, "CHANNEL_CREATED", 1, ?, "genesis-sig", ?, ?)',
        [eventId, channelId, identity.deviceId, eventPayload, now, now],
      );
    }

    this.memoryState = createInitialMaterializedState(channel);
    return { channel, tasks: [], messages: [] };
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
    if (!this.memoryState) {
      await this.loadWorkspace();
    }

    // Advance local Lamport clock: max(local, received) + 1
    if (this.identity) {
      this.identity.lamportClock = Math.max(this.identity.lamportClock, event.lamportClock) + 1;
      if (this.nodicDb) {
        await this.nodicDb.connection.run(
          'UPDATE device_identity SET lamport_clock = ? WHERE device_id = ?',
          [this.identity.lamportClock, this.identity.deviceId],
        );
      }
    }

    const result = applyEventToState(this.memoryState!, event);

    if (this.nodicDb) {
      const now = Date.now();
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
          new Date(event.createdAt).getTime(),
          now,
        ],
      );

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

        // Update task field version
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
        await this.nodicDb.connection.run(
          `INSERT INTO members (channel_id, device_id, display_name, public_signing_key, role, status, joined_event_id)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)
           ON CONFLICT(channel_id, device_id) DO UPDATE SET
             display_name=excluded.display_name,
             role=excluded.role,
             status=excluded.status`,
          [
            event.channelId,
            member.deviceId,
            member.displayName,
            'p256-key',
            member.role,
            event.id,
          ],
        );
      }
    }

    return {
      channel: this.memoryState!.channel,
      tasks: Array.from(this.memoryState!.tasks.values()),
      messages: this.memoryState!.messages,
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
    return {};
  }

  async getEventsForRanges(channelId: string, ranges: MissingRange[], limit = 100): Promise<NodicEvent[]> {
    if (this.nodicDb && ranges.length > 0) {
      const allEventsRes = await this.nodicDb.connection.query(
        'SELECT * FROM events WHERE channel_id = ? ORDER BY lamport_clock ASC, author_sequence ASC',
        [channelId],
      );
      const allEvents: NodicEvent[] = (allEventsRes.values ?? []).map((r) => ({
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
      return selectEventsForRanges(allEvents, ranges, limit);
    }
    return [];
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
