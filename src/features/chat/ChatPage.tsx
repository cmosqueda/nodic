import { useState, type FormEvent } from 'react';
import { IonButton, IonContent, IonIcon, IonPage } from '@ionic/react';
import { arrowUpOutline } from 'ionicons/icons';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../app/workspace-context';
import { PageHeader } from '../../shared/PageHeader';

export function ChatPage() {
  const { channel, identity, messages, sendMessage } = useWorkspace();
  const [draft, setDraft] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!channel) return;
    void sendMessage(draft);
    setDraft('');
  }

  if (!channel) {
    return (
      <IonPage>
        <IonContent fullscreen>
          <div className="page-wrap narrow-page" style={{ textAlign: 'center', paddingTop: '40px' }}>
            <PageHeader
              eyebrow="Channel relay"
              title="Team conversation"
              detail={`You are connected as "${identity?.displayName ?? 'New User'}" (${identity?.shortId ?? 'nodic-node'}).`}
            />
            <div className="network-card" style={{ display: 'grid', gap: '16px', textAlign: 'center', placeItems: 'center', padding: '36px 20px', gridTemplateColumns: '1fr' }}>
              <p style={{ maxWidth: '420px', color: 'var(--nodic-muted)', margin: 0 }}>
                Join or create a department channel to start exchanging local peer-to-peer messages.
              </p>
              <Link to="/network">
                <IonButton className="primary-action">Open Configuration & Channels</IonButton>
              </Link>
            </div>
          </div>
        </IonContent>
      </IonPage>
    );
  }

  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="page-wrap narrow-page">
          <PageHeader
            eyebrow={`Channel relay · ${channel.name}`}
            title="Team conversation"
            detail="Messages remain on department devices and move peer to peer."
          />
          <section className="chat-stream" aria-label="Channel messages">
            {messages.map((message) => {
              const author = channel.members.find((member) => member.deviceId === message.authorDeviceId);
              const authorName = author?.displayName ?? (message.authorDeviceId === identity?.deviceId ? identity.displayName : 'Team Member');
              const initials = author?.initials ?? authorName.slice(0, 2).toUpperCase();

              if (message.kind === 'SYSTEM') return <div className="system-message" key={message.id}>{message.body}</div>;
              return (
                <article className={`chat-message ${message.pending ? 'is-pending' : ''}`} key={message.id}>
                  <span className="message-avatar">{initials}</span>
                  <div>
                    <header>
                      <strong>{authorName}</strong>
                      <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </header>
                    <p>{message.body}</p>
                    {message.pending && <small>Waiting for a nearby peer</small>}
                  </div>
                </article>
              );
            })}
          </section>
          <form className="message-composer" onSubmit={submit}>
            <label htmlFor="message">Message {channel.name}</label>
            <div>
              <input id="message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={4000} placeholder="Write an update…" />
              <button type="submit" disabled={!draft.trim()} aria-label="Send message">
                <IonIcon icon={arrowUpOutline} />
              </button>
            </div>
          </form>
        </div>
      </IonContent>
    </IonPage>
  );
}
