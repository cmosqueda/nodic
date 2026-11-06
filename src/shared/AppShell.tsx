import { useState, type PropsWithChildren, type FormEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { chatbubbleEllipsesOutline, peopleOutline, pulseOutline, gridOutline } from 'ionicons/icons';
import { IonIcon } from '@ionic/react';
import { useWorkspace } from '../app/workspace-context';
import { Modal } from './Modal';

const navItems = [
  { to: '/board', label: 'Board', icon: gridOutline },
  { to: '/chat', label: 'Chat', icon: chatbubbleEllipsesOutline },
  { to: '/members', label: 'Members', icon: peopleOutline },
];

export function AppShell({ children }: PropsWithChildren) {
  const {
    channel,
    channels,
    identity,
    updateDisplayName,
    createChannel,
    switchChannel,
  } = useWorkspace();

  const current = channel?.members.find((member) => member.deviceId === channel.currentUserDeviceId) ?? {
    deviceId: identity?.deviceId ?? channel?.currentUserDeviceId ?? 'local-device',
    displayName: identity?.displayName ?? 'You',
    initials: identity?.displayName ? identity.displayName.slice(0, 2).toUpperCase() : 'ME',
    role: 'MEMBER' as const,
    presence: 'ONLINE' as const,
  };

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelDesc, setNewChannelDesc] = useState('');
  const location = useLocation();
  const isChatPage = location.pathname === '/chat';

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

  async function handleCreateChannelSubmit(e: FormEvent) {
    e.preventDefault();
    if (!newChannelName.trim()) return;
    await createChannel(newChannelName.trim(), newChannelDesc.trim() || undefined);
    setNewChannelName('');
    setNewChannelDesc('');
    setShowCreateModal(false);
    setDrawerOpen(false);
  }

  return (
    <div className="app-shell">
      {/* Top App Bar with Hamburger, Title, and Profile */}
      <header className="mobile-top-bar">
        <button
          className="drawer-hamburger-btn"
          onClick={() => setDrawerOpen((prev) => !prev)}
          aria-label="Open Channels Menu"
          title="Open Channels Drawer"
        >
          <span></span>
          <span></span>
          <span></span>
        </button>

        <span className="mobile-top-title">
          {channel ? channel.name : 'nodic'}
        </span>

        <button
          className="mobile-profile-btn"
          onClick={handleOpenProfile}
          title="Device Profile"
        >
          <span className="avatar-dot">{current.initials}</span>
          <span>{current.displayName}</span>
        </button>
      </header>

      {/* Drawer Overlay */}
      <div
        className={`drawer-overlay ${drawerOpen ? 'is-open' : ''}`}
        onClick={() => setDrawerOpen(false)}
      />

      {/* Drawer Side Panel */}
      <aside className={`channels-drawer ${drawerOpen ? 'is-open' : ''}`}>
        <div className="drawer-header">
          <h3>Channels</h3>
          <button
            className="create-channel-btn"
            onClick={() => {
              setDrawerOpen(false);
              setShowCreateModal(true);
            }}
            title="Create New Channel"
          >
            +
          </button>
        </div>

        <div className="drawer-channel-list">
          {channels.length === 0 ? (
            <div style={{ padding: '24px 8px', color: '#9db4bd', fontSize: '13px', textAlign: 'center', lineHeight: 1.5 }}>
              You have no channels yet.<br />Tap <strong>+</strong> above to create one.
            </div>
          ) : (
            channels.map((ch) => {
              const isActive = channel?.id === ch.id;
              return (
                <button
                  key={ch.id}
                  className={`drawer-channel-btn ${isActive ? 'is-active' : ''}`}
                  onClick={() => {
                    void switchChannel(ch.id);
                    setDrawerOpen(false);
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {ch.name}
                  </span>
                  {isActive && <span className="active-dot" />}
                </button>
              );
            })
          )}
        </div>

        <hr className="drawer-divider" />

        <NavLink
          to="/network"
          className="drawer-network-btn"
          onClick={() => setDrawerOpen(false)}
        >
          <IonIcon icon={pulseOutline} />
          <span>Network Configuration</span>
        </NavLink>
      </aside>

      {/* Side Rail for wide desktop environments */}
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
          <NavLink to="/network" className={({ isActive }) => isActive ? 'is-active' : undefined}>
            <IonIcon icon={pulseOutline} aria-hidden="true" />
            <span>Network</span>
          </NavLink>
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

      {/* Main Screen Content */}
      <main className={`main-stage ${isChatPage ? 'is-chat-stage' : ''}`}>{children}</main>

      {/* Mobile/Tablet Bottom Navigation Bar (Board | Chat | Members) */}
      <nav className="mobile-nav" aria-label="Primary navigation">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => isActive ? 'is-active' : undefined}>
            <IonIcon icon={item.icon} aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      {/* Create Channel Modal (Pure React Modal) */}
      <Modal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        title="Create Channel"
      >
        <form
          onSubmit={(e) => void handleCreateChannelSubmit(e)}
          style={{ display: 'grid', gap: '14px' }}
        >
          <p style={{ color: 'var(--nodic-muted)', fontSize: '13px', margin: '0 0 6px' }}>
            Create a collaboration workspace as Team Lead. You can invite other teammates on your local Wi-Fi.
          </p>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Channel Name *</label>
            <input
              type="text"
              required
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              placeholder="e.g. Greenfield Dept."
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Description (Optional)</label>
            <input
              type="text"
              value={newChannelDesc}
              onChange={(e) => setNewChannelDesc(e.target.value)}
              placeholder="e.g. Field operations"
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button type="button" className="dialog-btn-outline" onClick={() => setShowCreateModal(false)}>
              Cancel
            </button>
            <button type="submit" className="dialog-btn-primary" disabled={!newChannelName.trim()}>
              Create
            </button>
          </div>
        </form>
      </Modal>

      {/* Profile Edit Modal (Pure React Modal) */}
      <Modal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        title="Device Profile"
      >
        <form onSubmit={(e) => void handleSaveProfile(e)} style={{ display: 'grid', gap: '14px' }}>
          <p style={{ color: 'var(--nodic-muted)', fontSize: '13px', margin: '0 0 6px' }}>
            Configure your device identity and name visible across the local network.
          </p>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Nodic Identifier</label>
            <input
              type="text"
              readOnly
              disabled
              value={identity?.shortId || 'nodic-device'}
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: '#f5f5f5', fontFamily: 'monospace' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Your Name</label>
            <input
              type="text"
              required
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="e.g. Rocket Puncher"
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '8px' }}>
            <button type="button" className="dialog-btn-outline" onClick={() => setShowProfileModal(false)}>
              Cancel
            </button>
            <button type="submit" className="dialog-btn-primary" disabled={!nameDraft.trim()}>
              Save Name
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}