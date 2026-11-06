import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const eventTypes = [
  'CHANNEL_CREATED',
  'INVITATION_CREATED',
  'INVITATION_REVOKED',
  'MEMBER_ADDED',
  'MEMBER_REMOVED',
  'MEMBER_ROLE_CHANGED',
  'CHANNEL_KEY_ROTATED',
  'CHAT_MESSAGE_SENT',
  'TASK_CREATED',
  'TASK_FIELDS_UPDATED',
  'TASK_STATUS_CHANGED',
  'TASK_ARCHIVED',
  'TASK_COMMENT_ADDED',
] as const;

export const eventTypeSchema = z.enum(eventTypes);
export type EventType = z.infer<typeof eventTypeSchema>;

export const memberRoleSchema = z.enum(['LEAD', 'CO_LEAD', 'MEMBER']);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const taskStatusSchema = z.enum(['BACKLOG', 'TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const channelInvitationSchema = z.object({
  version: z.literal(1),
  channelId: z.string().min(1).max(128),
  invitationId: z.string().min(1).max(128),
  joinSecret: z.string().min(32).max(512),
  expiresAt: z.iso.datetime(),
});
export type ChannelInvitation = z.infer<typeof channelInvitationSchema>;

export const nodicEventSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  channelId: z.string().min(1).max(128),
  authorDeviceId: z.string().min(1).max(128),
  authorSequence: z.number().int().positive(),
  lamportClock: z.number().int().positive(),
  type: eventTypeSchema,
  entityId: z.string().max(128).optional(),
  keyVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  payloadVersion: z.literal(1),
  payload: z.record(z.string(), z.unknown()),
  signature: z.string().min(1).max(2048),
});
export type NodicEvent = z.infer<typeof nodicEventSchema>;

export const syncSummarySchema = z.object({
  channelId: z.string().min(1).max(128),
  sequences: z.record(z.string(), z.number().int().nonnegative()),
});
export type SyncSummary = z.infer<typeof syncSummarySchema>;

export const peerIdentitySchema = z.object({
  deviceId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(80),
  publicSigningKey: z.string().min(1).max(2048),
  serviceName: z.string().max(128).nullable(),
  host: z.string().min(1).max(256),
  port: z.number().int().positive(),
  status: z.enum(['ONLINE', 'OFFLINE', 'STALE']),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
export type PeerIdentity = z.infer<typeof peerIdentitySchema>;

export const peerSessionSchema = z.object({
  id: z.string().min(1).max(128),
  peerDeviceId: z.string().min(1).max(128),
  peerDisplayName: z.string().min(1).max(80),
  peerPublicKey: z.string().min(1).max(2048),
  peerAddress: z.string().min(1).max(256),
  peerPort: z.number().int().positive(),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  status: z.enum(['CONNECTING', 'CONNECTED', 'DISCONNECTED', 'ERROR']),
  startedAt: z.string(),
  lastActivityAt: z.string(),
  endedAt: z.string().nullable(),
  eventsSent: z.number().int().nonnegative(),
  eventsReceived: z.number().int().nonnegative(),
});
export type PeerSession = z.infer<typeof peerSessionSchema>;

export const syncLogSchema = z.object({
  id: z.string().min(1).max(128),
  level: z.enum(['INFO', 'WARN', 'ERROR']),
  category: z.enum(['IDENTITY', 'DISCOVERY', 'HANDSHAKE', 'SESSION', 'SYNC', 'EVENT']),
  peerDeviceId: z.string().nullable(),
  sessionId: z.string().nullable(),
  message: z.string().min(1).max(1024),
  detailsJson: z.string().nullable(),
  createdAt: z.string(),
});
export type SyncLog = z.infer<typeof syncLogSchema>;

export const peerFrameSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('HELLO'),
    protocolVersion: z.literal(1),
    instanceId: z.string(),
    sessionId: z.string().optional(),
    deviceId: z.string().optional(),
    displayName: z.string().optional(),
    publicKey: z.string().optional(),
    listenPort: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal('HELLO_ACK'),
    protocolVersion: z.literal(1),
    sessionId: z.string(),
    deviceId: z.string(),
    displayName: z.string(),
    publicKey: z.string(),
    listenPort: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('SUMMARY'), requestId: z.string(), summary: syncSummarySchema }),
  z.object({ kind: z.literal('EVENT_BATCH'), requestId: z.string(), events: z.array(nodicEventSchema).max(100) }),
  z.object({ kind: z.literal('ACK'), requestId: z.string(), summary: syncSummarySchema }),
  z.object({ kind: z.literal('ERROR'), requestId: z.string().optional(), code: z.string(), message: z.string() }),
]);
export type PeerFrame = z.infer<typeof peerFrameSchema>;

export const syncStatusSchema = z.object({
  state: z.enum(['STOPPED', 'SEARCHING', 'CONNECTED', 'OFFLINE', 'ERROR']),
  peerCount: z.number().int().nonnegative(),
  pendingEventCount: z.number().int().nonnegative(),
  lastSyncAt: z.string().nullable(),
  detail: z.string().nullable(),
  localEndpoint: z.string().nullable().optional(),
});
export type SyncStatus = z.infer<typeof syncStatusSchema>;
