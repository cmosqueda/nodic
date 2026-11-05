import { useState, type PropsWithChildren, type FormEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { chatbubbleEllipsesOutline, peopleOutline, pulseOutline, gridOutline, personCircleOutline, closeOutline } from 'ionicons/icons';
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonModal, IonPage, IonTitle, IonToolbar } from '@ionic/react';
import { useWorkspace } from '../app/workspace-context';

const navItems = [
  { to: '/board', label: 'Board', icon: gridOutline },
  { to: '/chat', label: 'Chat', icon: chatbubbleEllipsesOutline },
  { to: '/members', label: 'Members', icon: peopleOutline },
  { to: '/network', label: 'Network', icon: pulseOutline },
];

export function AppShell({ children }: PropsWithChildren) {
  const { channel, identity, updateDisplayName } = useWorkspace();
  const current = channel?.members.find((member) => member.deviceId === channel.currentUserDeviceId) ?? {
    deviceId: identity?.deviceId ?? channel?.currentUserDeviceId ?? 'local-device',
    displayName: identity?.displayName ?? 'You',
    initials: identity?.displayName ? identity.displayName.slice(0, 2).toUpperCase() : 'ME',
    role: 'MEMBER' as const,
    presence: 'ONLINE' as const,
  };

  const [showProfileModal, setShowProfileModal] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  function handleOpenProfile() {
    setNameDraft(current.displayName);
    setShowProfileModal(true);
  }

  async function handleSaveProfile(e: FormEvent) {
    e.preventDefault();
    if (!nameDraft.trim()) return;
    await updateDisplayName(nameDraft.trim());
    setShowProfileModal(false);
  }

  return (
    <div className="app-shell">
      <header className="mobile-top-bar">
        <div className="brand-mark" aria-label="Nodic">
          <span className="brand-node brand-node--one" />
          <span className="brand-node brand-node--two" />
          <span className="brand-link" />
          <strong>nodic</strong>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            onClick={handleOpenProfile}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '4px 10px',
              borderRadius: '16px',
              background: 'rgba(255, 255, 255, 0.12)',
              color: '#fff',
              border: 0,
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <span style={{ width: '18px', height: '18px', borderRadius: '50%', background: 'var(--nodic-current)', color: 'var(--nodic-ink)', display: 'grid', placeItems: 'center', fontSize: '9px', fontWeight: 700 }}>
              {current.initials}
            </span>
            <span>{current.displayName}</span>
          </button>

          <NavLink to="/network" className="mobile-network-pill">
            <IonIcon icon={pulseOutline} />
            <span>Network</span>
          </NavLink>
        </div>
      </header>

      <aside className="side-rail" aria-label="Primary navigation">
        <div className="brand-mark" aria-label="Nodic">
          <span className="brand-node brand-node--one" />
          <span className="brand-node brand-node--two" />
          <span className="brand-link" />
          <strong>nodic</strong>
        </div>

        {channel ? (
          <div className="channel-chip">
            <span className="channel-monogram">{channel.name.slice(0, 2).toUpperCase()}</span>
            <span><small>Channel</small>{channel.name}</span>
          </div>
        ) : (
          <div className="channel-chip">
            <span className="channel-monogram">--</span>
            <span><small>Channel</small>No Active Channel</span>
          </div>
        )}

        <nav className="primary-nav">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? 'is-active' : undefined}>
              <IonIcon icon={item.icon} aria-hidden="true" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        {channel && (
          <div className="signal-rail" aria-label="Peers connected">
            <span className="signal-label">Local mesh</span>
            <div className="signal-track">
              {channel.members.slice(0, 4).map((member, index) => (
                <span
                  key={member.deviceId}
                  className={`signal-node signal-node--${member.presence.toLowerCase()}`}
                  style={{ '--node-index': index } as React.CSSProperties}
                  title={`${member.displayName}: ${member.presence.toLowerCase()}`}
                >
                  {member.initials}
                </span>
              ))}
            </div>
            <span className="signal-caption">{channel.members.length} member(s)</span>
          </div>
        )}

        <div
          className="current-user"
          onClick={handleOpenProfile}
          style={{ cursor: 'pointer' }}
          title="Click to edit your display name"
        >
          <span>{current.initials}</span>
          <div>
            <strong>{current.displayName}</strong>
            <small>{channel ? (current.role === 'LEAD' ? 'Team lead' : current.role === 'CO_LEAD' ? 'Co-lead' : 'Member') : 'Device Ready'}</small>
          </div>
        </div>
      </aside>

      <main className="main-stage">{children}</main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? 'is-active' : undefined}>
            <IonIcon icon={item.icon} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Profile Edit Modal */}
      <IonModal isOpen={showProfileModal} onDidDismiss={() => setShowProfileModal(false)}>
        <IonHeader>
          <IonToolbar>
            <IonTitle>Device Profile</IonTitle>
            <IonButtons slot="end">
              <IonButton onClick={() => setShowProfileModal(false)}>
                <IonIcon icon={closeOutline} />
              </IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <IonContent className="ion-padding">
          <form onSubmit={(e) => void handleSaveProfile(e)} style={{ maxWidth: '400px', margin: '0 auto', paddingTop: '16px', display: 'grid', gap: '14px' }}>
            <p style={{ color: 'var(--nodic-muted)' }}>
              Set your display name visible to other nodes on this local network.
            </p>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Your Name</label>
              <input
                type="text"
                required
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="e.g. Alex"
                style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
              <IonButton fill="outline" onClick={() => setShowProfileModal(false)}>Cancel</IonButton>
              <IonButton type="submit" disabled={!nameDraft.trim()}>Save Name</IonButton>
            </div>
          </form>
        </IonContent>
      </IonModal>
    </div>
  );
}
