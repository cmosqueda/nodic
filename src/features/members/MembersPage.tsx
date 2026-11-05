import { useState, type FormEvent } from 'react';
import {
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonModal,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { closeOutline, copyOutline, enterOutline, linkOutline, shieldCheckmarkOutline, trashOutline } from 'ionicons/icons';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../app/workspace-context';
import { PageHeader } from '../../shared/PageHeader';

export function MembersPage() {
  const { channel, identity, createInvitation, joinChannelWithCode, updateMemberRole, removeMember } = useWorkspace();
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

  if (!channel) {
    return (
      <IonPage>
        <IonContent fullscreen>
          <div className="page-wrap narrow-page" style={{ paddingTop: '40px' }}>
            <PageHeader
              eyebrow="Channel roster · Local Authority"
              title="Connected people"
              detail="The channel lead controls access and delegates task management to co-leads."
            />
            <div className="status-banner" style={{ background: '#f5faf9', borderColor: '#c2dfd8', textAlign: 'center', padding: '32px 20px', marginTop: '20px' }}>
              <h2 style={{ margin: '0 0 10px', color: 'var(--nodic-ink)' }}>No Channel Active</h2>
              <p style={{ margin: '0 0 20px', color: 'var(--nodic-muted)' }}>
                You are not currently part of a channel. As Team Lead, create a new channel in the Network Hub, or join an existing channel using an invitation code.
              </p>
              <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
                <IonButton fill="outline" onClick={() => setShowJoinModal(true)}>
                  <IonIcon slot="start" icon={enterOutline} />
                  Join with Code
                </IonButton>
                <Link to="/network">
                  <IonButton className="primary-action">Go to Network Hub</IonButton>
                </Link>
              </div>
            </div>

            {/* Join Channel Modal */}
            <IonModal isOpen={showJoinModal} onDidDismiss={() => setShowJoinModal(false)}>
              <IonHeader>
                <IonToolbar>
                  <IonTitle>Join Channel</IonTitle>
                  <IonButtons slot="end">
                    <IonButton onClick={() => setShowJoinModal(false)}>
                      <IonIcon icon={closeOutline} />
                    </IonButton>
                  </IonButtons>
                </IonToolbar>
              </IonHeader>
              <IonContent className="ion-padding">
                <form onSubmit={(e) => void handleJoinSubmit(e)} style={{ maxWidth: '480px', margin: '0 auto', display: 'grid', gap: '14px', paddingTop: '16px' }}>
                  <p style={{ color: 'var(--nodic-muted)' }}>
                    Paste the invitation code received from your channel lead.
                  </p>

                  <div>
                    <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Your Display Name</label>
                    <input
                      type="text"
                      value={joinNameInput}
                      onChange={(e) => setJoinNameInput(e.target.value)}
                      placeholder={identity?.displayName || 'e.g. Rocket Puncher'}
                      style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Invitation Code *</label>
                    <textarea
                      rows={3}
                      required
                      value={joinCodeInput}
                      onChange={(e) => setJoinCodeInput(e.target.value)}
                      placeholder="nodic:v1:..."
                      style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white', fontFamily: 'monospace', fontSize: '12px' }}
                    />
                  </div>

                  {joinStatus && (
                    <div style={{ padding: '10px', borderRadius: '8px', background: joinStatus.startsWith('Error') ? '#ffeef0' : '#eaf8f4', color: joinStatus.startsWith('Error') ? '#b3261e' : '#146c54', fontSize: '13px' }}>
                      {joinStatus}
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                    <IonButton fill="outline" onClick={() => setShowJoinModal(false)}>Cancel</IonButton>
                    <IonButton type="submit" disabled={!joinCodeInput.trim()}>Submit Join Request</IonButton>
                  </div>
                </form>
              </IonContent>
            </IonModal>
          </div>
        </IonContent>
      </IonPage>
    );
  }

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
      // fallback
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
      }, 1200);
    } else {
      setJoinStatus(`Error: ${result.message}`);
    }
  }

  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="page-wrap narrow-page">
          <PageHeader
            eyebrow="Channel roster · Local Authority"
            title="Connected people"
            detail="The channel lead controls access and delegates task management to co-leads."
            action={
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <IonButton fill="outline" onClick={() => setShowJoinModal(true)}>
                  <IonIcon slot="start" icon={enterOutline} />
                  Join with code
                </IonButton>
                {isLead && (
                  <IonButton className="primary-action" onClick={() => void handleOpenInvite()}>
                    <IonIcon slot="start" icon={linkOutline} />
                    Invite member
                  </IonButton>
                )}
              </div>
            }
          />

          <section className="member-list" aria-label="Member roster">
            {channel.members.map((member) => {
              const isSelf = member.deviceId === channel.currentUserDeviceId;
              return (
                <article key={member.deviceId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <span className={`member-avatar presence-${member.presence.toLowerCase()}`}>
                      {member.initials}
                    </span>
                    <div>
                      <strong>
                        {member.displayName} {isSelf && <span style={{ color: 'var(--nodic-current)', fontSize: '11px' }}>(You)</span>}
                      </strong>
                      <small style={{ display: 'block', color: 'var(--nodic-muted)', fontSize: '11px' }}>
                        {member.role === 'LEAD' ? 'Channel Lead' : member.role === 'CO_LEAD' ? 'Co-Lead (Task Admin)' : 'Member'}
                      </small>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="member-presence" style={{ fontSize: '11px', textTransform: 'uppercase' }}>
                      {member.presence.toLowerCase()}
                    </span>

                    {/* Lead controls for other members */}
                    {isLead && !isSelf && member.role !== 'LEAD' && (
                      <>
                        <IonButton
                          fill="clear"
                          size="small"
                          color={member.role === 'CO_LEAD' ? 'medium' : 'primary'}
                          onClick={() => void updateMemberRole(member.deviceId, member.role === 'CO_LEAD' ? 'MEMBER' : 'CO_LEAD')}
                          title={member.role === 'CO_LEAD' ? 'Demote to regular member' : 'Appoint as co-lead'}
                        >
                          <IonIcon slot="icon-only" icon={shieldCheckmarkOutline} />
                        </IonButton>

                        <IonButton
                          fill="clear"
                          size="small"
                          color="danger"
                          onClick={() => setMemberToRemove({ deviceId: member.deviceId, name: member.displayName })}
                          title="Remove member from channel"
                        >
                          <IonIcon slot="icon-only" icon={trashOutline} />
                        </IonButton>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </section>

          {/* Invitation Code Modal */}
          <IonModal isOpen={showInviteModal} onDidDismiss={() => setShowInviteModal(false)}>
            <IonHeader>
              <IonToolbar>
                <IonTitle>Share Invitation Code</IonTitle>
                <IonButtons slot="end">
                  <IonButton onClick={() => setShowInviteModal(false)}>
                    <IonIcon icon={closeOutline} />
                  </IonButton>
                </IonButtons>
              </IonToolbar>
            </IonHeader>
            <IonContent className="ion-padding">
              <div style={{ maxWidth: '480px', margin: '0 auto', textAlign: 'center', paddingTop: '16px' }}>
                <p style={{ color: 'var(--nodic-muted)', marginBottom: '16px' }}>
                  Share this invitation code with a teammate on the same Wi-Fi network. Valid for 24 hours.
                </p>

                <div
                  style={{
                    background: '#e8f2f4',
                    padding: '16px',
                    borderRadius: '12px',
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
                  <IonButton onClick={() => void handleCopyCode()}>
                    <IonIcon slot="start" icon={copyOutline} />
                    {copied ? 'Copied to Clipboard!' : 'Copy Code'}
                  </IonButton>
                  <IonButton fill="outline" onClick={() => setShowInviteModal(false)}>
                    Done
                  </IonButton>
                </div>
              </div>
            </IonContent>
          </IonModal>

          {/* Join Channel Modal */}
          <IonModal isOpen={showJoinModal} onDidDismiss={() => setShowJoinModal(false)}>
            <IonHeader>
              <IonToolbar>
                <IonTitle>Join Channel</IonTitle>
                <IonButtons slot="end">
                  <IonButton onClick={() => setShowJoinModal(false)}>
                    <IonIcon icon={closeOutline} />
                  </IonButton>
                </IonButtons>
              </IonToolbar>
            </IonHeader>
            <IonContent className="ion-padding">
              <form onSubmit={(e) => void handleJoinSubmit(e)} style={{ maxWidth: '480px', margin: '0 auto', display: 'grid', gap: '14px', paddingTop: '16px' }}>
                <p style={{ color: 'var(--nodic-muted)' }}>
                  Paste the invitation code received from your channel lead.
                </p>

                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Your Display Name</label>
                  <input
                    type="text"
                    value={joinNameInput}
                    onChange={(e) => setJoinNameInput(e.target.value)}
                    placeholder="e.g. Alex"
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Invitation Code *</label>
                  <textarea
                    rows={3}
                    required
                    value={joinCodeInput}
                    onChange={(e) => setJoinCodeInput(e.target.value)}
                    placeholder="nodic:v1:..."
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white', fontFamily: 'monospace', fontSize: '12px' }}
                  />
                </div>

                {joinStatus && (
                  <div style={{ padding: '10px', borderRadius: '8px', background: joinStatus.startsWith('Error') ? '#ffeef0' : '#eaf8f4', color: joinStatus.startsWith('Error') ? '#b3261e' : '#146c54', fontSize: '13px' }}>
                    {joinStatus}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                  <IonButton fill="outline" onClick={() => setShowJoinModal(false)}>Cancel</IonButton>
                  <IonButton type="submit" disabled={!joinCodeInput.trim()}>Submit Join Request</IonButton>
                </div>
              </form>
            </IonContent>
          </IonModal>

          {/* Remove Member Confirmation Alert */}
          <IonAlert
            isOpen={Boolean(memberToRemove)}
            header="Remove Member"
            message={`Are you sure you want to remove ${memberToRemove?.name} from this channel? They will no longer be authorized to submit changes.`}
            buttons={[
              { text: 'Cancel', role: 'cancel', handler: () => setMemberToRemove(null) },
              {
                text: 'Remove',
                role: 'destructive',
                handler: () => {
                  if (memberToRemove) {
                    void removeMember(memberToRemove.deviceId);
                    setMemberToRemove(null);
                  }
                },
              },
            ]}
          />
        </div>
      </IonContent>
    </IonPage>
  );
}
