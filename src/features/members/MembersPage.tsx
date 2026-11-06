import { useState, type FormEvent } from 'react';
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

export function MembersPage() {
  const {
    channel,
    identity,
    createInvitation,
    joinChannelWithCode,
    updateMemberRole,
    removeMember,
  } = useWorkspace();

  const currentUser = channel?.members.find((m) => m.deviceId === channel.currentUserDeviceId);
  const isLead = currentUser?.role === 'LEAD';

  const [showInviteModal, setShowInviteModal] = useState(false);
  const [generatedCode, setGeneratedCode] = useState('');
  const [copied, setCopied] = useState(false);

  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [joinNameInput, setJoinNameInput] = useState('');
  const [joinStatus, setJoinStatus] = useState<string | null>(null);

  const [memberToRemove, setMemberToRemove] = useState<{ deviceId: string; name: string } | null>(null);

  async function handleOpenInvite() {
    try {
      const code = await createInvitation(24);
      setGeneratedCode(code);
      setCopied(false);
      setShowInviteModal(true);
    } catch (err: any) {
      alert(err.message ?? 'Failed to generate invitation');
    }
  }

  async function handleCopyCode() {
    if (!generatedCode) return;
    try {
      await navigator.clipboard.writeText(generatedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(true);
    }
  }

  async function handleJoinSubmit(e: FormEvent) {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;

    setJoinStatus('Validating invitation...');
    const result = await joinChannelWithCode(joinCodeInput.trim(), joinNameInput.trim() || undefined);
    if (result.success) {
      setJoinStatus('Success! Entering channel...');
      setTimeout(() => {
        setShowJoinModal(false);
        setJoinCodeInput('');
        setJoinNameInput('');
        setJoinStatus(null);
      }, 1000);
    } else {
      setJoinStatus(`Error: ${result.message}`);
    }
  }

  if (!channel) {
    return (
      <div className="screen-container">
        <div className="page-wrap narrow-page" style={{ textAlign: 'center', paddingTop: '40px' }}>
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
                <button className="dialog-btn-primary">Open Network Configuration</button>
              </Link>
            </div>
          </div>
        </div>

        {/* Join Channel Pure React Modal */}
        <Modal
          isOpen={showJoinModal}
          onClose={() => setShowJoinModal(false)}
          title="Join Channel"
        >
          <form
            onSubmit={(e) => void handleJoinSubmit(e)}
            style={{ display: 'grid', gap: '14px' }}
          >
            <p style={{ color: 'var(--nodic-muted)', fontSize: '13px', margin: '0 0 6px' }}>
              Paste the invitation code received from your channel lead.
            </p>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Your Display Name</label>
              <input
                type="text"
                value={joinNameInput}
                onChange={(e) => setJoinNameInput(e.target.value)}
                placeholder={identity?.displayName || 'e.g. Rocket Puncher'}
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Invitation Code *</label>
              <textarea
                rows={3}
                required
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value)}
                placeholder="nodic:v1:..."
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white', fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>

            {joinStatus && (
              <div style={{ padding: '10px', borderRadius: '8px', background: joinStatus.startsWith('Error') ? '#ffeef0' : '#eaf8f4', color: joinStatus.startsWith('Error') ? '#b3261e' : '#146c54', fontSize: '13px' }}>
                {joinStatus}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button type="button" className="dialog-btn-outline" onClick={() => setShowJoinModal(false)}>
                Cancel
              </button>
              <button type="submit" className="dialog-btn-primary" disabled={!joinCodeInput.trim()}>
                Submit
              </button>
            </div>
          </form>
        </Modal>
      </div>
    );
  }

  return (
    <div className="screen-container">
      <div className="page-wrap narrow-page">
        {/* Header Chip matching wireframe prototype */}
        <div className="channel-header-chip">
          <div>
            <strong>{channel.name}</strong>
            <small>Authorized Members</small>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="dialog-btn-outline" onClick={() => setShowJoinModal(true)}>
              <IonIcon icon={enterOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
              Join
            </button>
            {isLead && (
              <button className="dialog-btn-primary" onClick={() => void handleOpenInvite()}>
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
                        onClick={() => void updateMemberRole(member.deviceId, member.role === 'CO_LEAD' ? 'MEMBER' : 'CO_LEAD')}
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

        {/* Join Channel Pure React Modal */}
        <Modal
          isOpen={showJoinModal}
          onClose={() => setShowJoinModal(false)}
          title="Join Channel"
        >
          <form
            onSubmit={(e) => void handleJoinSubmit(e)}
            style={{ display: 'grid', gap: '14px' }}
          >
            <p style={{ color: 'var(--nodic-muted)', fontSize: '13px', margin: '0 0 6px' }}>
              Paste the invitation code received from your channel lead.
            </p>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Your Display Name</label>
              <input
                type="text"
                value={joinNameInput}
                onChange={(e) => setJoinNameInput(e.target.value)}
                placeholder={identity?.displayName || 'e.g. Rocket Puncher'}
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Invitation Code *</label>
              <textarea
                rows={3}
                required
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value)}
                placeholder="nodic:v1:..."
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white', fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>

            {joinStatus && (
              <div style={{ padding: '10px', borderRadius: '8px', background: joinStatus.startsWith('Error') ? '#ffeef0' : '#eaf8f4', color: joinStatus.startsWith('Error') ? '#b3261e' : '#146c54', fontSize: '13px' }}>
                {joinStatus}
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <button type="button" className="dialog-btn-outline" onClick={() => setShowJoinModal(false)}>
                Cancel
              </button>
              <button type="submit" className="dialog-btn-primary" disabled={!joinCodeInput.trim()}>
                Submit
              </button>
            </div>
          </form>
        </Modal>

        {/* Remove Member Pure React Confirmation Dialog */}
        <ConfirmDialog
          isOpen={Boolean(memberToRemove)}
          title="Remove Member"
          message={`Are you sure you want to remove ${memberToRemove?.name} from this channel?`}
          confirmText="Remove"
          confirmDestructive
          onConfirm={() => {
            if (memberToRemove) {
              void removeMember(memberToRemove.deviceId);
              setMemberToRemove(null);
            }
          }}
          onCancel={() => setMemberToRemove(null)}
        />
      </div>
    </div>
  );
}