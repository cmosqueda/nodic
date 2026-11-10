import { useFeedback } from '../../shared/feedback';
import { useState, useRef, useEffect, type FormEvent } from 'react';
import { IonIcon } from '@ionic/react';
import { sendOutline } from 'ionicons/icons';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../app/workspace-context';

export function ChatPage() {
  const { channel, identity, messages, sendMessage } = useWorkspace();
  const feedback = useFeedback();
  const [draft, setDraft] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!channel || !draft.trim()) return;
    const text = draft.trim();
    setDraft('');
    // Put the text back if sending failed so nothing the user typed is lost.
    void feedback.run(() => sendMessage(text), { error: "Message wasn't sent. Please try again." }).then((ok) => {
      if (!ok) setDraft((d) => d || text);
    });
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
            <Link to="/network">
              <button className="dialog-btn-primary">
                Open Network Configuration & Join
              </button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const peerCount = channel.members.filter((m) => m.presence === 'ONLINE').length;

  return (
    <div className="screen-container chat-page-screen">
      <div className="page-wrap narrow-page chat-page-wrap">
        {/* Header Chip matching wireframe prototype */}
        <div className="channel-header-chip">
          <div>
            <strong>{channel.name}</strong>
            <small>LAN Mesh Chat</small>
          </div>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#16a34a' }}>
            ● {peerCount} Online
          </span>
        </div>

        {/* Conventional Chat Message Stream */}
        <div className="conventional-chat-container">
          <div className="chat-messages-scroll" aria-label="Conversation Messages">
            {messages.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--nodic-muted)', margin: 'auto 0', fontSize: '13px' }}>
                No messages yet. Send a message to start communicating with peers!
              </div>
            ) : (
              messages.map((message) => {
                if (message.kind === 'SYSTEM') {
                  return (
                    <div className="chat-bubble-row is-system" key={message.id}>
                      <div className="chat-bubble">{message.body}</div>
                    </div>
                  );
                }

                const isMine =
                  message.authorDeviceId === identity?.deviceId ||
                  message.authorDeviceId === channel.currentUserDeviceId;
                const author = channel.members.find((m) => m.deviceId === message.authorDeviceId);
                const authorName = author?.displayName ?? (isMine ? 'You' : 'Peer');
                const time = new Date(message.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                });

                return (
                  <div
                    className={`chat-bubble-row ${isMine ? 'is-mine' : 'is-peer'}`}
                    key={message.id}
                  >
                    <div className="chat-bubble">
                      {!isMine && <span className="chat-author-name">{authorName}</span>}
                      <div>{message.body}</div>
                      <span className="chat-time-tag">
                        {time} {message.pending && '· sending…'}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Pinned Conventional Composer Bar */}
          <form className="chat-composer-wrap" onSubmit={submit}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={4000}
              placeholder={`Message ${channel.name}…`}
            />
            <button
              type="submit"
              className="chat-send-btn"
              disabled={!draft.trim()}
              aria-label="Send Message"
            >
              <IonIcon icon={sendOutline} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}