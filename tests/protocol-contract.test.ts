import { describe, expect, it } from 'vitest';
import { channelInvitationSchema, nodicEventSchema } from '../protocol/contracts';

describe('protocol contracts', () => {
  it('accepts a versioned invitation', () => {
    expect(channelInvitationSchema.parse({
      version: 1,
      channelId: 'channel-1',
      invitationId: 'invite-1',
      joinSecret: 'x'.repeat(32),
      expiresAt: '2026-11-05T12:00:00.000Z',
    }).channelId).toBe('channel-1');
  });

  it('rejects unsupported event protocol versions', () => {
    expect(() => nodicEventSchema.parse({ protocolVersion: 2 })).toThrow();
  });
});
