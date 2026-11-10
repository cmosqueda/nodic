import { useState, type FormEvent } from 'react';
import { useWorkspace } from '../../app/workspace-context';
import { Modal } from '../../shared/Modal';

/** Single join-with-code dialog used everywhere (previously duplicated in MembersPage). */
export function JoinChannelModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { identity, joinChannelWithCode } = useWorkspace();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setError(null);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await joinChannelWithCode(code.trim(), name.trim() || undefined);
    setBusy(false);
    if (result.success) {
      // Progress is shown by <PendingJoinCard/>; the dialog's job is done.
      setCode('');
      setName('');
      onClose();
    } else {
      setError(result.message);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={close} title="Join Channel">
      <form onSubmit={(e) => void submit(e)} className="join-form">
        <p className="join-hint">Paste the invite code from your channel lead. Nodic connects to them automatically.</p>
        <label>
          Your name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={identity?.displayName || 'e.g. Rocket Puncher'}
          />
        </label>
        <label>
          Invite code *
          <textarea
            rows={3}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="nodic:v1:..."
            className="join-code"
          />
        </label>
        {error && <div className="join-msg join-msg--error">{error}</div>}
        <div className="join-actions">
          <button type="button" className="dialog-btn-outline" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="dialog-btn-primary" disabled={!code.trim() || busy}>
            {busy ? 'Checking...' : 'Join'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Shows the state of a join request that the lead has not answered yet. */
export function PendingJoinCard() {
  const { pendingJoin, cancelPendingJoin, retryPendingJoin } = useWorkspace();
  if (!pendingJoin) return null;
  const failed = pendingJoin.status === 'REJECTED' || pendingJoin.status === 'TIMEOUT';
  const title =
    pendingJoin.status === 'CONNECTING'
      ? `Connecting to ${pendingJoin.leadName}...`
      : pendingJoin.status === 'WAITING'
        ? `Waiting for ${pendingJoin.leadName} to approve`
        : pendingJoin.status === 'REJECTED'
          ? 'Request declined'
          : 'No answer yet';
  return (
    <div className={`join-pending ${failed ? 'is-failed' : ''}`} role="status">
      <strong>
        {pendingJoin.channelName}: {title}
      </strong>
      <small>
        {pendingJoin.message ??
          'Nothing is added to your device until the lead approves your request.'}
      </small>
      <div className="join-actions">
        {pendingJoin.status === 'TIMEOUT' && (
          <button className="dialog-btn-primary" onClick={() => void retryPendingJoin()}>
            Try again
          </button>
        )}
        <button className="dialog-btn-outline" onClick={cancelPendingJoin}>
          {failed ? 'Dismiss' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
