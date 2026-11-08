import { useEffect, useState, type FormEvent } from 'react';
import { IonIcon } from '@ionic/react';
import {
  wifiOutline,
  checkmarkCircleOutline,
  refreshOutline,
  copyOutline,
  personAddOutline,
  radioOutline,
  linkOutline,
  unlinkOutline,
  closeCircleOutline,
} from 'ionicons/icons';
import type { SyncStatus } from '../../../protocol/contracts';
import type { PairingAttemptResult } from '../../db/repository';
import { formatNodicId } from '../../db/repository';
import { nativeSync } from '../../services/native-sync';
import { useWorkspace } from '../../app/workspace-context';

export function NetworkPage() {
  const {
    identity,
    peerIdentities,
    pairedDevices,
    pairingRequests,
    updateDisplayName,
    requestPairingByNodicIds,
    respondToPairingRequest,
    disconnectPeerLocally,
    refreshNetworkDiagnostics,
  } = useWorkspace();

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [usernameInput, setUsernameInput] = useState('');
  const [savedNameNotice, setSavedNameNotice] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // Direct pairing by Nodic User IDs (single or multiple)
  const [nodicIdsInput, setNodicIdsInput] = useState('');
  const [pairingResults, setPairingResults] = useState<PairingAttemptResult[]>([]);
  const [isSendingRequest, setIsSendingRequest] = useState(false);

  useEffect(() => {
    if (identity?.displayName) {
      setUsernameInput(identity.displayName);
    }
  }, [identity?.displayName]);

  useEffect(() => {
    void nativeSync.getStatus().then(setStatus);
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

  async function handleCopyNodicId() {
    if (!identity?.shortId) return;
    try {
      await navigator.clipboard.writeText(identity.shortId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    } catch {
      // Clipboard API may be unavailable in some webviews
    }
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

  async function handleSendPairingRequests(e: FormEvent) {
    e.preventDefault();
    if (!nodicIdsInput.trim()) return;
    setIsSendingRequest(true);
    try {
      const results = await requestPairingByNodicIds(nodicIdsInput);
      setPairingResults(results);
      const allSent =
        results.length > 0 && results.every((r) => r.status === 'REQUEST_SENT');
      if (allSent) {
        setNodicIdsInput('');
      }
    } finally {
      setIsSendingRequest(false);
    }
  }

  async function handleQuickRequestPeer(nodicId: string) {
    setIsSendingRequest(true);
    try {
      const results = await requestPairingByNodicIds([nodicId]);
      setPairingResults(results);
    } finally {
      setIsSendingRequest(false);
    }
  }

  function handleToggleSelectNearbyId(nodicId: string) {
    const currentTokens = nodicIdsInput
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (currentTokens.includes(nodicId)) {
      setNodicIdsInput(currentTokens.filter((t) => t !== nodicId).join(', '));
    } else {
      setNodicIdsInput([...currentTokens, nodicId].join(', '));
    }
  }

  const nearbyOnlinePeers = peerIdentities.filter((p) => p.status === 'ONLINE');
  const pendingInboundRequests = pairingRequests.filter(
    (r) => r.direction === 'INBOUND' && r.status === 'PENDING',
  );

  const connectedNearbyCount = pairedDevices.filter((device) => {
    const isNearby = nearbyOnlinePeers.some(
      (p) =>
        p.deviceId === device.deviceId ||
        formatNodicId(p.deviceId) === device.nodicId,
    );
    return device.pairingState === 'PAIRED' && isNearby;
  }).length;

  return (
    <div className="screen-container">
      <div className="page-wrap narrow-page">
        {/* Header Chip */}
        <div className="channel-header-chip">
          <div>
            <strong>Nearby Devices & Pairing</strong>
            <small>Connect with nearby teammates using Nodic User IDs</small>
          </div>
          <IonIcon icon={wifiOutline} style={{ fontSize: '20px', color: 'var(--nodic-signal)' }} />
        </div>

        <div className="network-hub-grid">
          {/* Card 1: Your Nodic User ID & Discovery Controls */}
          <div className="hub-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px', marginBottom: '12px' }}>
              <div>
                <h3 style={{ margin: 0 }}>Your Nodic Device</h3>
                <p style={{ margin: '4px 0 0' }}>
                  Share your Nodic User ID with nearby teammates so they can send you a connection request.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {status?.state === 'STOPPED' ? (
                  <button className="dialog-btn-primary" onClick={() => void startNetwork()}>
                    Start Discovery
                  </button>
                ) : (
                  <button className="dialog-btn-outline" onClick={() => void stopNetwork()}>
                    Pause Discovery
                  </button>
                )}
                <button
                  className="dialog-btn-outline"
                  onClick={() => void refreshNetworkDiagnostics()}
                  title="Scan for nearby devices"
                >
                  <IonIcon icon={refreshOutline} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  Scan
                </button>
              </div>
            </div>

            <div className="network-summary-strip">
              <div className="network-summary-box">
                <small>Your Nodic User ID</small>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
                  <code className="nodic-id-badge">{identity?.shortId ?? 'nodic-node'}</code>
                  <button
                    type="button"
                    className="task-move-chip"
                    onClick={() => void handleCopyNodicId()}
                    title="Copy Nodic User ID"
                  >
                    <IonIcon icon={copyOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                    {copiedId ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="network-summary-box">
                <small>Nearby Devices</small>
                <strong style={{ color: nearbyOnlinePeers.length > 0 ? '#0f766e' : 'var(--nodic-ink)' }}>
                  {nearbyOnlinePeers.length} Found Nearby
                </strong>
              </div>

              <div className="network-summary-box">
                <small>Active Connections</small>
                <strong style={{ color: connectedNearbyCount > 0 ? '#16a34a' : 'var(--nodic-ink)' }}>
                  {connectedNearbyCount} Connected
                </strong>
              </div>
            </div>

            <form
              onSubmit={(e) => void handleSaveUsername(e)}
              style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', marginTop: '12px' }}
            >
              <div style={{ flex: 1 }}>
                <label
                  htmlFor="username-input"
                  style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}
                >
                  Device Display Name
                </label>
                <input
                  id="username-input"
                  type="text"
                  required
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  placeholder="e.g. Alex's Field Phone"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--nodic-line)',
                    background: 'white',
                  }}
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  color: '#16a34a',
                  fontSize: '12px',
                  fontWeight: 600,
                  marginTop: '8px',
                }}
              >
                <IonIcon icon={checkmarkCircleOutline} />
                <span>Display name updated!</span>
              </div>
            )}
          </div>

          {/* Card 2: Incoming Connection Requests (Bluetooth-style Pairing Approval) */}
          {pendingInboundRequests.length > 0 && (
            <div className="hub-card pairing-requests-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <IonIcon icon={personAddOutline} style={{ fontSize: '18px', color: 'var(--nodic-signal)' }} />
                <h3 style={{ margin: 0 }}>
                  Incoming Connection Requests ({pendingInboundRequests.length})
                </h3>
              </div>
              <p>
                Nearby devices want to pair with you. Accepting saves their Nodic User ID on both devices.
              </p>

              <div style={{ display: 'grid', gap: '8px' }}>
                {pendingInboundRequests.map((req) => (
                  <div key={req.requestId} className="pairing-device-row is-highlight">
                    <div className="pairing-device-row__info">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <strong>{req.fromDisplayName}</strong>
                        <code className="nodic-id-chip">{req.fromNodicId}</code>
                        <span className="device-status-pill is-nearby">Nearby Request</span>
                      </div>
                      <small style={{ color: 'var(--nodic-muted)', fontSize: '11px' }}>
                        Wants to pair and sync with your device
                      </small>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        className="dialog-btn-primary"
                        onClick={() => void respondToPairingRequest(req.requestId, true)}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="dialog-btn-outline"
                        onClick={() => void respondToPairingRequest(req.requestId, false)}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Card 3: Direct Connect by Nodic User ID (Supports Single or Multiple IDs) */}
          <div className="hub-card">
            <h3>Connect by Nodic User ID</h3>
            <p>
              Enter one or more Nodic User IDs (separated by commas or spaces). Nodic checks if they are in
              nearby devices and sends a pairing request to each one.
            </p>

            <form
              onSubmit={(e) => void handleSendPairingRequests(e)}
              style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}
            >
              <div style={{ flex: '1 1 240px' }}>
                <label
                  htmlFor="nodic-ids-input"
                  style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}
                >
                  Nodic User ID(s)
                </label>
                <input
                  id="nodic-ids-input"
                  type="text"
                  value={nodicIdsInput}
                  onChange={(e) => setNodicIdsInput(e.target.value)}
                  placeholder="e.g. nodic-a1b2c3d4, nodic-e5f6g7h8"
                  style={{
                    width: '100%',
                    padding: '9px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--nodic-line)',
                    background: 'white',
                    fontFamily: 'monospace',
                    fontSize: '13px',
                  }}
                />
              </div>
              <button
                type="submit"
                className="dialog-btn-primary"
                style={{ padding: '9px 16px' }}
                disabled={!nodicIdsInput.trim() || isSendingRequest}
              >
                <IonIcon icon={linkOutline} style={{ marginRight: '5px', verticalAlign: 'middle' }} />
                {isSendingRequest ? 'Sending...' : 'Send Connection Request'}
              </button>
            </form>

            {pairingResults.length > 0 && (
              <div style={{ display: 'grid', gap: '6px', marginTop: '12px' }}>
                {pairingResults.map((res, idx) => {
                  const isSuccess = res.status === 'REQUEST_SENT';
                  return (
                    <div
                      key={`${res.nodicId}-${idx}`}
                      className={`pairing-feedback-banner ${isSuccess ? 'is-success' : 'is-warn'}`}
                    >
                      <IonIcon
                        icon={isSuccess ? checkmarkCircleOutline : closeCircleOutline}
                        style={{ fontSize: '16px', flexShrink: 0 }}
                      />
                      <span>{res.message}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card 4: Saved Connections (Persistent Paired Devices) */}
          <div className="hub-card">
            <h3>Saved Connections ({pairedDevices.length})</h3>
            <p>
              Devices paired with you. Shows whether each saved device is currently nearby and connected.
              Disconnecting only disconnects on your device—you can reconnect anytime by sending a request.
            </p>

            {pairedDevices.length === 0 ? (
              <div className="network-empty-box">
                No saved connections yet. Enter a Nodic User ID above or pick from Nearby Devices below.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '8px' }}>
                {pairedDevices.map((device) => {
                  const isNearby = nearbyOnlinePeers.some(
                    (p) =>
                      p.deviceId === device.deviceId ||
                      formatNodicId(p.deviceId) === device.nodicId,
                  );
                  const isConnected = device.pairingState === 'PAIRED' && isNearby;
                  const isLocalDisconnected = device.pairingState === 'DISCONNECTED_LOCAL';
                  const isPendingOutbound = device.pairingState === 'PENDING_OUTBOUND';
                  const isPendingInbound = device.pairingState === 'PENDING_INBOUND';

                  return (
                    <div key={device.deviceId} className="pairing-device-row">
                      <div className="pairing-device-row__info">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <strong>{device.displayName}</strong>
                          <code className="nodic-id-chip">{device.nodicId}</code>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                          <span className={`device-status-pill ${isNearby ? 'is-nearby' : 'is-offline'}`}>
                            {isNearby ? '● Nearby' : '○ Not Nearby'}
                          </span>

                          {isConnected && (
                            <span className="device-status-pill is-connected">Connected</span>
                          )}
                          {device.pairingState === 'PAIRED' && !isNearby && (
                            <span className="device-status-pill is-saved">Saved · Waiting Nearby</span>
                          )}
                          {isPendingOutbound && (
                            <span className="device-status-pill is-pending">Request Sent · Waiting Approval</span>
                          )}
                          {isPendingInbound && (
                            <span className="device-status-pill is-pending">Incoming Request</span>
                          )}
                          {isLocalDisconnected && (
                            <span className="device-status-pill is-disconnected">
                              Disconnected (This Device)
                            </span>
                          )}
                          {device.pairingState === 'DECLINED' && (
                            <span className="device-status-pill is-disconnected">Declined</span>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {device.pairingState === 'PAIRED' ? (
                          <button
                            type="button"
                            className="dialog-btn-outline"
                            onClick={() => void disconnectPeerLocally(device.deviceId)}
                            title="Disconnect on this device only"
                          >
                            <IonIcon icon={unlinkOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                            Disconnect
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="dialog-btn-primary"
                            disabled={!isNearby || isSendingRequest}
                            onClick={() => void handleQuickRequestPeer(device.nodicId)}
                            title={
                              isNearby
                                ? 'Send a connection request to reconnect'
                                : 'Device must be nearby to send a connection request'
                            }
                          >
                            <IonIcon icon={linkOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                            {isPendingOutbound ? 'Resend Request' : 'Send Request'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Card 5: Nearby Devices */}
          <div className="hub-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <IonIcon icon={radioOutline} style={{ fontSize: '18px', color: 'var(--nodic-signal)' }} />
              <h3 style={{ margin: 0 }}>Nearby Devices ({nearbyOnlinePeers.length})</h3>
            </div>
            <p>
              Devices currently discovered on your local network. Tap a device to add its Nodic User ID or send a
              connection request directly.
            </p>

            {nearbyOnlinePeers.length === 0 ? (
              <div className="network-empty-box">
                No nearby Nodic devices detected right now. Make sure nearby teammates have Nodic open on the same Wi-Fi or hotspot.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '8px' }}>
                {nearbyOnlinePeers.map((peer) => {
                  const peerNodicId = formatNodicId(peer.deviceId);
                  const savedRecord = pairedDevices.find(
                    (d) => d.deviceId === peer.deviceId || d.nodicId === peerNodicId,
                  );
                  const isPaired = savedRecord?.pairingState === 'PAIRED';
                  const isPending = savedRecord?.pairingState === 'PENDING_OUTBOUND';
                  const isLocalDisc = savedRecord?.pairingState === 'DISCONNECTED_LOCAL';
                  const isSelectedForBatch = nodicIdsInput
                    .split(/[\s,;]+/)
                    .map((t) => t.trim().toLowerCase())
                    .includes(peerNodicId);

                  return (
                    <div key={peer.deviceId} className="pairing-device-row">
                      <div className="pairing-device-row__info">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                          <strong>{peer.displayName}</strong>
                          <code className="nodic-id-chip">{peerNodicId}</code>
                          <span className="device-status-pill is-nearby">● Nearby</span>
                          {isPaired && (
                            <span className="device-status-pill is-connected">Connected</span>
                          )}
                          {isPending && (
                            <span className="device-status-pill is-pending">Request Sent</span>
                          )}
                          {isLocalDisc && (
                            <span className="device-status-pill is-disconnected">
                              Disconnected Locally
                            </span>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {!isPaired && (
                          <>
                            <button
                              type="button"
                              className="dialog-btn-outline"
                              onClick={() => handleToggleSelectNearbyId(peerNodicId)}
                            >
                              {isSelectedForBatch ? 'Selected' : '+ Select ID'}
                            </button>
                            <button
                              type="button"
                              className="dialog-btn-primary"
                              disabled={isSendingRequest}
                              onClick={() => void handleQuickRequestPeer(peerNodicId)}
                            >
                              {isPending ? 'Resend Request' : 'Send Request'}
                            </button>
                          </>
                        )}
                        {isPaired && (
                          <button
                            type="button"
                            className="dialog-btn-outline"
                            onClick={() => void disconnectPeerLocally(peer.deviceId)}
                          >
                            Disconnect
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
