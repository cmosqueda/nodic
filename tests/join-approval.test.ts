import { beforeEach, describe, expect, it } from 'vitest';
import { NodicRepository } from '../src/db/repository';
import { parseInvitationCode } from '../src/domain/invitations/invitation-codec';

async function twoPeers() {
  localStorage.clear();
  const lead = new NodicRepository();
  await lead.init('Lead');
  localStorage.clear();
  const guest = new NodicRepository();
  await guest.init('Guest');
  const { snapshot } = await lead.createChannel('Ops', 'test');
  const channelId = snapshot.channel!.id;
  const code = await lead.createInvitation(channelId, 24);
  const parsed = parseInvitationCode(code);
  if (!parsed.success) throw new Error('bad code');
  const request = await guest.buildJoinRequestEvent(channelId, {
    invitationId: parsed.invitation.invitationId,
    joinSecret: parsed.invitation.joinSecret,
  });
  return { lead, guest, channelId, invitation: parsed.invitation, request };
}

describe('Join request approval queue', () => {
  beforeEach(() => localStorage.clear());

  it('queues a valid request without admitting, then admits on approve', async () => {
    const { lead, channelId, request } = await twoPeers();
    const outcome = await lead.receiveJoinRequest(request);
    expect(outcome.status).toBe('QUEUED');
    expect(lead.listJoinRequests(channelId)).toHaveLength(1);
    // Not a member yet, so no channel traffic is routed to the applicant
    expect(lead.getChannelRecipientIds(channelId)).toEqual([]);

    const id = lead.listJoinRequests(channelId)[0].requestId;
    const res = await lead.approveJoinRequest(id);
    expect(res.accepted).toBe(true);
    expect(res.memberEvent?.type).toBe('MEMBER_ADDED');
    expect(lead.listJoinRequests(channelId)).toHaveLength(0);
    expect(lead.getChannelRecipientIds(channelId)).toHaveLength(1);
    // Invite is single-use: approving consumed it
    expect(lead.hasActiveInvitation()).toBe(false);
  });

  it('decline keeps the invite valid and admits nobody', async () => {
    const { lead, channelId, request } = await twoPeers();
    await lead.receiveJoinRequest(request);
    const id = lead.listJoinRequests(channelId)[0].requestId;
    expect(lead.declineJoinRequest(id)?.applicantDisplayName).toBe('Guest');
    expect(lead.listJoinRequests(channelId)).toHaveLength(0);
    expect(lead.getChannelRecipientIds(channelId)).toEqual([]);
    expect(lead.hasActiveInvitation()).toBe(true);
    expect((await lead.approveJoinRequest(id)).accepted).toBe(false); // already handled
  });

  it('rejects requests with a wrong secret and never queues them', async () => {
    const { lead, guest, channelId, invitation } = await twoPeers();
    const bad = await guest.buildJoinRequestEvent(channelId, {
      invitationId: invitation.invitationId,
      joinSecret: 'f'.repeat(64),
    });
    const outcome = await lead.receiveJoinRequest(bad);
    expect(outcome).toMatchObject({ status: 'REJECTED', reason: 'Invalid invitation secret' });
    expect(lead.listJoinRequests(channelId)).toHaveLength(0);
  });

  it('flags requests from a directly invited device and builds a CHANNEL_INVITE event', async () => {
    const { lead, guest, channelId, invitation, request } = await twoPeers();
    const guestId = (await guest.getIdentity()).deviceId;
    lead.markDirectInvite(invitation.invitationId, guestId);
    const outcome = await lead.receiveJoinRequest(request);
    expect(outcome.status === 'QUEUED' && outcome.request.invitedDirectly).toBe(true);

    const invite = await lead.buildChannelInviteEvent(channelId, guestId, 'nodic:v1:x');
    expect(invite.type).toBe('CHANNEL_INVITE');
    expect(invite.payload).toMatchObject({ targetDeviceId: guestId });
  });

  it('discarding an invitation makes its code unusable', async () => {
    const { lead, channelId, invitation, request } = await twoPeers();
    lead.discardInvitation(invitation.invitationId);
    const outcome = await lead.receiveJoinRequest(request);
    expect(outcome.status).toBe('REJECTED');
    expect(lead.listJoinRequests(channelId)).toHaveLength(0);
  });
});
