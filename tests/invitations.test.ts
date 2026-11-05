import { describe, expect, it } from 'vitest';
import {
  createInvitationPayload,
  encodeInvitationCode,
  parseInvitationCode,
} from '../src/domain/invitations/invitation-codec';

describe('Channel Invitation Codec', () => {
  it('creates and encodes valid invitation code', () => {
    const payload = createInvitationPayload({ channelId: 'channel-test-1', expiresInHours: 12 });
    expect(payload.version).toBe(1);
    expect(payload.channelId).toBe('channel-test-1');
    expect(payload.joinSecret).toHaveLength(64); // 32 bytes in hex

    const code = encodeInvitationCode(payload);
    expect(code).toMatch(/^nodic:v1:[A-Za-z0-9_-]+$/);

    const parseResult = parseInvitationCode(code);
    expect(parseResult.success).toBe(true);
    if (parseResult.success) {
      expect(parseResult.invitation.channelId).toBe('channel-test-1');
      expect(parseResult.invitation.invitationId).toBe(payload.invitationId);
      expect(parseResult.invitation.joinSecret).toBe(payload.joinSecret);
    }
  });

  it('rejects expired invitation codes', () => {
    // Expired 1 hour ago
    const expiredPayload = {
      version: 1 as const,
      channelId: 'chan-expired',
      invitationId: 'inv-123',
      joinSecret: 'a'.repeat(32),
      expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    };

    const code = encodeInvitationCode(expiredPayload);
    const result = parseInvitationCode(code);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('expired');
    }
  });

  it('rejects invalid or malformed codes', () => {
    expect(parseInvitationCode('invalid-prefix:something').success).toBe(false);
    expect(parseInvitationCode('nodic:v1:not-valid-base64-json').success).toBe(false);
  });
});
