import { useState } from 'react';
import { IonIcon } from '@ionic/react';
import {
  copyOutline,
  enterOutline,
  linkOutline,
  shieldCheckmarkOutline,
  trashOutline,
} from 'ionicons/icons';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../app/workspace-context';
import { Modal, ConfirmDialog } from '../../shared/Modal';
import { JoinChannelModal, PendingJoinCard } from './JoinChannel';
import { IncomingInvitesCard, InviteNearbyModal, JoinRequestsCard } from './MemberRequests';
import { BusyButton, useFeedback } from '../../shared/feedback';

export function MembersPage() {
  const {
    channel,
    createInvitation,
    recoverChannelSession,
    updateMemberRole,
    removeMember,
  } = useWorkspace();

  const currentUser = channel?.members.find((m) => m.deviceId === channel.currentUserDeviceId);
  const isLead = currentUser?.role === 'LEAD';

  const feedback = useFeedback();
  const [showInvitePicker, setShowInvitePicker] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [copied, setCopied] = useState(false);

  const [showJoinModal, setShowJoinModal] = useState(false);

  const [memberToRemove, setMemberToRemove] = useState<{ deviceId: string; name: string } | null>(null);

  async function handleOpenInvite() {
    setShowInvitePicker(false);
    const ok = await feedback.run(async () => {
      const code = await createInvitation(24);
      setGeneratedCode(code);
      setCopied(false);
    });
    if (ok) setShowInviteModal(true);
  }

  async function handleSync() {
    if (!channel) return;
    setSyncing(true);
    await feedback.run(() => recoverChannelSession(channel.sessionId ?? channel.id), {
      success: 'Synced with connected peers',
      error: "Couldn't sync. Check you are connected to your teammates.",
    });
    setSyncing(false);
  }

  async function handleCopyCode() {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      feedback.error('Could not copy automatically. Press and hold the code to copy it.');
    }
  }

  if (!channel) {
    return (
      <div className="screen-container">
        <div className="page-wrap narrow-page" style={{ textAlign: 'center', paddingTop: '40px' }}>
          <PendingJoinCard />
          <IncomingInvitesCard />
          <div
            className="hub-card"
            style={{
              display: 'grid',
              gap: '16px',
              textAlign: 'center',
              placeItems: 'center',
              padding: '48px 24px',
            }}
          >
            <p style={{ maxWidth: '380px', color: 'var(--nodic-ink)', margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: 1.6 }}>
              you have no channel space yet.<br />
              please create one to load your channel and start collaborating.
            </p>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="dialog-btn-outline" onClick={() => setShowJoinModal(true)}>
                <IonIcon icon={enterOutline} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                Join with Code
              </button>
              <Link to="/network">
                <button className="dialog-btn-outline">Nearby people</button>
              </Link>
            </div>
          </div>
        </div>

        <JoinChannelModal isOpen={showJoinModal} onClose={() => setShowJoinModal(false)} />
      </div>
    );
  }

  return (
    <div className="screen-container">
      <div className="page-wrap narrow-page">
        <PendingJoinCard />
        <IncomingInvitesCard />
        <JoinRequestsCard channelId={channel.id} />
        {/* Header Chip matching wireframe prototype */}
        <div className="channel-header-chip">
          <div>
            <strong>{channel.name}</strong>
            <small>
              Authorized Members · Session:{' '}
              <span style={{ fontFamily: 'monospace' }}>
                {channel.sessionId ?? `sess-${channel.id.slice(0, 8)}`}
              </span>
            </small>
          </div>
          <div className="channel-header-actions">
            <BusyButton
              className="dialog-btn-outline"
              busy={syncing}
              busyLabel="Syncing"
              onClick={() => void handleSync()}
              title="Re-sync channel session with connected peers"
            >
              Sync
            </BusyButton>
            <button className="dialog-btn-outline" onClick={() => setShowJoinModal(true)}>
              <IonIcon icon={enterOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
              Join
            </button>
            {isLead && (
              <button className="dialog-btn-primary" onClick={() => setShowInvitePicker(true)}>
                <IonIcon icon={linkOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Invite
              </button>
            )}
          </div>
        </div>

        <section className="member-list" aria-label="Member roster">
          {channel.members.map((member) => {
            const isSelf = member.deviceId === channel.currentUserDeviceId;
            return (
              <article key={member.deviceId}>
                <div className={`member-avatar presence-${member.presence.toLowerCase()}`}>
                  {member.initials}
                </div>
                <div>
                  <strong style={{ fontSize: '14px' }}>
                    {member.displayName} {isSelf && <span style={{ color: 'var(--nodic-current)', fontSize: '11px' }}>(You)</span>}
                  </strong>
                  <small style={{ display: 'block', color: 'var(--nodic-muted)', fontSize: '11px' }}>
                    {member.role === 'LEAD' ? 'Channel Lead' : member.role === 'CO_LEAD' ? 'Co-Lead (Admin)' : 'Member'}
                  </small>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: member.presence === 'ONLINE' ? '#16a34a' : 'var(--nodic-muted)' }}>
                    {member.presence}
                  </span>

                  {/* Lead controls for other members */}
                  {isLead && !isSelf && member.role !== 'LEAD' && (
                    <>
                      <button
                        className="dialog-btn-outline"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        onClick={() =>
                          void feedback.run(
                            () => updateMemberRole(member.deviceId, member.role === 'CO_LEAD' ? 'MEMBER' : 'CO_LEAD'),
                            { success: `${member.displayName} is now ${member.role === 'CO_LEAD' ? 'a member' : 'a co-lead'}` },
                          )
                        }
                        title={member.role === 'CO_LEAD' ? 'Demote to regular member' : 'Appoint as co-lead'}
                      >
                        <IonIcon icon={shieldCheckmarkOutline} />
                      </button>

                      <button
                        className="dialog-btn-outline"
                        style={{ padding: '4px 8px', fontSize: '12px', color: '#dc2626' }}
                        onClick={() => setMemberToRemove({ deviceId: member.deviceId, name: member.displayName })}
                        title="Remove member from channel"
                      >
                        <IonIcon icon={trashOutline} />
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <InviteNearbyModal
          isOpen={showInvitePicker}
          onClose={() => setShowInvitePicker(false)}
          onShareCode={() => void handleOpenInvite()}
        />

        {/* Invitation Code Pure React Modal */}
        <Modal
          isOpen={showInviteModal}
          onClose={() => setShowInviteModal(false)}
          title="Share Invitation Code"
        >
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: 'var(--nodic-muted)', marginBottom: '14px', fontSize: '13px' }}>
              Share this invitation code with a teammate on your local Wi-Fi. Valid for 24 hours.
            </p>

            <div
              style={{
                background: '#e8f2f4',
                padding: '14px',
                borderRadius: '10px',
                wordBreak: 'break-all',
                fontFamily: 'monospace',
                fontSize: '12px',
                color: 'var(--nodic-ink)',
                marginBottom: '16px',
                border: '1px solid var(--nodic-line)',
                userSelect: 'all',
              }}
            >
              {generatedCode}
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button className="dialog-btn-primary" onClick={() => void handleCopyCode()}>
                <IonIcon icon={copyOutline} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                {copied ? 'Copied!' : 'Copy Code'}
              </button>
              <button className="dialog-btn-outline" onClick={() => setShowInviteModal(false)}>
                Done
              </button>
            </div>
          </div>
        </Modal>

        <JoinChannelModal isOpen={showJoinModal} onClose={() => setShowJoinModal(false)} />

        {/* Remove Member Pure React Confirmation Dialog */}
        <ConfirmDialog
          isOpen={Boolean(memberToRemove)}
          title="Remove Member"
          message={`Are you sure you want to remove ${memberToRemove?.name} from this channel?`}
          confirmText="Remove"
          confirmDestructive
          onConfirm={() => {
            if (!memberToRemove || removing) return;
            const target = memberToRemove;
            setRemoving(true);
            void feedback
              .run(() => removeMember(target.deviceId), { success: `${target.name} was removed` })
              .then(() => {
                setRemoving(false);
                setMemberToRemove(null);
              });
          }}
          onCancel={() => setMemberToRemove(null)}
        />
      </div>
    </div>
  );
}