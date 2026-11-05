import { useEffect, useState, type FormEvent } from 'react';
import {
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
import { closeOutline, copyOutline, enterOutline, linkOutline, refreshOutline, trashOutline } from 'ionicons/icons';
import type { SyncStatus } from '../../../protocol/contracts';
import { nativeSync, type ProbeResult } from '../../services/native-sync';
import { useWorkspace } from '../../app/workspace-context';
import { PageHeader } from '../../shared/PageHeader';

export function NetworkPage() {
  const { channel, identity, updateDisplayName, createChannel, joinChannelWithCode, leaveChannel, resetDatabase } = useWorkspace();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  // Username edit state
  const [usernameInput, setUsernameInput] = useState('');
  const [savedNameNotice, setSavedNameNotice] = useState(false);

  // Channel creation state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelDesc, setNewChannelDesc] = useState('');

  // Join channel state
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [joinStatus, setJoinStatus] = useState<string | null>(null);

  useEffect(() => {
    if (identity?.displayName) {
      setUsernameInput(identity.displayName);
    }
  }, [identity?.displayName]);

  useEffect(() => {
    void nativeSync.getStatus().then(setStatus);
    if (!nativeSync.isNative()) return;
    const listener = nativeSync.plugin.addListener('statusChanged', setStatus);
    return () => { void listener.then((handle) => handle.remove()); };
  }, []);

  async function handleSaveUsername(e: FormEvent) {
    e.preventDefault();
    if (!usernameInput.trim()) return;
    await updateDisplayName(usernameInput.trim());
    setSavedNameNotice(true);
    setTimeout(() => setSavedNameNotice(false), 2500);
  }

  async function handleCreateChannel(e: FormEvent) {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    await createChannel(newChannelName.trim(), newChannelDesc.trim() || undefined, true);
    setNewChannelName('');
    setNewChannelDesc('');
    setShowCreateModal(false);
  }

  async function handleJoinChannel(e: FormEvent) {
    e.preventDefault();
    if (!joinCodeInput.trim()) return;
    setJoinStatus('Joining channel...');
    const result = await joinChannelWithCode(joinCodeInput.trim(), usernameInput.trim() || undefined);
    if (result.success) {
      setJoinStatus('Success!');
      setTimeout(() => {
        setShowJoinModal(false);
        setJoinCodeInput('');
        setJoinStatus(null);
      }, 1000);
    } else {
      setJoinStatus(`Error: ${result.message}`);
    }
  }

  async function startNetwork() {
    setStatus(await nativeSync.start(identity?.displayName ?? 'Nodic'));
  }

  async function sendProbe() {
    const result = await nativeSync.sendProbe();
    setProbe((current) => ({
      pluginReady: nativeSync.isNative(),
      databaseReady: current?.databaseReady ?? false,
      serviceReady: status?.state !== 'STOPPED',
      deviceId: current?.deviceId ?? identity?.deviceId ?? 'pending',
      details: [...(current?.details ?? []), result.accepted ? `Probe ${result.probeId.slice(0, 8)} queued.` : 'No discovered peer accepted the probe.'],
    }));
    setStatus(await nativeSync.getStatus());
  }

  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="page-wrap narrow-page">
          <PageHeader
            eyebrow="Device & Network Hub"
            title="Local Configuration"
            detail="Configure your username, manage channel membership, and discover nearby peers on Wi-Fi."
          />

          {/* Device Identity & Username Configuration Card */}
          <section className="network-card" style={{ marginBottom: '18px', gridTemplateColumns: '1fr' }}>
            <div style={{ display: 'grid', gap: '12px' }}>
              <span className="eyebrow">Device Identity Configuration</span>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <small style={{ color: 'var(--nodic-muted)', display: 'block', textTransform: 'uppercase', fontSize: '10px' }}>Unique Nodic Identifier</small>
                  <strong style={{ fontSize: '15px', fontFamily: 'monospace' }}>{identity?.shortId ?? 'Generating...'}</strong>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--nodic-muted)' }}>
                  ID: {identity?.deviceId.slice(0, 18)}...
                </div>
              </div>

              <form onSubmit={(e) => void handleSaveUsername(e)} style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginTop: '6px' }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="username-cfg" style={{ display: 'block', marginBottom: '4px', fontSize: '12px', fontWeight: 600 }}>
                    Username (Display Name)
                  </label>
                  <input
                    id="username-cfg"
                    type="text"
                    required
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    placeholder="e.g. Rocket Puncher"
                    style={{ width: '100%', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                  />
                </div>
                <IonButton type="submit" disabled={!usernameInput.trim() || usernameInput === identity?.displayName}>
                  Save Name
                </IonButton>
              </form>
              {savedNameNotice && <span style={{ color: '#167a92', fontSize: '12px', fontWeight: 600 }}>Username updated across local network!</span>}
            </div>
          </section>

          {/* Channel / Workspace Management Card */}
          <section className="network-card" style={{ marginBottom: '18px', gridTemplateColumns: '1fr' }}>
            <div style={{ display: 'grid', gap: '12px' }}>
              <span className="eyebrow">Channel / Workspace</span>
              {channel ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <div>
                      <h3 style={{ margin: '0 0 4px', fontSize: '20px' }}>{channel.name}</h3>
                      <p style={{ margin: 0, color: 'var(--nodic-muted)', fontSize: '12px' }}>{channel.description || 'Department channel'}</p>
                    </div>
                    <span style={{ padding: '4px 10px', borderRadius: '12px', background: 'rgba(105, 196, 200, 0.15)', color: 'var(--nodic-signal)', fontSize: '12px', fontWeight: 700 }}>
                      {channel.members.find((m) => m.deviceId === identity?.deviceId)?.role === 'LEAD' ? 'Team Lead' : 'Member'}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
                    <IonButton fill="outline" color="medium" size="small" onClick={() => void leaveChannel()}>
                      Leave Channel
                    </IonButton>
                    <IonButton fill="outline" color="danger" size="small" onClick={() => void resetDatabase()}>
                      <IonIcon slot="start" icon={trashOutline} />
                      Clean Slate (Reset Data)
                    </IonButton>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={{ color: 'var(--nodic-muted)', margin: '0 0 14px' }}>
                    You are not currently in a channel. As Team Lead, create a new channel and broadcast it on the local network, or join a channel using an invite code.
                  </p>
                  <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <IonButton className="primary-action" onClick={() => setShowCreateModal(true)}>
                      <IonIcon slot="start" icon={linkOutline} />
                      Create Channel (Team Lead)
                    </IonButton>
                    <IonButton fill="outline" onClick={() => setShowJoinModal(true)}>
                      <IonIcon slot="start" icon={enterOutline} />
                      Join with Code
                    </IonButton>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Wi-Fi & LAN Diagnostics */}
          <section className="network-card">
            <div className={`network-orb state-${status?.state.toLowerCase() ?? 'stopped'}`}><span /></div>
            <div>
              <span className="eyebrow">Local Wi-Fi Mesh</span>
              <h2>{status?.state.toLowerCase() ?? 'checking'}</h2>
              <p>{status?.detail ?? 'Reading native service status…'}</p>
            </div>
            <dl>
              <div><dt>Nearby peers</dt><dd>{status?.peerCount ?? '—'}</dd></div>
              <div><dt>Pending events</dt><dd>{status?.pendingEventCount ?? '—'}</dd></div>
              <div><dt>Runtime</dt><dd>{nativeSync.isNative() ? 'Android' : 'Browser preview'}</dd></div>
            </dl>
          </section>

          <section className="probe-card">
            <div>
              <h2>Foreground Service Probe</h2>
              <p>Check the native discovery socket and SQLite background sync.</p>
            </div>
            <div className="probe-actions">
              <IonButton fill="outline" onClick={() => void nativeSync.runProbe().then(setProbe)}>Check native</IonButton>
              {status?.state === 'STOPPED' && <IonButton onClick={() => void startNetwork()}>Start network</IonButton>}
              {status?.state !== 'STOPPED' && <IonButton onClick={() => void sendProbe()}>Send probe</IonButton>}
            </div>
            {probe && <ul>{probe.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
          </section>

          {/* Create Channel Modal */}
          <IonModal isOpen={showCreateModal} onDidDismiss={() => setShowCreateModal(false)}>
            <IonHeader>
              <IonToolbar>
                <IonTitle>Create Work Channel</IonTitle>
                <IonButtons slot="end">
                  <IonButton onClick={() => setShowCreateModal(false)}><IonIcon icon={closeOutline} /></IonButton>
                </IonButtons>
              </IonToolbar>
            </IonHeader>
            <IonContent className="ion-padding">
              <form onSubmit={(e) => void handleCreateChannel(e)} style={{ maxWidth: '440px', margin: '0 auto', display: 'grid', gap: '14px', paddingTop: '14px' }}>
                <p style={{ color: 'var(--nodic-muted)' }}>
                  You will become the Team Lead for this channel and can invite members or appoint co-leads.
                </p>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Channel Name *</label>
                  <input
                    type="text"
                    required
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder="e.g. Operations Alpha"
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Description</label>
                  <textarea
                    rows={2}
                    value={newChannelDesc}
                    onChange={(e) => setNewChannelDesc(e.target.value)}
                    placeholder="Brief channel purpose..."
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                  />
                </div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
                  <IonButton fill="outline" onClick={() => setShowCreateModal(false)}>Cancel</IonButton>
                  <IonButton type="submit" disabled={!newChannelName.trim()}>Create & Broadcast</IonButton>
                </div>
              </form>
            </IonContent>
          </IonModal>

          {/* Join Channel Modal */}
          <IonModal isOpen={showJoinModal} onDidDismiss={() => setShowJoinModal(false)}>
            <IonHeader>
              <IonToolbar>
                <IonTitle>Join Channel via Code</IonTitle>
                <IonButtons slot="end">
                  <IonButton onClick={() => setShowJoinModal(false)}><IonIcon icon={closeOutline} /></IonButton>
                </IonButtons>
              </IonToolbar>
            </IonHeader>
            <IonContent className="ion-padding">
              <form onSubmit={(e) => void handleJoinChannel(e)} style={{ maxWidth: '440px', margin: '0 auto', display: 'grid', gap: '14px', paddingTop: '14px' }}>
                <p style={{ color: 'var(--nodic-muted)' }}>
                  Paste the invitation code generated by your Team Lead.
                </p>
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
                  <IonButton type="submit" disabled={!joinCodeInput.trim()}>Join Channel</IonButton>
                </div>
              </form>
            </IonContent>
          </IonModal>
        </div>
      </IonContent>
    </IonPage>
  );
}
