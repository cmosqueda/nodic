import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import type {
  MemberRole,
  NodicEvent,
  PairedDevice,
  PairingRequest,
  PeerIdentity,
  PeerSession,
  SyncLog,
  TaskPriority,
  TaskStatus,
} from '../../protocol/contracts';
import type { ChannelSummary, WorkspaceSnapshot } from '../domain/models';
import { canAuthorEvent, canChangeTaskStatus } from '../domain/permissions/permissions';
import {
  createInvitationPayload,
  encodeInvitationCode,
  parseInvitationCode,
} from '../domain/invitations/invitation-codec';
import { filterPeersForRelay } from '../domain/sync/sync-engine';
import { repository, type PairingAttemptResult } from '../db/repository';
import { nativeSync } from '../services/native-sync';

interface CreateTaskInput {
  title: string;
  description?: string;
  priority: TaskPriority;
  assigneeDeviceId?: string;
  dueAt?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  assigneeDeviceId?: string | null;
  dueAt?: string | null;
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
  updateTask(taskId: string, fields: UpdateTaskInput): Promise<void>;
  archiveTask(taskId: string): Promise<void>;
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
  recoverChannelSession(channelIdOrSessionId?: string): Promise<boolean>;
  resetDatabase(): Promise<void>;
  connectToPeer(host: string, port: number): Promise<boolean>;
  requestPairingByNodicIds(nodicIds: string | string[]): Promise<PairingAttemptResult[]>;
  respondToPairingRequest(requestId: string, accept: boolean): Promise<void>;
  disconnectPeerLocally(peerDeviceIdOrNodicId: string): Promise<void>;
  refreshNetworkDiagnostics(): Promise<void>;
  clearSyncLogs(): Promise<void>;
  isReady: boolean;
  identity: UserIdentity | null;
  channels: ChannelSummary[];
  peerIdentities: PeerIdentity[];
  peerSessions: PeerSession[];
  pairedDevices: PairedDevice[];
  pairingRequests: PairingRequest[];
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
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [pairingRequests, setPairingRequests] = useState<PairingRequest[]>([]);
  const [syncLogs, setSyncLogs] = useState<SyncLog[]>([]);
  const [isReady, setIsReady] = useState(false);
  const activeChannelIdRef = useRef<string | null>(null);
  activeChannelIdRef.current = workspace.channel?.id ?? null;

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
      const [
        { peerIdentities: peers, peerSessions: sessions, syncLogs: logs },
        paired,
        requests,
      ] = await Promise.all([
        repository.syncNativeDiagnostics(),
        repository.listPairedDevices(),
        repository.listPairingRequests(),
      ]);
      setPeerIdentities(peers);
      setPeerSessions(sessions);
      setSyncLogs(logs);
      setPairedDevices(paired);
      setPairingRequests(requests);
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
        if (nativeSync.isNative()) {
          void nativeSync.start(
            idRecord.displayName,
            idRecord.deviceId,
            idRecord.publicSigningKey,
          );
        }
        const [chanList, peers, sessions, logs, paired, requests] = await Promise.all([
          repository.listChannels(),
          repository.listPeerIdentities(),
          repository.listPeerSessions(),
          repository.listSyncLogs(),
          repository.listPairedDevices(),
          repository.listPairingRequests(),
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
          setPairedDevices(paired);
          setPairingRequests(requests);
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

            // When remote member joins, immediately send full channel history + vector summary
            if (event.type === 'MEMBER_ADDED') {
              const allEvents = await repository.getAllChannelEvents(event.channelId, 200);
              if (allEvents.length > 0) {
                void nativeSync.publishBatch(allEvents);
              }
              const summary = await repository.getSyncSummary(event.channelId);
              void nativeSync.publishSummary(event.channelId, summary);
            } else if (event.type === 'CHANNEL_CREATED') {
              const summary = await repository.getSyncSummary(event.channelId);
              void nativeSync.publishSummary(event.channelId, summary);
            }

            // Phase 2: Relay to other peers if not sender and not local author
            const peers = await repository.listPeerIdentities();
            const currentIdentity = await repository.getIdentity();
            const relayPeers = filterPeersForRelay(
              peers.map((p) => p.deviceId),
              data.peerId,
              currentIdentity.deviceId,
            );
            if (relayPeers.length > 0 && event.authorDeviceId !== currentIdentity.deviceId) {
              void nativeSync.publishEvent(event);
            }
          });
        } catch (error) {
          console.warn('Failed to process incoming peer event:', error);
        }
      });

      const summaryListener = nativeSync.plugin.addListener('summaryReceived', (data) => {
        try {
          const payload = JSON.parse(data.summaryJson) as {
            channelId?: string;
            sequences?: Record<string, number>;
          };
          const targetChannelId = payload.channelId ?? activeChannelIdRef.current;
          const sequences = payload.sequences ?? {};
          if (targetChannelId) {
            void repository
              .reconcileWithPeerSummary(targetChannelId, data.peerId, sequences)
              .then(async ({ eventsToSend, missingRangesFromPeer }) => {
                if (eventsToSend.length > 0) {
                  void nativeSync.publishBatch(eventsToSend);
                }
                if (missingRangesFromPeer.length > 0) {
                  const localSummary = await repository.getSyncSummary(targetChannelId);
                  void nativeSync.publishSummary(targetChannelId, localSummary);
                }
              });
          }
        } catch (error) {
          console.warn('Failed to process incoming peer summary:', error);
        }
      });

      const statusListener = nativeSync.plugin.addListener('statusChanged', (status) => {
        const currentChannelId = activeChannelIdRef.current;
        if (status.state === 'CONNECTED' && status.peerCount > 0 && currentChannelId) {
          void repository.getSyncSummary(currentChannelId).then((summary) => {
            void nativeSync.publishSummary(currentChannelId, summary);
          });
          void repository.getAllChannelEvents(currentChannelId, 200).then((events) => {
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

      const pairingReqListener = nativeSync.plugin.addListener(
        'pairingRequestReceived',
        (reqData) => {
          void repository.receiveIncomingPairingRequest(reqData).then(async () => {
            if (unmounted) return;
            const [peers, paired, requests] = await Promise.all([
              repository.listPeerIdentities(),
              repository.listPairedDevices(),
              repository.listPairingRequests(),
            ]);
            if (!unmounted) {
              setPeerIdentities(peers);
              setPairedDevices(paired);
              setPairingRequests(requests);
            }
          });
        },
      );

      const pairingRespListener = nativeSync.plugin.addListener(
        'pairingResponseReceived',
        (respData) => {
          void repository.receivePairingResponse(respData).then(async () => {
            if (unmounted) return;
            const [peers, sessions, paired, requests] = await Promise.all([
              repository.listPeerIdentities(),
              repository.listPeerSessions(),
              repository.listPairedDevices(),
              repository.listPairingRequests(),
            ]);
            if (!unmounted) {
              setPeerIdentities(peers);
              setPeerSessions(sessions);
              setPairedDevices(paired);
              setPairingRequests(requests);
            }
            const currentChannelId = activeChannelIdRef.current;
            if (respData.accepted && currentChannelId) {
              const summary = await repository.getSyncSummary(currentChannelId);
              void nativeSync.publishSummary(currentChannelId, summary);
              const events = await repository.getAllChannelEvents(currentChannelId, 200);
              if (events.length > 0) {
                void nativeSync.publishBatch(events);
              }
            }
          });
        },
      );

      return () => {
        unmounted = true;
        void eventListener.then((h) => h.remove());
        void summaryListener.then((h) => h.remove());
        void statusListener.then((h) => h.remove());
        void peerIdentityListener.then((h) => h.remove());
        void peerSessionListener.then((h) => h.remove());
        void syncLogListener.then((h) => h.remove());
        void pairingReqListener.then((h) => h.remove());
        void pairingRespListener.then((h) => h.remove());
      };
    }

    return () => {
      unmounted = true;
    };
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      ...workspace,
      identity,
      isReady,
      channels,
      peerIdentities,
      peerSessions,
      pairedDevices,
      pairingRequests,
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
              publicSigningKey: updated.publicSigningKey,
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

      async recoverChannelSession(channelIdOrSessionId?: string) {
        const snapshot = await repository.recoverChannelSession(channelIdOrSessionId);
        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshChannels();
        await refreshDiagnosticsState();
        if (snapshot.channel) {
          const events = await repository.getAllChannelEvents(snapshot.channel.id, 200);
          if (events.length > 0) {
            void nativeSync.publishBatch(events);
          }
          const summary = await repository.getSyncSummary(snapshot.channel.id);
          void nativeSync.publishSummary(snapshot.channel.id, summary);
          return true;
        }
        return false;
      },

      async resetDatabase() {
        const snapshot = await repository.resetDatabase();
        await syncIdentityState();
        setWorkspace(snapshot);
        setChannels([]);
        setPeerIdentities([]);
        setPeerSessions([]);
        setPairedDevices([]);
        setPairingRequests([]);
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
          const summary = await repository.getSyncSummary(workspace.channel.id);
          void nativeSync.publishSummary(workspace.channel.id, summary);
        }
        return res.connected;
      },

      async requestPairingByNodicIds(nodicIds: string | string[]) {
        const results = await repository.requestPairingByNodicIds(nodicIds);
        await refreshDiagnosticsState();
        return results;
      },

      async respondToPairingRequest(requestId: string, accept: boolean) {
        const res = await repository.respondToPairingRequest(requestId, accept);
        await refreshDiagnosticsState();
        if (res.accepted && workspace.channel?.id) {
          const events = await repository.getAllChannelEvents(workspace.channel.id);
          if (events.length > 0) {
            void nativeSync.publishBatch(events);
          }
          const summary = await repository.getSyncSummary(workspace.channel.id);
          void nativeSync.publishSummary(workspace.channel.id, summary);
        }
      },

      async disconnectPeerLocally(peerDeviceIdOrNodicId: string) {
        await repository.disconnectPeerLocally(peerDeviceIdOrNodicId);
        await refreshDiagnosticsState();
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
        if (currentTask?.status === status) return;
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

      async updateTask(taskId, fields) {
        if (!workspace.channel) return;
        const currentUser = workspace.channel.members.find(
          (m) => m.deviceId === workspace.channel?.currentUserDeviceId,
        );

        if (currentUser && !canAuthorEvent(currentUser.role, 'TASK_FIELDS_UPDATED')) {
          console.warn('Permission denied: only leads and co-leads can update task fields');
          return;
        }

        const { event, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'TASK_FIELDS_UPDATED',
          { taskId, fields },
          taskId,
        );

        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event);
      },

      async archiveTask(taskId) {
        if (!workspace.channel) return;
        const currentUser = workspace.channel.members.find(
          (m) => m.deviceId === workspace.channel?.currentUserDeviceId,
        );

        if (currentUser && !canAuthorEvent(currentUser.role, 'TASK_ARCHIVED')) {
          console.warn('Permission denied: only leads and co-leads can archive tasks');
          return;
        }

        const { event, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'TASK_ARCHIVED',
          { taskId },
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

        const idRecord = await repository.getIdentity();
        let leadEndpoint: string | undefined;
        try {
          const status = await nativeSync.getStatus();
          if (
            status.localEndpoint &&
            status.localEndpoint !== '0.0.0.0:0' &&
            !status.localEndpoint.startsWith('0.0.0.0')
          ) {
            leadEndpoint = status.localEndpoint;
          }
        } catch {}

        const invitation = createInvitationPayload({
          channelId: workspace.channel.id,
          sessionId: workspace.channel.sessionId ?? `sess-${workspace.channel.id.slice(0, 8)}`,
          channelName: workspace.channel.name,
          channelDescription: workspace.channel.description ?? undefined,
          leadDeviceId: workspace.channel.leadDeviceId ?? idRecord.deviceId,
          leadDisplayName: idRecord.displayName,
          leadPublicKey: idRecord.publicSigningKey,
          leadEndpoint,
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

        await repository.joinChannel(
          parsed.invitation.channelId,
          parsed.invitation.channelName,
          parsed.invitation.leadDeviceId,
          {
            description: parsed.invitation.channelDescription ?? null,
            sessionId: parsed.invitation.sessionId,
            leadDisplayName: parsed.invitation.leadDisplayName,
            leadPublicKey: parsed.invitation.leadPublicKey,
          },
        );
        const idRecord = await repository.getIdentity();

        // If the invitation includes the lead's LAN endpoint, automatically initiate a direct TCP connection
        if (parsed.invitation.leadEndpoint) {
          const parts = parsed.invitation.leadEndpoint.split(':');
          const host = parts[0]?.trim();
          const port = Number(parts[1] ?? 42110);
          if (host && host !== '0.0.0.0' && port > 0) {
            try {
              await repository.connectToPeer(host, port, {
                deviceId: parsed.invitation.leadDeviceId,
                displayName: parsed.invitation.leadDisplayName,
                publicKey: parsed.invitation.leadPublicKey,
              });
            } catch {}
          }
        }

        const memberEvent = await repository.commitLocalEvent(
          parsed.invitation.channelId,
          'MEMBER_ADDED',
          {
            deviceId: idRecord.deviceId,
            displayName: idRecord.displayName,
            role: 'MEMBER',
            publicSigningKey: idRecord.publicSigningKey,
            publicKey: idRecord.publicSigningKey,
          },
          idRecord.deviceId,
        );

        setWorkspace(memberEvent.snapshot);
        await syncIdentityState();
        await refreshChannels();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(memberEvent.event);
        const summary = await repository.getSyncSummary(parsed.invitation.channelId);
        void nativeSync.publishSummary(parsed.invitation.channelId, summary);
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

        const { event: removeEvent, snapshot } = await repository.commitLocalEvent(
          workspace.channel.id,
          'MEMBER_REMOVED',
          { deviceId },
          deviceId,
        );
        repository.revokeAuthor(workspace.channel.id, deviceId);

        // Phase 3: Automatically rotate channel key for forward secrecy
        const { event: rotateEvent } = await repository.rotateChannelKey(workspace.channel.id);

        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(removeEvent);
        void nativeSync.publishEvent(rotateEvent);
      },
    }),
    [
      workspace,
      identity,
      isReady,
      channels,
      peerIdentities,
      peerSessions,
      pairedDevices,
      pairingRequests,
      syncLogs,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return context;
}
