import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { EventType, MemberRole, TaskPriority, TaskStatus } from '../../../protocol/contracts';

export const deviceIdentity = sqliteTable('device_identity', {
  deviceId: text('device_id').primaryKey(),
  displayName: text('display_name').notNull(),
  publicSigningKey: text('public_signing_key').notNull(),
  keystoreAlias: text('keystore_alias').notNull(),
  lamportClock: integer('lamport_clock').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  leadDeviceId: text('lead_device_id').notNull(),
  genesisEventId: text('genesis_event_id').notNull(),
  keyVersion: integer('key_version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const members = sqliteTable(
  'members',
  {
    channelId: text('channel_id').notNull(),
    deviceId: text('device_id').notNull(),
    displayName: text('display_name').notNull(),
    publicSigningKey: text('public_signing_key').notNull(),
    role: text('role').$type<MemberRole>().notNull(),
    status: text('status').$type<'ACTIVE' | 'REMOVED'>().notNull().default('ACTIVE'),
    joinedEventId: text('joined_event_id').notNull(),
    removedEventId: text('removed_event_id'),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.deviceId] }), index('members_channel_idx').on(table.channelId)],
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    authorDeviceId: text('author_device_id').notNull(),
    authorSequence: integer('author_sequence').notNull(),
    lamportClock: integer('lamport_clock').notNull(),
    type: text('type').$type<EventType>().notNull(),
    entityId: text('entity_id'),
    keyVersion: integer('key_version').notNull(),
    ciphertext: text('ciphertext'),
    payloadJson: text('payload_json').notNull(),
    signature: text('signature').notNull(),
    createdAt: integer('created_at').notNull(),
    receivedAt: integer('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('events_author_sequence_uq').on(table.channelId, table.authorDeviceId, table.authorSequence),
    index('events_channel_clock_idx').on(table.channelId, table.lamportClock),
  ],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').$type<TaskStatus>().notNull(),
    priority: text('priority').$type<TaskPriority>().notNull(),
    assigneeDeviceId: text('assignee_device_id'),
    dueAt: integer('due_at'),
    creatorDeviceId: text('creator_device_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('tasks_board_idx').on(table.channelId, table.archived, table.status),
    index('tasks_assignee_idx').on(table.channelId, table.assigneeDeviceId),
  ],
);

export const taskFieldVersions = sqliteTable(
  'task_field_versions',
  {
    taskId: text('task_id').notNull(),
    fieldName: text('field_name').notNull(),
    lamportClock: integer('lamport_clock').notNull(),
    actorDeviceId: text('actor_device_id').notNull(),
    eventId: text('event_id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.fieldName] })],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    channelId: text('channel_id').notNull(),
    kind: text('kind').$type<'USER' | 'SYSTEM'>().notNull(),
    authorDeviceId: text('author_device_id'),
    body: text('body').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('messages_source_event_uq').on(table.sourceEventId),
    index('messages_channel_created_idx').on(table.channelId, table.createdAt),
  ],
);

export const peerReceipts = sqliteTable(
  'peer_receipts',
  {
    channelId: text('channel_id').notNull(),
    peerDeviceId: text('peer_device_id').notNull(),
    authorDeviceId: text('author_device_id').notNull(),
    highestSequence: integer('highest_sequence').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.peerDeviceId, table.authorDeviceId] })],
);

export const rejectedEvents = sqliteTable('rejected_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: text('event_id'),
  peerDeviceId: text('peer_device_id'),
  reasonCode: text('reason_code').notNull(),
  receivedAt: integer('received_at').notNull(),
});
