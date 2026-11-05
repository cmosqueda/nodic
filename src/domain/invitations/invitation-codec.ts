import { channelInvitationSchema, type ChannelInvitation } from '../../../protocol/contracts';

const INVITATION_PREFIX = 'nodic:v1:';

function base64UrlEncode(str: string): string {
  // Cross-platform base64url encode
  const base64 = typeof Buffer !== 'undefined'
    ? Buffer.from(str, 'utf-8').toString('base64')
    : btoa(unescape(encodeURIComponent(str)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  // Cross-platform base64url decode
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return typeof Buffer !== 'undefined'
    ? Buffer.from(base64, 'base64').toString('utf-8')
    : decodeURIComponent(escape(atob(base64)));
}

export function generateJoinSecret(): string {
  // 32-byte cryptographically random hex secret
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createInvitationPayload(options: {
  channelId: string;
  expiresInHours?: number;
}): ChannelInvitation {
  const hours = options.expiresInHours ?? 24;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  return {
    version: 1,
    channelId: options.channelId,
    invitationId: crypto.randomUUID(),
    joinSecret: generateJoinSecret(),
    expiresAt,
  };
}

export function encodeInvitationCode(invitation: ChannelInvitation): string {
  const json = JSON.stringify(invitation);
  return `${INVITATION_PREFIX}${base64UrlEncode(json)}`;
}

export function parseInvitationCode(code: string): { success: true; invitation: ChannelInvitation } | { success: false; error: string } {
  const clean = code.trim();
  if (!clean.startsWith(INVITATION_PREFIX)) {
    return { success: false, error: 'Invalid invitation code format. Must start with nodic:v1:' };
  }

  const encoded = clean.slice(INVITATION_PREFIX.length);
  try {
    const json = base64UrlDecode(encoded);
    const parsed = JSON.parse(json);
    const validation = channelInvitationSchema.safeParse(parsed);
    if (!validation.success) {
      return { success: false, error: 'Malformed invitation payload structure.' };
    }

    const invitation = validation.data;
    if (new Date(invitation.expiresAt).getTime() < Date.now()) {
      return { success: false, error: 'This invitation code has expired.' };
    }

    return { success: true, invitation };
  } catch (err) {
    return { success: false, error: 'Failed to decode invitation code payload.' };
  }
}
