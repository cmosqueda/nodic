import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../app/workspace-context';
import { Modal } from '../../shared/Modal';
import { BusyButton, useFeedback } from '../../shared/feedback';

/** Lead-only: people who entered an invite code and are waiting for a decision. */
export function JoinRequestsCard({ channelId }: { channelId: string }) {
  const { joinRequests, approveJoinRequest, declineJoinRequest } = useWorkspace();
  const feedback = useFeedback();
  const [busy, setBusy] = useState<Record<string, 'approve' | 'decline' | undefined>>({});
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  const requests = joinRequests.filter((r) => r.channelId === channelId);
  if (requests.length === 0) return null;

  async function act(id: string, name: string, kind: 'approve' | 'decline') {
    setBusy((b) => ({ ...b, [id]: kind }));
    const ok = await feedback.run(
      () => (kind === 'approve' ? approveJoinRequest(id) : declineJoinRequest(id)),
      { success: kind === 'approve' ? `${name} joined the channel` : `Declined ${name}` },
    );
    setBusy((b) => ({ ...b, [id]: undefined }));
    if (ok) {
      setLeaving((s) => new Set(s).add(id));
      setTimeout(() => setLeaving((s) => { const n = new Set(s); n.delete(id); return n; }), 200);
    }
  }

  return (
    <section className="hub-card jr-card" aria-label="Join requests">
      <h3 style={{ margin: 0 }}>
        Join requests <span className="jr-badge">{requests.length}</span>
      </h3>
      <p className="invite-note">These people entered your invite code. Approve only people you know.</p>
      <div>
        {requests.map((r) => (
          <div key={r.requestId} className={`jr-row ${leaving.has(r.requestId) ? 'nd-leave' : 'nd-enter'}`}>
            <div className="member-avatar">{r.applicantDisplayName.slice(0, 2).toUpperCase()}</div>
            <div className="jr-row__info">
              <strong>{r.applicantDisplayName}</strong>
              <small>{r.applicantNodicId}</small>
            </div>
            <div className="jr-row__actions">
              <BusyButton
                className="dialog-btn-primary"
                busy={busy[r.requestId] === 'approve'}
                busyLabel="Approving"
                disabled={Boolean(busy[r.requestId])}
                onClick={() => void act(r.requestId, r.applicantDisplayName, 'approve')}
              >
                Approve
              </BusyButton>
              <BusyButton
                className="dialog-btn-outline"
                busy={busy[r.requestId] === 'decline'}
                busyLabel="Declining"
                disabled={Boolean(busy[r.requestId])}
                onClick={() => void act(r.requestId, r.applicantDisplayName, 'decline')}
              >
                Decline
              </BusyButton>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Invitations other leads sent straight to this device. */
export function IncomingInvitesCard() {
  const { incomingInvites, acceptIncomingInvite, dismissIncomingInvite } = useWorkspace();
  const feedback = useFeedback();
  const [busyId, setBusyId] = useState<string | null>(null);

  if (incomingInvites.length === 0) return null;

  async function accept(id: string) {
    setBusyId(id);
    const ok = await feedback.run(async () => {
      const res = await acceptIncomingInvite(id);
      if (!res.success) throw new Error(res.message);
    });
    setBusyId(null);
    if (ok) feedback.info('Request sent. Waiting for the lead to confirm...');
  }

  return (
    <section className="hub-card jr-card" aria-label="Invitations">
      <h3 style={{ margin: 0 }}>
        Invitations <span className="jr-badge">{incomingInvites.length}</span>
      </h3>
      <div>
        {incomingInvites.map((inv) => (
          <div key={inv.id} className="jr-row nd-enter">
            <div className="member-avatar">{inv.channelName.slice(0, 2).toUpperCase()}</div>
            <div className="jr-row__info">
              <strong>{inv.channelName}</strong>
              <small>Invited by {inv.leadName}</small>
            </div>
            <div className="jr-row__actions">
              <BusyButton
                className="dialog-btn-primary"
                busy={busyId === inv.id}
                busyLabel="Joining"
                disabled={busyId !== null}
                onClick={() => void accept(inv.id)}
              >
                Join
              </BusyButton>
              <button
                className="dialog-btn-outline"
                disabled={busyId !== null}
                onClick={() => dismissIncomingInvite(inv.id)}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Lead-only: invite someone directly. Only people who are connected to this device AND currently
 * visible nearby on the same network can be invited.
 */
export function InviteNearbyModal({
  isOpen,
  onClose,
  onShareCode,
}: {
  isOpen: boolean;
  onClose: () => void;
  onShareCode: () => void;
}) {
  const { channel, pairedDevices, peerIdentities, inviteNearbyPeer, refreshNetworkDiagnostics } = useWorkspace();
  const feedback = useFeedback();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);

  const memberIds = new Set(channel?.members.map((m) => m.deviceId) ?? []);
  const eligible = pairedDevices
    .filter((d) => d.pairingState === 'PAIRED' && !memberIds.has(d.deviceId))
    .map((d) => ({
      device: d,
      nearby: peerIdentities.some((p) => p.deviceId === d.deviceId && p.status === 'ONLINE'),
    }));

  async function invite(deviceId: string, name: string) {
    setBusyId(deviceId);
    const ok = await feedback.run(() => inviteNearbyPeer(deviceId), { success: `Invitation sent to ${name}` });
    setBusyId(null);
    if (ok) setSent((s) => new Set(s).add(deviceId));
  }

  async function scan() {
    setScanning(true);
    await feedback.run(() => refreshNetworkDiagnostics(), { error: "Couldn't scan for nearby devices." });
    setScanning(false);
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Invite people">
      <div className="join-form">
        <p className="join-hint">
          You can invite people who are connected to you and nearby on the same Wi-Fi.
        </p>

        {eligible.length === 0 ? (
          <div className="network-empty-box">
            No connected people to invite yet. Connect to a teammate first on the{' '}
            <Link to="/network" onClick={onClose}>Network</Link> page, or share a code instead.
          </div>
        ) : (
          <div>
            {eligible.map(({ device, nearby }) => (
              <div key={device.deviceId} className="jr-row">
                <div className="member-avatar">{device.displayName.slice(0, 2).toUpperCase()}</div>
                <div className="jr-row__info">
                  <strong>{device.displayName}</strong>
                  <small>{nearby ? 'Nearby - connected' : 'Not nearby right now'}</small>
                </div>
                {sent.has(device.deviceId) ? (
                  <span className="jr-badge">Invited</span>
                ) : (
                  <BusyButton
                    className="dialog-btn-primary"
                    busy={busyId === device.deviceId}
                    busyLabel="Sending"
                    disabled={!nearby || busyId !== null}
                    title={nearby ? 'Send invitation' : 'They must be nearby on the same network'}
                    onClick={() => void invite(device.deviceId, device.displayName)}
                  >
                    Invite
                  </BusyButton>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="join-actions" style={{ justifyContent: 'space-between' }}>
          <BusyButton className="dialog-btn-outline" busy={scanning} busyLabel="Scanning" onClick={() => void scan()}>
            Scan again
          </BusyButton>
          <button className="dialog-btn-outline" onClick={onShareCode}>
            Share a code instead
          </button>
        </div>
      </div>
    </Modal>
  );
}
