import { useEffect, useState, type FormEvent } from 'react';
import { IonIcon } from '@ionic/react';
import {
  trashOutline,
  wifiOutline,
  checkmarkCircleOutline,
  refreshOutline,
  linkOutline,
  batteryChargingOutline,
  shieldCheckmarkOutline,
  warningOutline,
  notificationsOutline,
} from 'ionicons/icons';
import type { SyncStatus } from '../../../protocol/contracts';
import { nativeSync, type ProbeResult, type BatteryOptimizationStatus } from '../../services/native-sync';
import { useWorkspace } from '../../app/workspace-context';
import { ConfirmDialog } from '../../shared/Modal';

export function NetworkPage() {
  const {
    channel,
    identity,
    peerIdentities,
    peerSessions,
    syncLogs,
    updateDisplayName,
    leaveChannel,
    resetDatabase,
    connectToPeer,
    refreshNetworkDiagnostics,
    clearSyncLogs,
  } = useWorkspace();

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [batteryStatus, setBatteryStatus] = useState<BatteryOptimizationStatus | null>(null);

  // Username edit state
  const [usernameInput, setUsernameInput] = useState('');
  const [savedNameNotice, setSavedNameNotice] = useState(false);
  const [showResetAlert, setShowResetAlert] = useState(false);

  // Direct peer connect state
  const [peerHostInput, setPeerHostInput] = useState('');
  const [peerPortInput, setPeerPortInput] = useState('8443');
  const [connectNotice, setConnectNotice] = useState<string | null>(null);

  useEffect(() => {
    if (identity?.displayName) {
      setUsernameInput(identity.displayName);
    }
  }, [identity?.displayName]);

  useEffect(() => {
    void nativeSync.getStatus().then(setStatus);
    void nativeSync.getBatteryOptimizationStatus().then(setBatteryStatus);
    void refreshNetworkDiagnostics();
    if (!nativeSync.isNative()) return;
    const listener = nativeSync.plugin.addListener('statusChanged', (nextStatus) => {
      setStatus(nextStatus);
      void refreshNetworkDiagnostics();
    });
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
    const nextStatus = await nativeSync.start(
      identity?.displayName ?? 'Nodic',
      identity?.deviceId,
      identity?.publicSigningKey,
    );
    setStatus(nextStatus);
    await refreshNetworkDiagnostics();
  }

  async function stopNetwork() {
    const nextStatus = await nativeSync.stop();
    setStatus(nextStatus);
    await refreshNetworkDiagnostics();
  }

  async function handleConnectPeer(e: FormEvent) {
    e.preventDefault();
    const host = peerHostInput.trim();
    const port = Number(peerPortInput);
    if (!host || !Number.isInteger(port) || port <= 0) return;

    setConnectNotice(`Connecting to ${host}:${port}...`);
    try {
      const ok = await connectToPeer(host, port);
      setStatus(await nativeSync.getStatus());
      setConnectNotice(
        ok
          ? `Handshake & session saved with ${host}:${port}`
          : `Could not reach peer at ${host}:${port}`,
      );
    } catch (err: any) {
      setConnectNotice(`Connection error: ${err?.message ?? 'failed'}`);
    }
  }

  async function sendProbe() {
    const result = await nativeSync.sendProbe();
    setProbe((current) => ({
      pluginReady: nativeSync.isNative(),
      databaseReady: current?.databaseReady ?? true,
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
    await refreshNetworkDiagnostics();
  }

  return (
    <div className="screen-container">
      <div className="page-wrap narrow-page">
        {/* Header Chip matching wireframe prototype */}
        <div className="channel-header-chip">
          <div>
            <strong>Network Configuration</strong>
            <small>Device Identity, Peer Sessions & Sync Logs</small>
          </div>
          <IonIcon icon={wifiOutline} style={{ fontSize: '20px', color: 'var(--nodic-signal)' }} />
        </div>

        <div className="network-hub-grid">
          {/* Card 1: Device Configuration & Persisted Identity */}
          <div className="hub-card">
            <h3>Device Identity (Persisted in Local DB)</h3>
            <p>Cryptographic node identity saved in local SQLite and exchanged during peer handshakes.</p>

            <div style={{ display: 'grid', gap: '10px', marginBottom: '14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' }}>
                <div>
                  <small style={{ color: 'var(--nodic-muted)', display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '3px' }}>
                    Nodic Identifier
                  </small>
                  <strong style={{ fontFamily: 'monospace', fontSize: '13px', background: '#f0f4f5', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--nodic-line)', display: 'inline-block' }}>
                    {identity?.shortId ?? 'nodic-node'}
                  </strong>
                </div>

                <div>
                  <small style={{ color: 'var(--nodic-muted)', display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '3px' }}>
                    Public Key Fingerprint
                  </small>
                  <strong style={{ fontFamily: 'monospace', fontSize: '12px', background: '#f0f4f5', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--nodic-line)', display: 'inline-block' }}>
                    {identity?.publicSigningKey ? `${identity.publicSigningKey.slice(0, 20)}…` : 'p256:pending'}
                  </strong>
                </div>

                <div>
                  <small style={{ color: 'var(--nodic-muted)', display: 'block', fontSize: '11px', textTransform: 'uppercase', marginBottom: '3px' }}>
                    Lamport Logical Clock
                  </small>
                  <strong style={{ fontFamily: 'monospace', fontSize: '13px', background: '#f0f4f5', padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--nodic-line)', display: 'inline-block' }}>
                    L={identity?.lamportClock ?? 0}
                  </strong>
                </div>
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
                  <span>Username saved to local database and announced to peers!</span>
                </div>
              )}
            </div>
          </div>

          {/* Card 2: Local Wi-Fi Mesh Network & Peer Connection */}
          <div className="hub-card">
            <h3>Local Wi-Fi Mesh Network</h3>
            <p>Direct peer communication over local Wi-Fi NSD discovery and TCP session handshakes.</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '12px' }}>
              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Local Endpoint</small>
                <strong style={{ fontSize: '13px', fontFamily: 'monospace' }}>
                  {status?.localEndpoint ?? 'NSD Dynamic Port'}
                </strong>
              </div>

              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Nearby Peers</small>
                <strong style={{ fontSize: '13px', color: (status?.peerCount || peerIdentities.some((p) => p.status === 'ONLINE')) ? '#16a34a' : 'inherit' }}>
                  {Math.max(status?.peerCount ?? 0, peerIdentities.filter((p) => p.status === 'ONLINE').length)} Connected
                </strong>
              </div>

              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Service Status</small>
                <strong style={{ fontSize: '13px', color: status?.state === 'CONNECTED' ? '#16a34a' : 'inherit' }}>
                  {status?.state ?? 'STANDBY'}
                </strong>
              </div>
            </div>

            <form
              onSubmit={(e) => void handleConnectPeer(e)}
              style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '10px' }}
            >
              <div style={{ flex: '2 1 160px' }}>
                <label htmlFor="peer-host-input" style={{ display: 'block', fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>
                  Direct Peer IP / Host
                </label>
                <input
                  id="peer-host-input"
                  type="text"
                  value={peerHostInput}
                  onChange={(e) => setPeerHostInput(e.target.value)}
                  placeholder="e.g. 192.168.1.42"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white', fontSize: '13px' }}
                />
              </div>
              <div style={{ flex: '1 1 80px', maxWidth: '110px' }}>
                <label htmlFor="peer-port-input" style={{ display: 'block', fontSize: '11px', fontWeight: 600, marginBottom: '4px' }}>
                  Port
                </label>
                <input
                  id="peer-port-input"
                  type="number"
                  value={peerPortInput}
                  onChange={(e) => setPeerPortInput(e.target.value)}
                  placeholder="8443"
                  style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white', fontSize: '13px' }}
                />
              </div>
              <button
                type="submit"
                className="dialog-btn-primary"
                style={{ padding: '8px 14px' }}
                disabled={!peerHostInput.trim()}
              >
                <IonIcon icon={linkOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                Connect Peer
              </button>
            </form>

            {connectNotice && (
              <div style={{ fontSize: '12px', color: 'var(--nodic-ink)', background: '#f0f4f5', padding: '6px 10px', borderRadius: '6px', marginBottom: '8px' }}>
                {connectNotice}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                className="dialog-btn-outline"
                onClick={() => void nativeSync.runProbe().then(setProbe)}
              >
                Check Native Socket
              </button>
              {status?.state === 'STOPPED' ? (
                <button className="dialog-btn-primary" onClick={() => void startNetwork()}>
                  Start Network
                </button>
              ) : (
                <button className="dialog-btn-outline" onClick={() => void stopNetwork()}>
                  Stop Network
                </button>
              )}
              <button className="dialog-btn-primary" onClick={() => void sendProbe()}>
                Send Probe
              </button>
              <button
                className="dialog-btn-outline"
                onClick={() => void refreshNetworkDiagnostics()}
                title="Refresh saved sessions and logs"
              >
                <IonIcon icon={refreshOutline} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                Refresh DB
              </button>
            </div>

            {probe && probe.details.length > 0 && (
              <div style={{ background: '#f0f4f5', padding: '10px 14px', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace', marginTop: '10px' }}>
                {probe.details.map((d, i) => (
                  <div key={i}>• {d}</div>
                ))}
              </div>
            )}
          </div>

          {/* Card 2.5: Background Sync & Battery Optimization (Phase 4) */}
          <div className="hub-card">
            <h3>Background Operation & Battery Optimization</h3>
            <p>Android foreground service and system policies governing offline LAN synchronization when the UI is closed.</p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '14px' }}>
              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Foreground Service</small>
                <strong style={{ fontSize: '13px', color: status?.state !== 'STOPPED' ? '#16a34a' : 'inherit' }}>
                  {status?.state !== 'STOPPED' ? 'Active (Data Sync)' : 'Paused / Stopped'}
                </strong>
              </div>

              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Battery Exemption</small>
                <strong style={{ fontSize: '13px', color: batteryStatus?.ignoringBatteryOptimizations ? '#16a34a' : '#d97706' }}>
                  {batteryStatus?.ignoringBatteryOptimizations ? 'Unrestricted' : 'Optimized'}
                </strong>
              </div>

              <div style={{ padding: '10px', background: '#f8fafb', borderRadius: '8px', border: '1px solid var(--nodic-line)' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '10px', display: 'block', textTransform: 'uppercase' }}>Hardware / OS</small>
                <strong style={{ fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                  {batteryStatus?.manufacturer ? `${batteryStatus.manufacturer} ${batteryStatus.model ?? ''}` : 'Android Device'}
                </strong>
              </div>
            </div>

            {batteryStatus?.ignoringBatteryOptimizations ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: '#f0fdf4', border: '1px solid #bbf7d0', padding: '10px 12px', borderRadius: '8px', marginBottom: '12px' }}>
                <IonIcon icon={shieldCheckmarkOutline} style={{ color: '#16a34a', fontSize: '20px', flexShrink: 0 }} />
                <div style={{ fontSize: '12px', color: '#166534' }}>
                  <strong>Battery optimization exempted.</strong> Android will not sleep Nodic when swiped away or when the screen is locked.
                </div>
              </div>
            ) : (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', padding: '10px 12px', borderRadius: '8px', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
                  <IonIcon icon={warningOutline} style={{ color: '#d97706', fontSize: '20px', flexShrink: 0, marginTop: '2px' }} />
                  <div style={{ fontSize: '12px', color: '#92400e' }}>
                    <strong>Aggressive battery savers may suspend sync.</strong> Many Android OEMs (Samsung, Xiaomi, Huawei, etc.) kill background foreground services unless battery optimization is set to Unrestricted.
                  </div>
                </div>
                {batteryStatus?.canRequest && (
                  <button
                    className="dialog-btn-primary"
                    style={{ padding: '6px 12px', fontSize: '12px' }}
                    onClick={async () => {
                      await nativeSync.requestIgnoreBatteryOptimizations();
                      const next = await nativeSync.getBatteryOptimizationStatus();
                      setBatteryStatus(next);
                    }}
                  >
                    <IonIcon icon={batteryChargingOutline} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
                    Request Unrestricted Battery Exemption
                  </button>
                )}
              </div>
            )}

            <div style={{ display: 'grid', gap: '6px', fontSize: '11px', color: 'var(--nodic-muted)' }}>
              <div>• <strong>Network Recovery:</strong> Dynamic Wi-Fi reconnect and DHCP change rediscovery via ConnectivityManager.NetworkCallback.</div>
              <div>• <strong>Boot Auto-Start:</strong> Automatic restart of foreground sync after device reboot via NodicBootReceiver.</div>
              <div>• <strong>Content Notifications:</strong> Local notifications for chat messages, task assignments, and join requests with event-ID deduplication.</div>
            </div>
          </div>

          {/* Card 3: Saved Peer Identities & Sessions */}
          <div className="hub-card">
            <h3>Saved Peer Identities & Sessions ({peerSessions.length})</h3>
            <p>Verified peer identities and connection sessions stored in local SQLite.</p>

            {peerIdentities.length > 0 && (
              <div style={{ marginBottom: '12px' }}>
                <small style={{ color: 'var(--nodic-muted)', fontSize: '11px', textTransform: 'uppercase', display: 'block', marginBottom: '6px', fontWeight: 700 }}>
                  Known Peer Nodes ({peerIdentities.length})
                </small>
                <div style={{ display: 'grid', gap: '6px' }}>
                  {peerIdentities.map((peer) => (
                    <div
                      key={peer.deviceId}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '8px',
                        background: '#f8fafb',
                        border: '1px solid var(--nodic-line)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '12px',
                      }}
                    >
                      <div>
                        <strong>{peer.displayName}</strong>{' '}
                        <span style={{ fontFamily: 'monospace', color: 'var(--nodic-muted)', fontSize: '11px' }}>
                          ({peer.deviceId.slice(0, 8)})
                        </span>
                        <div style={{ color: 'var(--nodic-muted)', fontSize: '11px', fontFamily: 'monospace' }}>
                          {peer.host}:{peer.port} · Key: {peer.publicSigningKey.slice(0, 16)}…
                        </div>
                      </div>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: peer.status === 'ONLINE' ? '#16a34a' : 'var(--nodic-muted)',
                        }}
                      >
                        {peer.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {peerSessions.length === 0 ? (
              <div style={{ padding: '14px', background: '#f8fafb', borderRadius: '8px', color: 'var(--nodic-muted)', fontSize: '12px', textAlign: 'center' }}>
                No peer sessions recorded yet. Start networking on two devices or connect to a peer above.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '8px', maxHeight: '220px', overflowY: 'auto' }}>
                {peerSessions.map((session) => (
                  <div
                    key={session.id}
                    style={{
                      padding: '8px 10px',
                      borderRadius: '8px',
                      background: '#f0f4f5',
                      border: '1px solid var(--nodic-line)',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>
                        {session.peerDisplayName}{' '}
                        <span style={{ fontWeight: 400, fontSize: '11px', color: 'var(--nodic-muted)' }}>
                          ({session.direction})
                        </span>
                      </strong>
                      <span
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          color: session.status === 'CONNECTED' ? '#16a34a' : 'var(--nodic-muted)',
                        }}
                      >
                        {session.status}
                      </span>
                    </div>
                    <div style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--nodic-muted)', marginTop: '2px' }}>
                      Endpoint: {session.peerAddress}:{session.peerPort} · Sent: {session.eventsSent} · Recv: {session.eventsReceived}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Card 4: Saved Sync & Connection Logs */}
          <div className="hub-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>Local Database Sync Logs ({syncLogs.length})</h3>
              {syncLogs.length > 0 && (
                <button
                  className="dialog-btn-outline"
                  style={{ padding: '4px 10px', fontSize: '11px' }}
                  onClick={() => void clearSyncLogs()}
                >
                  Clear Logs
                </button>
              )}
            </div>
            <p>Audit trail of identity changes, peer handshakes, sessions, and events stored in SQLite.</p>

            {syncLogs.length === 0 ? (
              <div style={{ padding: '14px', background: '#f8fafb', borderRadius: '8px', color: 'var(--nodic-muted)', fontSize: '12px', textAlign: 'center' }}>
                No sync logs recorded in database.
              </div>
            ) : (
              <div
                style={{
                  background: '#f0f4f5',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  maxHeight: '220px',
                  overflowY: 'auto',
                  display: 'grid',
                  gap: '6px',
                }}
              >
                {syncLogs.map((log) => {
                  const time = new Date(log.createdAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  });
                  return (
                    <div key={log.id} style={{ borderBottom: '1px solid #dce6e9', paddingBottom: '4px' }}>
                      <span style={{ color: log.level === 'ERROR' ? '#b3261e' : log.level === 'WARN' ? '#b45309' : '#0f766e', fontWeight: 700 }}>
                        [{time}] [{log.category}]
                      </span>{' '}
                      <span>{log.message}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card 5: Channel & Data Management */}
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
          message="Are you sure you want to erase all local channels, tasks, messages, peer sessions, and sync logs? This action cannot be undone."
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
