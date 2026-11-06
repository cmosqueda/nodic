import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import type {
  MemberRole,
  NodicEvent,
  PeerIdentity,
  PeerSession,
  SyncLog,
  TaskPriority,
  TaskStatus,
} from '../../protocol/contracts';
import type { ChannelSummary, WorkspaceSnapshot } from '../domain/models';
import { canChangeTaskStatus } from '../domain/permissions/permissions';
import {
  createInvitationPayload,
  encodeInvitationCode,
  parseInvitationCode,
} from '../domain/invitations/invitation-codec';
import { repository } from '../db/repository';
import { nativeSync } from '../services/native-sync';

interface CreateTaskInput {
  title: string;
  description?: string;
  priority: TaskPriority;
  assigneeDeviceId?: string;
  dueAt?: string;
}

export interface UserIdentity {
  deviceId: string;
  displayName: string;
  shortId: string;
  publicSigningKey: string;
  keystoreAlias: string;
  lamportClock: number;
}

interface WorkspaceActions {
  createTask(input: CreateTaskInput): Promise<void>;
  moveTask(taskId: string, status: TaskStatus): Promise<void>;
  sendMessage(body: string): Promise<void>;
  createInvitation(expiresInHours?: number): Promise<string>;
  joinChannelWithCode(
    code: string,
    displayName?: string,
  ): Promise<{ success: boolean; message: string }>;
  updateMemberRole(deviceId: string, role: MemberRole): Promise<void>;
  removeMember(deviceId: string): Promise<void>;
  updateDisplayName(name: string): Promise<void>;
  createChannel(
    name: string,
    description?: string,
    broadcastToLAN?: boolean,
  ): Promise<void>;
  switchChannel(channelId: string): Promise<void>;
  leaveChannel(): Promise<void>;
  resetDatabase(): Promise<void>;
  connectToPeer(host: string, port: number): Promise<boolean>;
  refreshNetworkDiagnostics(): Promise<void>;
  clearSyncLogs(): Promise<void>;
  isReady: boolean;
  identity: UserIdentity | null;
  channels: ChannelSummary[];
  peerIdentities: PeerIdentity[];
  peerSessions: PeerSession[];
  syncLogs: SyncLog[];
}

type WorkspaceContextValue = WorkspaceSnapshot & WorkspaceActions;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const emptyWorkspace: WorkspaceSnapshot = {
  channel: null,
  tasks: [],
  messages: [],
};

export function WorkspaceProvider({ children }: PropsWithChildren) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptyWorkspace);
  const [identity, setIdentity] = useState<UserIdentity | null>(null);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [peerIdentities, setPeerIdentities] = useState<PeerIdentity[]>([]);
  const [peerSessions, setPeerSessions] = useState<PeerSession[]>([]);
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [isReady, setIsReady] = useState(false);

  const syncIdentityState = async () => {
    const idRecord = await repository.getIdentity();
    setIdentity({
      deviceId: idRecord.deviceId,
      displayName: idRecord.displayName,
      shortId: `nodic-${idRecord.deviceId.slice(0, 8)}`,
      publicSigningKey: idRecord.publicSigningKey,
      keystoreAlias: idRecord.keystoreAlias,
      lamportClock: idRecord.lamportClock,
    });
  };

  const refreshChannels = async () => {
    try {
      const list = await repository.listChannels();
      setChannels(list);
    } catch (err) {
      console.warn('Failed to refresh channels list:', err);
    }
  };

  const refreshDiagnosticsState = async () => {
    try {
      const { peerIdentities: peers, peerSessions: sessions, syncLogs: logs } =
        await repository.syncNativeDiagnostics();
      setPeerIdentities(peers);
      setPeerSessions(sessions);
      setSyncLogs(logs);
    } catch (err) {
      console.warn('Failed to refresh diagnostics state:', err);
    }
  };

  useEffect(() => {
    let unmounted = false;

    async function init() {
      try {
        const snapshot = await repository.init();
        const idRecord = await repository.getIdentity();
        const [chanList, peers, sessions, logs] = await Promise.all([
          repository.listChannels(),
          repository.listPeerIdentities(),
          repository.listPeerSessions(),
          repository.listSyncLogs(),
        ]);
        if (!unmounted) {
          setIdentity({
            deviceId: idRecord.deviceId,
            displayName: idRecord.displayName,
            shortId: `nodic-${idRecord.deviceId.slice(0, 8)}`,
            publicSigningKey: idRecord.publicSigningKey,
            keystoreAlias: idRecord.keystoreAlias,
            lamportClock: idRecord.lamportClock,
          });
          setWorkspace(snapshot);
          setChannels(chanList);
          setPeerIdentities(peers);
          setPeerSessions(sessions);
          setSyncLogs(logs);
          setIsReady(true);
        }
      } catch (err) {
        console.error('Failed to init workspace repository:', err);
        if (!unmounted) setIsReady(true);
      }
    }

    void init();

    if (nativeSync.isNative()) {
      const eventListener = nativeSync.plugin.addListener('eventReceived', (data) => {
        try {
          const event = JSON.parse(data.eventJson) as NodicEvent;
          void repository.applyEvent(event).then(async (updated) => {
            if (unmounted) return;
            setWorkspace(updated);
            await syncIdentityState();
            await refreshChannels();
            const logs = await repository.listSyncLogs();
            if (!unmounted) setSyncLogs(logs);

            // When a remote member joins our channel, send them all existing events for that channel
            if (event.type === 'MEMBER_ADDED') {
              const allEvents = await repository.getAllChannelEvents(event.channelId);
              if (allEvents.length > 0) {
                void nativeSync.publishBatch(allEvents);
              }
            }
          });
        } catch (error) {
          console.warn('Failed to process incoming peer event:', error);
        }
      });

      const statusListener = nativeSync.plugin.addListener('statusChanged', (status) => {
        if (status.state === 'CONNECTED' && status.peerCount > 0 && workspace.channel?.id) {
          void repository.getAllChannelEvents(workspace.channel.id).then((events) => {
            if (events.length > 0) {
              void nativeSync.publishBatch(events);
            }
          });
        }
      });

      const peerIdentityListener = nativeSync.plugin.addListener(
        'peerIdentityUpdated',
        (peer) => {
          void repository.savePeerIdentity(peer).then(async () => {
            if (unmounted) return;
            const peers = await repository.listPeerIdentities();
            if (!unmounted) setPeerIdentities(peers);
          });
        },
      );

      const peerSessionListener = nativeSync.plugin.addListener(
        'peerSessionUpdated',
        (session) => {
          void repository.savePeerSession(session).then(async () => {
            if (unmounted) return;
            const sessions = await repository.listPeerSessions();
            if (!unmounted) setPeerSessions(sessions);
          });
        },
      );

      const syncLogListener = nativeSync.plugin.addListener('syncLogAdded', (log) => {
        void repository.recordSyncLog(log).then(async () => {
          if (unmounted) return;
          const logs = await repository.listSyncLogs();
          if (!unmounted) setSyncLogs(logs);
        });
      });

      return () => {
        unmounted = true;
        void eventListener.then((h) => h.remove());
        void statusListener.then((h) => h.remove());
        void peerIdentityListener.then((h) => h.remove());
        void peerSessionListener.then((h) => h.remove());
        void syncLogListener.then((h) => h.remove());
      };
    }

    return () => {
      unmounted = true;
    };
  }, [workspace.channel?.id]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      ...workspace,
      identity,
      isReady,
      channels,
      peerIdentities,
      peerSessions,
      syncLogs,

      async updateDisplayName(name) {
        const clean = name.trim();
        if (!clean) return;

        const updated = await repository.updateDisplayName(clean);
        setIdentity({
          deviceId: updated.deviceId,
          displayName: updated.displayName,
          shortId: `nodic-${updated.deviceId.slice(0, 8)}`,
          publicSigningKey: updated.publicSigningKey,
          keystoreAlias: updated.keystoreAlias,
          lamportClock: updated.lamportClock,
        });

        if (workspace.channel) {
          const currentUserRole =
            workspace.channel.members.find((m) => m.deviceId === updated.deviceId)?.role ??
            'MEMBER';
          const { event, snapshot } = await repository.commitLocalEvent(
            workspace.channel.id,
            'MEMBER_ADDED',
            {
              deviceId: updated.deviceId,
              displayName: clean,
              role: currentUserRole,
              publicKey: updated.publicSigningKey,
            },
            updated.deviceId,
          );
          setWorkspace(snapshot);
          await syncIdentityState();
          void nativeSync.publishEvent(event);
        }
        await refreshDiagnosticsState();
      },

      async createChannel(name, description, broadcastToLAN = true) {
        const cleanName = name.trim();
        if (!cleanName) return;

        const { snapshot, genesisEvent } = await repository.createChannel(
          cleanName,
          description,
        );
        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshChannels();
        await refreshDiagnosticsState();

        if (broadcastToLAN) {
          void nativeSync.publishEvent(genesisEvent);
        }
      },

      async switchChannel(channelId: string) {
        const snapshot = await repository.switchChannel(channelId);
        setWorkspace(snapshot);
        await refreshChannels();
      },

      async leaveChannel() {
        const snapshot = await repository.leaveChannel();
        setWorkspace(snapshot);
        await refreshChannels();
      },

      async resetDatabase() {
        const snapshot = await repository.resetDatabase();
        await syncIdentityState();
        setWorkspace(snapshot);
        setChannels([]);
        setPeerIdentities([]);
        setPeerSessions([]);
        setSyncLogs([]);
      },

      async connectToPeer(host: string, port: number) {
        const res = await repository.connectToPeer(host, port);
        await refreshDiagnosticsState();
        if (res.connected && workspace.channel?.id) {
          const events = await repository.getAllChannelEvents(workspace.channel.id);
          if (events.length > 0) {
            void nativeSync.publishBatch(events);
          }
        }
        return res.connected;
      },

      async refreshNetworkDiagnostics() {
        await refreshDiagnosticsState();
      },

      async clearSyncLogs() {
        await repository.clearSyncLogs();
        setSyncLogs([]);
      },

      async createTask(input) {
        if (!workspace.channel) return;
        const taskId = crypto.randomUUID();
        const { event, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'TASK_CREATED',
          {
            id: taskId,
            title: input.title,
            description: input.description,
            status: 'TODO',
            priority: input.priority,
            assigneeDeviceId: input.assigneeDeviceId,
            dueAt: input.dueAt,
          },
          taskId,
        );

        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event);
      },

      async moveTask(taskId, status) {
        if (!workspace.channel) return;
        const currentTask = workspace.tasks.find((t) => t.id === taskId);
        const currentUser = workspace.channel.members.find(
          (m) => m.deviceId === workspace.channel?.currentUserDeviceId,
        );

        if (currentTask && currentUser) {
          const allowed = canChangeTaskStatus({
            role: currentUser.role,
            actorDeviceId: currentUser.deviceId,
            assigneeDeviceId: currentTask.assigneeDeviceId,
          });
          if (!allowed) {
            console.warn('Permission denied: cannot change status of this task');
            return;
          }
        }

        const { event, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'TASK_STATUS_CHANGED',
          { taskId, status },
          taskId,
        );

        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event);
      },

      async sendMessage(body) {
        if (!workspace.channel) return;
        const clean = body.trim();
        if (!clean) return;

        const messageId = crypto.randomUUID();
        const { event, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'CHAT_MESSAGE_SENT',
          { messageId, body: clean },
        );

        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event);
      },

      async createInvitation(expiresInHours = 24) {
        if (!workspace.channel) throw new Error('No active channel');
        const currentUser = workspace.channel.members.find(
          (m) => m.deviceId === workspace.channel?.currentUserDeviceId,
        );
        if (currentUser?.role !== 'LEAD') {
          throw new Error('Only the channel lead can create invitations');
        }

        const invitation = createInvitationPayload({
          channelId: workspace.channel.id,
          expiresInHours,
        });
        const code = encodeInvitationCode(invitation);

        const { event } = await repository.commitLocalEvent(
          workspace.channel.id,
          'INVITATION_CREATED',
          invitation,
          invitation.invitationId,
        );

        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event);
        return code;
      },

      async joinChannelWithCode(code, displayName) {
        const parsed = parseInvitationCode(code);
        if (!parsed.success) {
          return { success: false, message: parsed.error };
        }

        if (displayName?.trim()) {
          await repository.updateDisplayName(displayName.trim());
        }

        await repository.joinChannel(parsed.invitation.channelId);
        const idRecord = await repository.getIdentity();

        const memberEvent = await repository.commitLocalEvent(
          parsed.invitation.channelId,
          'MEMBER_ADDED',
          {
            deviceId: idRecord.deviceId,
            displayName: idRecord.displayName,
            role: 'MEMBER',
            publicKey: idRecord.publicSigningKey,
          },
          idRecord.deviceId,
        );

        setWorkspace(memberEvent.snapshot);
        await syncIdentityState();
        await refreshChannels();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(memberEvent.event);
        return { success: true, message: 'Joined channel successfully!' };
      },

      async updateMemberRole(deviceId, role) {
        if (!workspace.channel) return;
        const currentUser = workspace.channel.members.find(
          (m) => m.deviceId === workspace.channel?.currentUserDeviceId,
        );
        if (currentUser?.role !== 'LEAD') {
          console.warn('Only the channel lead can modify roles');
          return;
        }
        if (role === 'LEAD') {
          console.warn('Cannot appoint a second lead');
          return;
        }

        const { event, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'MEMBER_ROLE_CHANGED',
          { deviceId, role },
          deviceId,
        );

        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event);
      },

      async removeMember(deviceId) {
        if (!workspace.channel) return;
        const currentUser = workspace.channel.members.find(
          (m) => m.deviceId === workspace.channel?.currentUserDeviceId,
        );
        if (currentUser?.role !== 'LEAD') {
          console.warn('Only the channel lead can remove members');
          return;
        }
        if (deviceId === workspace.channel.currentUserDeviceId) {
          console.warn('The channel lead cannot be removed');
          return;
        }

        const { event, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'MEMBER_REMOVED',
          { deviceId },
          deviceId,
        );

        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event);
      },
    }),
    [workspace, identity, isReady, channels, peerIdentities, peerSessions, syncLogs],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return context;
}
