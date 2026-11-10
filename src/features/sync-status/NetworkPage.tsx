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
import { BusyButton, SkeletonRows, errorMessage, useFeedback } from '../../shared/feedback';

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

  const feedback = useFeedback();
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
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
    const ok = await feedback.run(() => updateDisplayName(usernameInput.trim()));
    if (!ok) return;
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
      feedback.error('Could not copy automatically. Select the ID and copy it manually.');
    }
  }

  async function startNetwork() {
    await feedback.run(async () => {
      const nextStatus = await nativeSync.start(
        identity?.displayName ?? 'Nodic',
        identity?.deviceId,
        identity?.publicSigningKey,
      );
      setStatus(nextStatus);
      await refreshNetworkDiagnostics();
    }, { error: "Couldn't start discovery. Check Wi-Fi is on and Nodic has network permission." });
  }

  async function stopNetwork() {
    await feedback.run(async () => {
      setStatus(await nativeSync.stop());
      await refreshNetworkDiagnostics();
    });
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
    } catch (err) {
      feedback.error(errorMessage(err, "Couldn't send the connection request."));
    } finally {
      setIsSendingRequest(false);
    }
  }

  async function respond(requestId: string, accept: boolean, name: string) {
    setRespondingId(requestId);
    await feedback.run(async () => {
      const { delivered } = await respondToPairingRequest(requestId, accept);
      if (!delivered) {
        feedback.info(`Saved, but ${name} couldn't be reached yet. It will finish when they are nearby.`);
      } else {
        feedback.success(accept ? `Connected to ${name}` : `Declined ${name}`);
      }
    });
    setRespondingId(null);
  }

  async function handleScan() {
    setScanning(true);
    await feedback.run(() => refreshNetworkDiagnostics(), { error: "Couldn't scan for nearby devices." });
    setScanning(false);
  }

  async function handleQuickRequestPeer(nodicId: string) {
    setIsSendingRequest(true);
    try {
      const results = await requestPairingByNodicIds([nodicId]);
      setPairingResults(results);
    } catch (err) {
      feedback.error(errorMessage(err, "Couldn't send the connection request."));
    } finally {
      setIsSendingRequest(false);
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

  // One merged list: everyone nearby, plus saved connections that are currently away.
  const people = [
    ...nearbyOnlinePeers.map((p) => ({
      deviceId: p.deviceId,
      name: p.displayName,
      nodicId: formatNodicId(p.deviceId),
      nearby: true,
    })),
    ...pairedDevices
      .filter(
        (d) =>
          d.pairingState === 'PAIRED' &&
          !nearbyOnlinePeers.some((p) => p.deviceId === d.deviceId),
      )
      .map((d) => ({ deviceId: d.deviceId, name: d.displayName, nodicId: d.nodicId, nearby: false })),
  ];

  const summaryLine =
    status?.state === 'STOPPED'
      ? 'Discovery is paused'
      : connectedNearbyCount > 0
        ? `Connected to ${connectedNearbyCount} ${connectedNearbyCount === 1 ? 'person' : 'people'}`
        : nearbyOnlinePeers.length > 0
          ? `${nearbyOnlinePeers.length} nearby, not connected yet`
          : 'Looking for people nearby...';

  return (
    <div className="screen-container">
      <div className="page-wrap narrow-page">
        <div className="channel-header-chip">
          <div>
            <strong>Network</strong>
            <small>{summaryLine}</small>
          </div>
          <BusyButton className="dialog-btn-outline" busy={scanning} busyLabel="Scanning" onClick={() => void handleScan()}>
            <IonIcon icon={refreshOutline} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            Scan
          </BusyButton>
        </div>

        <div className="network-hub-grid">
          <p className="network-tip">
            Tip: you usually don't need this page. Joining a channel with an invite code connects you to the
            lead automatically.
          </p>

          {/* 1. Requests that need an answer */}
          {pendingInboundRequests.length > 0 && (
            <div className="hub-card pairing-requests-card">
              <h3 style={{ margin: '0 0 8px' }}>
                <IonIcon icon={personAddOutline} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                Requests ({pendingInboundRequests.length})
              </h3>
              <div style={{ display: 'grid', gap: '8px' }}>
                {pendingInboundRequests.map((req) => (
                  <div key={req.requestId} className="pairing-device-row is-highlight">
                    <div className="pairing-device-row__info">
                      <strong>{req.fromDisplayName}</strong>
                      <code className="nodic-id-chip">{req.fromNodicId}</code>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <BusyButton
                        type="button"
                        className="dialog-btn-primary"
                        busy={respondingId === req.requestId}
                        busyLabel="Accepting"
                        disabled={respondingId !== null}
                        onClick={() => void respond(req.requestId, true, req.fromDisplayName)}
                      >
                        Accept
                      </BusyButton>
                      <button
                        type="button"
                        className="dialog-btn-outline"
                        disabled={respondingId !== null}
                        onClick={() => void respond(req.requestId, false, req.fromDisplayName)}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 2. People: one list, one action per person */}
          <div className="hub-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
              <IonIcon icon={radioOutline} style={{ fontSize: '18px', color: 'var(--nodic-signal)' }} />
              <h3 style={{ margin: 0 }}>People nearby</h3>
            </div>

            {people.length === 0 && status === null ? (
              <SkeletonRows count={2} />
            ) : people.length === 0 ? (
              <div className="network-empty-box">
                No one found yet. Ask teammates to open Nodic on the same Wi-Fi or hotspot.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '8px' }}>
                {people.map((person) => {
                  const saved = pairedDevices.find((d) => d.deviceId === person.deviceId);
                  const isConnected = saved?.pairingState === 'PAIRED' && person.nearby;
                  const isWaiting = saved?.pairingState === 'PENDING_OUTBOUND';
                  return (
                    <div key={person.deviceId} className="pairing-device-row">
                      <div className="pairing-device-row__info">
                        <strong>{person.name}</strong>
                        <small className="network-person-state">
                          {isConnected
                            ? 'Connected'
                            : saved?.pairingState === 'PAIRED'
                              ? 'Saved - not nearby'
                              : isWaiting
                                ? 'Waiting for them to accept'
                                : person.nodicId}
                        </small>
                      </div>
                      {isConnected ? (
                        <button
                          type="button"
                          className="dialog-btn-outline"
                          onClick={() => void feedback.run(() => disconnectPeerLocally(person.deviceId), { success: `Disconnected from ${person.name}` })}
                        >
                          <IonIcon icon={unlinkOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                          Disconnect
                        </button>
                      ) : saved?.pairingState === 'PAIRED' ? null : (
                        <button
                          type="button"
                          className="dialog-btn-primary"
                          disabled={!person.nearby || isSendingRequest}
                          onClick={() => void handleQuickRequestPeer(person.nodicId)}
                        >
                          <IonIcon icon={linkOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                          {isWaiting ? 'Resend' : 'Connect'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {pairingResults.length > 0 && (
              <div style={{ display: 'grid', gap: '6px', marginTop: '12px' }}>
                {pairingResults.map((res, idx) => {
                  const isSuccess = res.status === 'REQUEST_SENT' || res.status === 'ALREADY_PAIRED';
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

          {/* 3. Me */}
          <div className="hub-card">
            <h3 style={{ margin: '0 0 8px' }}>You</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <code className="nodic-id-badge">{identity?.shortId ?? 'nodic-node'}</code>
              <button type="button" className="task-move-chip" onClick={() => void handleCopyNodicId()}>
                <IonIcon icon={copyOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                {copiedId ? 'Copied!' : 'Copy ID'}
              </button>
            </div>
            <form
              onSubmit={(e) => void handleSaveUsername(e)}
              style={{ display: 'flex', gap: '8px', marginTop: '12px' }}
            >
              <input
                id="username-input"
                type="text"
                required
                aria-label="Display name"
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                placeholder="Your name"
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--nodic-line)',
                  background: 'white',
                }}
              />
              <button
                type="submit"
                className="dialog-btn-primary"
                disabled={!usernameInput.trim() || usernameInput === identity?.displayName}
              >
                Save
              </button>
            </form>
            {savedNameNotice && (
              <div className="network-saved-note">
                <IonIcon icon={checkmarkCircleOutline} /> Name updated
              </div>
            )}
          </div>

          {/* 4. Everything else, out of the way */}
          <details className="hub-card network-advanced">
            <summary>Advanced</summary>
            <p>Connect to a specific device by its Nodic ID (comma separated for several).</p>
            <form
              onSubmit={(e) => void handleSendPairingRequests(e)}
              style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}
            >
              <input
                type="text"
                aria-label="Nodic IDs"
                value={nodicIdsInput}
                onChange={(e) => setNodicIdsInput(e.target.value)}
                placeholder="nodic-a1b2c3d4"
                style={{
                  flex: '1 1 200px',
                  padding: '9px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--nodic-line)',
                  background: 'white',
                  fontFamily: 'monospace',
                }}
              />
              <button
                type="submit"
                className="dialog-btn-primary"
                disabled={!nodicIdsInput.trim() || isSendingRequest}
              >
                {isSendingRequest ? 'Sending...' : 'Connect'}
              </button>
            </form>
            <div style={{ marginTop: '12px' }}>
              {status?.state === 'STOPPED' ? (
                <button className="dialog-btn-primary" onClick={() => void startNetwork()}>
                  Resume discovery
                </button>
              ) : (
                <button className="dialog-btn-outline" onClick={() => void stopNetwork()}>
                  Pause discovery
                </button>
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
