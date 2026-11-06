import { useEffect, useState, type FormEvent } from 'react';
import { IonIcon } from '@ionic/react';
import { trashOutline, wifiOutline, checkmarkCircleOutline } from 'ionicons/icons';
import type { SyncStatus } from '../../../protocol/contracts';
import { nativeSync, type ProbeResult } from '../../services/native-sync';
import { useWorkspace } from '../../app/workspace-context';
import { ConfirmDialog } from '../../shared/Modal';

export function NetworkPage() {
  const { channel, identity, updateDisplayName, leaveChannel, resetDatabase } = useWorkspace();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  // Username edit state
  const [usernameInput, setUsernameInput] = useState('');
  const [savedNameNotice, setSavedNameNotice] = useState(false);
  const [showResetAlert, setShowResetAlert] = useState(false);

  useEffect(() => {
    if (identity?.displayName) {
      setUsernameInput(identity.displayName);
    }
  }, [identity?.displayName]);

  useEffect(() => {
    void nativeSync.getStatus().then(setStatus);
    if (!nativeSync.isNative()) return;
    const listener = nativeSync.plugin.addListener('statusChanged', setStatus);
    return () => {
      void listener.then((handle) => handle.remove());
    };
  }, []);

  async function handleSaveUsername(e: FormEvent) {
    e.preventDefault();
    if (!usernameInput.trim()) return;
    await updateDisplayName(usernameInput.trim());
    setSavedNameNotice(true);
    setTimeout(() => setSavedNameNotice(false), 2500);
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
      details: [
        ...(current?.details ?? []),
        result.accepted
          ? `Probe ${result.probeId.slice(0, 8)} broadcasted.`
          : 'No discovered peer accepted the probe.',
      ],
    }));
    setStatus(await nativeSync.getStatus());
  }

  return (
    <div className="screen-container">
      <div className="page-wrap narrow-page">
        {/* Header Chip matching wireframe prototype */}
        <div className="channel-header-chip">
          <div>
            <strong>Network Configuration</strong>
            <small>Device & Diagnostic Hub</small>
          </div>
          <IonIcon icon={wifiOutline} style={{ fontSize: '20px', color: 'var(--nodic-signal)' }} />
        </div>

        <div className="network-hub-grid">
          {/* Card 1: Device Configuration & Username */}
          <div className="hub-card">
            <h3>Device Configuration</h3>
            <p>Configure how this node identifies on the peer-to-peer Wi-Fi LAN.</p>

            <div style={{ display: 'grid', gap: '10px', marginBottom: '14px' }}>
              <div>
                <small style={{ color: 'var(--nodic-muted)', display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '3px' }}>
                  Nodic Identifier
                </small>
                <strong style={{ fontFamily: 'monospace', fontSize: '14px', background: '#f0f4f5', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--nodic-line)' }}>
                  {identity?.shortId ?? 'nodic-node'}
                </strong>
              </div>

              <form onSubmit={(e) => void handleSaveUsername(e)} style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', marginTop: '6px' }}>
                <div style={{ flex: 1 }}>
                  <label htmlFor="username-input" style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                    Username
                  </label>
                  <input
                    id="username-input"
                    type="text"
                    required
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    placeholder="e.g. Rocket Puncher"
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                  />
                </div>
                <button
                  type="submit"
                  className="dialog-btn-primary"
                  style={{ padding: '9px 16px' }}
                  disabled={!usernameInput.trim() || usernameInput === identity?.displayName}
                >
                  Save Name
                </button>
              </form>

              {savedNameNotice && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#16a34a', fontSize: '12px', fontWeight: 600 }}>
                  <IonIcon icon={checkmarkCircleOutline} />
                  <span>Username saved!</span>
                </div>
              )}
            </div>
          </div>

          {/* Card 2: Local Wi-Fi Mesh Network Diagnostics */}
          <div className="hub-card">
            <h3>Local Wi-Fi Mesh Network</h3>
            <p>Direct peer communication operates over local subnet broadcasting without internet servers.</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '10px' }}>
              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Subnet / Port</small>
                <strong style={{ fontSize: '13px' }}>192.168.x.x:8443</strong>
              </div>

              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Nearby Peers</small>
                <strong style={{ fontSize: '13px', color: status?.peerCount ? '#16a34a' : 'inherit' }}>
                  {status?.peerCount ?? 0} Discovered
                </strong>
              </div>

              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Service Status</small>
                <strong style={{ fontSize: '13px', color: status?.state === 'CONNECTED' ? '#16a34a' : 'inherit' }}>
                  {status?.state ?? 'STANDBY'}
                </strong>
              </div>
            </div>
          </div>

          {/* Card 3: Foreground Service & Probe Testing */}
          <div className="hub-card">
            <h3>Service Diagnostics & Probes</h3>
            <p>Test background peer discovery socket and probe exchange.</p>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
              <button
                className="dialog-btn-outline"
                onClick={() => void nativeSync.runProbe().then(setProbe)}
              >
                Check Native Socket
              </button>
              {status?.state === 'STOPPED' && (
                <button className="dialog-btn-primary" onClick={() => void startNetwork()}>
                  Start Network
                </button>
              )}
              <button className="dialog-btn-primary" onClick={() => void sendProbe()}>
                Send Probe
              </button>
            </div>

            {probe && probe.details.length > 0 && (
              <div style={{ background: '#f0f4f5', padding: '10px 14px', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
                {probe.details.map((d, i) => (
                  <div key={i}>• {d}</div>
                ))}
              </div>
            )}
          </div>

          {/* Card 4: Channel & Data Management */}
          <div className="hub-card">
            <h3>Channel & Database Management</h3>
            <p>Manage current channel state or reset the database on this node.</p>

            {channel ? (
              <div style={{ marginBottom: '14px', padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{channel.name}</strong>
                    <small style={{ display: 'block', color: 'var(--nodic-muted)', fontSize: '11px' }}>
                      ID: {channel.id.slice(0, 12)}...
                    </small>
                  </div>
                  <button className="dialog-btn-outline" onClick={() => void leaveChannel()}>
                    Leave Channel
                  </button>
                </div>
              </div>
            ) : (
              <p style={{ color: 'var(--nodic-muted)', fontSize: '12px' }}>
                No active channel currently loaded. Create or switch channels from the top-left drawer menu.
              </p>
            )}

            <div style={{ borderTop: '1px dashed #cbdfe3', paddingTop: '12px', marginTop: '12px' }}>
              <small style={{ color: '#b3261e', display: 'block', fontWeight: 700, marginBottom: '6px', fontSize: '11px', textTransform: 'uppercase' }}>
                Danger Zone
              </small>
              <button
                className="dialog-btn-danger"
                onClick={() => setShowResetAlert(true)}
              >
                <IonIcon icon={trashOutline} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                Reset Database (Clean Slate)
              </button>
            </div>
          </div>
        </div>

        {/* Pure React Reset Confirmation Alert */}
        <ConfirmDialog
          isOpen={showResetAlert}
          title="Reset Local Database"
          message="Are you sure you want to erase all local channels, tasks, and messages? This action cannot be undone."
          confirmText="Erase Everything"
          confirmDestructive
          onConfirm={() => {
            void resetDatabase();
            setShowResetAlert(false);
          }}
          onCancel={() => setShowResetAlert(false)}
        />
      </div>
    </div>
  );
}