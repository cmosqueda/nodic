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
import {
  formatNodicId,
  repository,
  type JoinRequestRecord,
  type PairingAttemptResult,
} from '../db/repository';
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

/** A join request that the channel lead has not answered yet. No channel exists locally until admission. */
export interface PendingJoin {
  channelId: string;
  channelName: string;
  leadDeviceId: string;
  leadName: string;
  status: 'CONNECTING' | 'WAITING' | 'REJECTED' | 'TIMEOUT';
  message?: string;
}

const JOIN_ANSWER_TIMEOUT_MS = 45_000;
const JOIN_PAIRING_TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function friendlyJoinReason(reason?: string): string {
  switch (reason) {
    case 'Invitation not found for this channel':
      return 'This invite code was already used or is no longer valid. Ask the lead for a new one.';
    case 'Invitation has expired':
      return 'This invite code has expired. Ask the lead for a new one.';
    case 'Invalid invitation secret':
      return 'The invite code is not valid. Check it was copied completely.';
    default:
      return reason ?? 'The channel lead declined your request.';
  }
}

/** A direct invitation another nearby lead sent to this device. */
export interface IncomingInvite {
  id: string;
  code: string;
  channelId: string;
  channelName: string;
  leadDeviceId: string;
  leadName: string;
  expiresAt: string;
}

interface WorkspaceActions {
  joinRequests: JoinRequestRecord[];
  incomingInvites: IncomingInvite[];
  initError: string | null;
  approveJoinRequest(requestId: string): Promise<void>;
  declineJoinRequest(requestId: string): Promise<void>;
  inviteNearbyPeer(deviceId: string): Promise<void>;
  acceptIncomingInvite(inviteId: string): Promise<{ success: boolean; message: string }>;
  dismissIncomingInvite(inviteId: string): void;
  pendingJoin: PendingJoin | null;
  cancelPendingJoin(): void;
  retryPendingJoin(): Promise<void>;
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
  createChannel(name: string, description?: string): Promise<void>;
  switchChannel(channelId: string): Promise<void>;
  leaveChannel(): Promise<void>;
  recoverChannelSession(channelIdOrSessionId?: string): Promise<boolean>;
  resetDatabase(): Promise<void>;
  connectToPeer(host: string, port: number): Promise<boolean>;
  requestPairingByNodicIds(nodicIds: string | string[]): Promise<PairingAttemptResult[]>;
  /** `delivered` is false when the other phone could not be reached; it is re-sent automatically. */
  respondToPairingRequest(requestId: string, accept: boolean): Promise<{ delivered: boolean }>;
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

/** Devices allowed to receive a channel's traffic: its members and lead (never merely paired peers). */
const toMembers = (channelId: string): string[] => repository.getChannelRecipientIds(channelId);

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
  const isReadyRef = useRef(false);
  const activeChannelIdRef = useRef<string | null>(null);
  activeChannelIdRef.current = workspace.channel?.id ?? null;
  isReadyRef.current = isReady;

  const [joinRequests, setJoinRequests] = useState<JoinRequestRecord[]>([]);
  const [incomingInvites, setIncomingInvites] = useState<IncomingInvite[]>([]);
  const [initError, setInitError] = useState<string | null>(null);
  const refreshJoinRequests = () => setJoinRequests(repository.listJoinRequests());

  // Drop requests whose invitation expired while the lead was looking at the list.
  useEffect(() => {
    const t = setInterval(() => setJoinRequests(repository.listJoinRequests()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [pendingJoin, setPendingJoinState] = useState<PendingJoin | null>(null);
  const pendingJoinRef = useRef<PendingJoin | null>(null);
  const pendingInviteRef = useRef<{
    invitationId: string;
    joinSecret: string;
    options: {
      description: string | null;
      sessionId?: string;
      leadDisplayName?: string;
      leadPublicKey?: string;
    };
  } | null>(null);
  const joinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearJoinTimer = () => {
    if (joinTimerRef.current) clearTimeout(joinTimerRef.current);
    joinTimerRef.current = null;
  };
  const setPending = (next: PendingJoin | null) => {
    pendingJoinRef.current = next;
    setPendingJoinState(next);
  };
  const patchPending = (patch: Partial<PendingJoin>) => {
    if (pendingJoinRef.current) setPending({ ...pendingJoinRef.current, ...patch });
  };

  /** Pairs with the lead automatically (the lead auto-accepts while an invite is open). */
  const ensurePairedWithLead = async (leadDeviceId: string): Promise<boolean> => {
    const channelId = pendingJoinRef.current?.channelId;
    const end = Date.now() + JOIN_PAIRING_TIMEOUT_MS;
    let requested = false;
    while (Date.now() < end && pendingJoinRef.current?.channelId === channelId) {
      if (await repository.isPairedWith(leadDeviceId)) return true;
      if (!requested) {
        try {
          const [res] = await repository.requestPairingByNodicIds(formatNodicId(leadDeviceId));
          requested = res?.status === 'REQUEST_SENT';
        } catch {
          // lead not discoverable yet - retry below
        }
      }
      await sleep(1500);
    }
    return repository.isPairedWith(leadDeviceId);
  };

  const startJoinAttempt = async () => {
    const pending = pendingJoinRef.current;
    const invite = pendingInviteRef.current;
    if (!pending || !invite) return;
    clearJoinTimer();
    patchPending({ status: 'CONNECTING', message: undefined });

    const paired = await ensurePairedWithLead(pending.leadDeviceId);
    if (pendingJoinRef.current?.channelId !== pending.channelId) return; // cancelled meanwhile
    if (!paired) {
      patchPending({
        status: 'TIMEOUT',
        message: `Couldn't reach ${pending.leadName}. Make sure you are on the same Wi-Fi and they have Nodic open.`,
      });
      return;
    }

    const request = await repository.buildJoinRequestEvent(pending.channelId, invite);
    void nativeSync.publishEvent(request, [pending.leadDeviceId]);
    patchPending({ status: 'WAITING' });
    joinTimerRef.current = setTimeout(() => {
      if (pendingJoinRef.current?.status === 'WAITING') {
        patchPending({
          status: 'TIMEOUT',
          message: `${pending.leadName} hasn't answered yet. Ask them to open Nodic, then try again.`,
        });
      }
    }, JOIN_ANSWER_TIMEOUT_MS);
  };

  /**
   * Lead side: admit a queued applicant - consume the invite, tell the applicant first (so it creates
   * the channel), then send membership + history. Throws a readable Error on failure.
   */
  const admitApplicant = async (requestId: string) => {
    const res = await repository.approveJoinRequest(requestId);
    refreshJoinRequests();
    if (!res.request) throw new Error(res.reason ?? 'This request is no longer pending.');
    const applicantId = res.request.applicantDeviceId;
    if (!res.accepted || !res.memberEvent) {
      const rejection = await repository.buildJoinResponseEvent(res.request.channelId, applicantId, {
        accepted: false,
        reason: res.reason ?? 'Join request declined',
      });
      void nativeSync.publishEvent(rejection, [applicantId]);
      throw new Error(friendlyJoinReason(res.reason));
    }
    const channelId = res.request.channelId;
    const acceptance = await repository.buildJoinResponseEvent(channelId, applicantId, { accepted: true });
    await nativeSync.publishEvent(acceptance, [applicantId]).catch(() => undefined);
    await refreshChannels();
    if (activeChannelIdRef.current === channelId) {
      setWorkspace(await repository.loadWorkspace(channelId));
    }
    await syncIdentityState();
    const recipients = repository.getChannelRecipientIds(channelId);
    void nativeSync.publishEvent(res.memberEvent, recipients);
    const history = await repository.getAllChannelEvents(channelId, 200);
    if (history.length > 0) void nativeSync.publishBatch(history, [applicantId]);
    const summary = await repository.getSyncSummary(channelId);
    void nativeSync.publishSummary(channelId, summary, recipients);
  };

  /** Applicant side: a lead invited this device directly. */
  const handleChannelInvite = async (event: NodicEvent, peerId: string) => {
    const self = await repository.getIdentity();
    const payload = event.payload as { targetDeviceId?: string; code?: string };
    if (payload.targetDeviceId !== self.deviceId || !payload.code) return;
    const parsed = parseInvitationCode(payload.code);
    if (!parsed.success) return;
    const inv = parsed.invitation;
    // Only the lead named in the code may send it, and it must really come from that device.
    if (!inv.leadDeviceId || inv.leadDeviceId !== event.authorDeviceId || inv.leadDeviceId !== peerId) return;
    if ((await repository.listChannels()).some((c) => c.id === inv.channelId)) return;
    setIncomingInvites((prev) =>
      prev.some((i) => i.id === inv.invitationId)
        ? prev
        : [
            ...prev,
            {
              id: inv.invitationId,
              code: payload.code!,
              channelId: inv.channelId,
              channelName: inv.channelName ?? 'Channel',
              leadDeviceId: inv.leadDeviceId!,
              leadName: inv.leadDisplayName ?? 'A channel lead',
              expiresAt: inv.expiresAt,
            },
          ],
    );
  };

  /** Applicant side: the lead's answer to our join request. */
  const handleJoinResponse = async (event: NodicEvent, peerId: string) => {
    const pending = pendingJoinRef.current;
    if (!pending || pending.channelId !== event.channelId) return;
    // Only the lead named in the invitation may answer, both as author and as network sender.
    if (event.authorDeviceId !== pending.leadDeviceId || peerId !== pending.leadDeviceId) return;
    const self = await repository.getIdentity();
    const payload = event.payload as {
      applicantDeviceId?: string;
      reason?: string;
      channelKey?: string;
      keyVersion?: number;
    };
    if (payload.applicantDeviceId !== self.deviceId) return;
    clearJoinTimer();

    if (event.type === 'JOIN_REJECTED') {
      patchPending({ status: 'REJECTED', message: friendlyJoinReason(payload.reason) });
      return;
    }

    const invite = pendingInviteRef.current;
    if (payload.channelKey) {
      repository.installChannelKey(pending.channelId, payload.keyVersion ?? 1, payload.channelKey);
    }
    const snapshot = await repository.joinChannel(
      pending.channelId,
      pending.channelName,
      pending.leadDeviceId,
      invite?.options,
    );
    pendingInviteRef.current = null;
    setPending(null);
    setWorkspace(snapshot);
    await syncIdentityState();
    await refreshChannels();
    await refreshDiagnosticsState();
  };

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
    const pairingCleanups: Array<() => void> = [];

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
        if (!unmounted) {
          setInitError(err instanceof Error ? err.message : 'Nodic could not load its local data.');
          setIsReady(true);
        }
      }
    }

    void init();

    if (nativeSync.isNative()) {
      const eventListener = nativeSync.plugin.addListener('eventReceived', (data) => {
        try {
          const event = JSON.parse(data.eventJson) as NodicEvent;

          // A prospective member proving itself with an invite code: only the lead acts on it.
          if (event.type === 'JOIN_REQUESTED') {
            void (async () => {
              const applicant = [event.authorDeviceId];
              const outcome = await repository.receiveJoinRequest(event);
              if (outcome.status === 'REJECTED') {
                const rejection = await repository.buildJoinResponseEvent(
                  event.channelId,
                  event.authorDeviceId,
                  { accepted: false, reason: outcome.reason },
                );
                void nativeSync.publishEvent(rejection, applicant);
                return;
              }
              if (outcome.status === 'ALREADY_MEMBER') {
                // Lost reply: re-send acceptance and history, no new invite consumed.
                const acceptance = await repository.buildJoinResponseEvent(
                  event.channelId,
                  event.authorDeviceId,
                  { accepted: true },
                );
                await nativeSync.publishEvent(acceptance, applicant).catch(() => undefined);
                const history = await repository.getAllChannelEvents(event.channelId, 200);
                if (history.length > 0) void nativeSync.publishBatch(history, applicant);
                return;
              }
              if (unmounted) return;
              refreshJoinRequests();
              // Invited directly by this lead: no second approval needed.
              if (outcome.request.invitedDirectly) {
                await admitApplicant(outcome.request.requestId).catch((err) =>
                  console.warn('Direct-invite admission failed:', err),
                );
              }
            })();
            return;
          }

          if (event.type === 'CHANNEL_INVITE') {
            void handleChannelInvite(event, data.peerId);
            return;
          }

          if (event.type === 'JOIN_ACCEPTED' || event.type === 'JOIN_REJECTED') {
            void handleJoinResponse(event, data.peerId);
            return;
          }

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
                void nativeSync.publishBatch(allEvents, toMembers(event.channelId));
              }
              const summary = await repository.getSyncSummary(event.channelId);
              void nativeSync.publishSummary(event.channelId, summary, toMembers(event.channelId));
            } else if (event.type === 'CHANNEL_CREATED') {
              const summary = await repository.getSyncSummary(event.channelId);
              void nativeSync.publishSummary(event.channelId, summary, toMembers(event.channelId));
            }

            // Phase 2: Relay to other members of this channel (never to non-members)
            const currentIdentity = await repository.getIdentity();
            const relayPeers = filterPeersForRelay(
              toMembers(event.channelId),
              data.peerId,
              currentIdentity.deviceId,
            );
            if (relayPeers.length > 0 && event.authorDeviceId !== currentIdentity.deviceId) {
              void nativeSync.publishEvent(event, relayPeers);
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
          if (targetChannelId && toMembers(targetChannelId).includes(data.peerId)) {
            void repository
              .reconcileWithPeerSummary(targetChannelId, data.peerId, sequences)
              .then(async ({ eventsToSend, missingRangesFromPeer }) => {
                if (eventsToSend.length > 0) {
                  void nativeSync.publishBatch(eventsToSend, [data.peerId]);
                }
                if (missingRangesFromPeer.length > 0) {
                  const localSummary = await repository.getSyncSummary(targetChannelId);
                  void nativeSync.publishSummary(targetChannelId, localSummary, [data.peerId]);
                }
              });
          }
        } catch (error) {
          console.warn('Failed to process incoming peer summary:', error);
        }
      });

      // Pool pairing state: pick up what the native layer recorded while the UI wasn't listening,
      // and keep re-offering our pending requests to peers that are (or come) nearby.
      const syncPairing = async () => {
        if (unmounted || !isReadyRef.current) return; // wait for the initial load
        try {
          const changed = await repository.mergeNativePairingState();
          const resent = await repository.retryPendingOutboundPairings();
          if (changed || resent > 0) await refreshDiagnosticsState();
        } catch (err) {
          console.warn('Pairing sync failed:', err);
        }
      };
      const pairingTimer = setInterval(() => void syncPairing(), 8000);
      const onVisible = () => {
        if (document.visibilityState === 'visible') void syncPairing();
      };
      document.addEventListener('visibilitychange', onVisible);
      pairingCleanups.push(() => {
        clearInterval(pairingTimer);
        document.removeEventListener('visibilitychange', onVisible);
      });

      const statusListener = nativeSync.plugin.addListener('statusChanged', (status) => {
        const currentChannelId = activeChannelIdRef.current;
        if (status.state === 'CONNECTED' && status.peerCount > 0 && currentChannelId) {
          void repository.getSyncSummary(currentChannelId).then((summary) => {
            void nativeSync.publishSummary(currentChannelId, summary, toMembers(currentChannelId));
          });
          void repository.getAllChannelEvents(currentChannelId, 200).then((events) => {
            if (events.length > 0) {
              void nativeSync.publishBatch(events, toMembers(currentChannelId));
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
          void repository.receiveIncomingPairingRequest(reqData).then(async (req) => {
            // While an invite is open, a device presenting a code needs to connect to us. Pairing
            // alone grants no channel data - admission still needs the invite secret.
            if (repository.hasActiveInvitation()) {
              await repository.respondToPairingRequest(req.requestId, true).catch(() => undefined);
            }
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
              void nativeSync.publishSummary(currentChannelId, summary, toMembers(currentChannelId));
              const events = await repository.getAllChannelEvents(currentChannelId, 200);
              if (events.length > 0) {
                void nativeSync.publishBatch(events, toMembers(currentChannelId));
              }
            }
          });
        },
      );

      return () => {
        unmounted = true;
        pairingCleanups.forEach((fn) => fn());
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

  const createInvitationCode = async (expiresInHours = 24): Promise<string> => {
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

        await repository.registerInvitation({
          invitationId: invitation.invitationId,
          joinSecret: invitation.joinSecret,
          expiresAt: invitation.expiresAt,
          channelId: workspace.channel.id,
        });

        // The join secret itself must never enter the event log or travel over the network
        const { event } = await repository.commitLocalEvent(
          workspace.channel.id,
          'INVITATION_CREATED',
          {
            channelId: invitation.channelId,
            invitationId: invitation.invitationId,
            expiresAt: invitation.expiresAt,
          },
          invitation.invitationId,
        );

        await syncIdentityState();
        await refreshDiagnosticsState();
        void nativeSync.publishEvent(event, toMembers(event.channelId));
        return code;
      };

  const joinWithCode = async (
    code: string,
    displayName?: string,
  ): Promise<{ success: boolean; message: string }> => {
          const parsed = parseInvitationCode(code);
          if (!parsed.success) {
            return { success: false, message: parsed.error };
          }
          const invitation = parsed.invitation;
          const leadDeviceId = invitation.leadDeviceId;
          if (!leadDeviceId) {
            return { success: false, message: 'This invitation does not identify a channel lead.' };
          }
          const self = await repository.getIdentity();
          if (leadDeviceId === self.deviceId) {
            return { success: false, message: 'This is your own invite code. Share it with a teammate.' };
          }
          if (channels.some((c) => c.id === invitation.channelId)) {
            return { success: false, message: 'You are already in this channel.' };
          }
          const inFlight = pendingJoinRef.current;
          if (inFlight && (inFlight.status === 'CONNECTING' || inFlight.status === 'WAITING')) {
            return { success: false, message: 'A join request is already in progress.' };
          }

          if (displayName?.trim()) {
            await repository.updateDisplayName(displayName.trim());
            await syncIdentityState();
          }

          // Nothing is stored locally until the lead admits us (see handleJoinResponse).
          pendingInviteRef.current = {
            invitationId: invitation.invitationId,
            joinSecret: invitation.joinSecret,
            options: {
              description: invitation.channelDescription ?? null,
              sessionId: invitation.sessionId,
              leadDisplayName: invitation.leadDisplayName,
              leadPublicKey: invitation.leadPublicKey,
            },
          };
          setPending({
            channelId: invitation.channelId,
            channelName: invitation.channelName ?? 'Channel',
            leadDeviceId,
            leadName: invitation.leadDisplayName ?? 'the channel lead',
            status: 'CONNECTING',
          });
          void startJoinAttempt();
          return { success: true, message: 'Connecting to the channel lead...' };
        };

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

        const selfRole = workspace.channel?.members.find((m) => m.deviceId === updated.deviceId)?.role;
        if (workspace.channel && selfRole === 'LEAD') {
          const currentUserRole = selfRole;
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
          void nativeSync.publishEvent(event, toMembers(event.channelId));
        }
        await refreshDiagnosticsState();
      },

      async createChannel(name, description) {
        const cleanName = name.trim();
        if (!cleanName) return;

        const { snapshot } = await repository.createChannel(
          cleanName,
          description,
        );
        setWorkspace(snapshot);
        await syncIdentityState();
        await refreshChannels();
        await refreshDiagnosticsState();
        // Nothing is broadcast: a new channel stays private to its lead until someone
        // joins it with an invite code.
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
            void nativeSync.publishBatch(events, toMembers(snapshot.channel.id));
          }
          const summary = await repository.getSyncSummary(snapshot.channel.id);
          void nativeSync.publishSummary(snapshot.channel.id, summary, toMembers(snapshot.channel.id));
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
            void nativeSync.publishBatch(events, toMembers(workspace.channel.id));
          }
          const summary = await repository.getSyncSummary(workspace.channel.id);
          void nativeSync.publishSummary(workspace.channel.id, summary, toMembers(workspace.channel.id));
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
            void nativeSync.publishBatch(events, toMembers(workspace.channel.id));
          }
          const summary = await repository.getSyncSummary(workspace.channel.id);
          void nativeSync.publishSummary(workspace.channel.id, summary, toMembers(workspace.channel.id));
        }
      
        return { delivered: res.delivered };
      },

      async disconnectPeerLocally(peerDeviceIdOrNodicId: string) {
        await repository.disconnectPeerLocally(peerDeviceIdOrNodicId);
        await refreshDiagnosticsState();
      },

      async refreshNetworkDiagnostics() {
        // A manual scan also re-pools pairing requests and re-offers pending ones.
        await repository.mergeNativePairingState().catch(() => false);
        await repository.retryPendingOutboundPairings().catch(() => 0);
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
        void nativeSync.publishEvent(event, toMembers(event.channelId));
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
        void nativeSync.publishEvent(event, toMembers(event.channelId));
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
        void nativeSync.publishEvent(event, toMembers(event.channelId));
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
        void nativeSync.publishEvent(event, toMembers(event.channelId));
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
        void nativeSync.publishEvent(event, toMembers(event.channelId));
      },

      createInvitation: createInvitationCode,

      joinRequests,
      incomingInvites,
      initError,

      async approveJoinRequest(requestId) {
        await admitApplicant(requestId);
      },

      async declineJoinRequest(requestId) {
        const request = repository.declineJoinRequest(requestId);
        refreshJoinRequests();
        if (!request) return;
        const rejection = await repository.buildJoinResponseEvent(
          request.channelId,
          request.applicantDeviceId,
          { accepted: false, reason: 'The channel lead declined your request.' },
        );
        void nativeSync.publishEvent(rejection, [request.applicantDeviceId]);
      },

      async inviteNearbyPeer(deviceId) {
        const channel = workspace.channel;
        if (!channel) throw new Error('Open a channel first.');
        const me = channel.members.find((m) => m.deviceId === channel.currentUserDeviceId);
        if (me?.role !== 'LEAD') throw new Error('Only the channel lead can invite people.');
        if (channel.members.some((m) => m.deviceId === deviceId)) {
          throw new Error('That person is already in this channel.');
        }
        // Re-check against fresh data: must be connected AND currently nearby on this network.
        const [paired, peers] = await Promise.all([
          repository.listPairedDevices(),
          repository.listPeerIdentities(),
        ]);
        const device = paired.find((d) => d.deviceId === deviceId && d.pairingState === 'PAIRED');
        if (!device) throw new Error('Connect to this person first (Network > Connect).');
        const nearby = peers.some((p) => p.deviceId === deviceId && p.status === 'ONLINE');
        if (!nearby) {
          throw new Error(`${device.displayName} is not nearby right now. Check you are on the same Wi-Fi.`);
        }

        const code = await createInvitationCode(24);
        const parsed = parseInvitationCode(code);
        if (!parsed.success) throw new Error(parsed.error);
        repository.markDirectInvite(parsed.invitation.invitationId, deviceId);

        const inviteEvent = await repository.buildChannelInviteEvent(channel.id, deviceId, code);
        let delivered = false;
        try {
          delivered = (await nativeSync.publishEvent(inviteEvent, [deviceId])).accepted;
        } catch {
          delivered = false;
        }
        if (!delivered) {
          repository.discardInvitation(parsed.invitation.invitationId);
          throw new Error(`Couldn't reach ${device.displayName}. Make sure they have Nodic open and are nearby.`);
        }
      },

      async acceptIncomingInvite(inviteId) {
        const invite = incomingInvites.find((i) => i.id === inviteId);
        if (!invite) return { success: false, message: 'This invitation is no longer available.' };
        const result = await joinWithCode(invite.code);
        if (result.success) setIncomingInvites((prev) => prev.filter((i) => i.id !== inviteId));
        return result;
      },

      dismissIncomingInvite(inviteId) {
        setIncomingInvites((prev) => prev.filter((i) => i.id !== inviteId));
      },

      pendingJoin,

      cancelPendingJoin() {
        clearJoinTimer();
        pendingInviteRef.current = null;
        setPending(null);
      },

      async retryPendingJoin() {
        await startJoinAttempt();
      },

      joinChannelWithCode: joinWithCode,

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
        void nativeSync.publishEvent(event, toMembers(event.channelId));
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
        void nativeSync.publishEvent(removeEvent, toMembers(removeEvent.channelId));
        void nativeSync.publishEvent(rotateEvent, toMembers(rotateEvent.channelId));
      },
    }),
    [
      joinRequests,
      incomingInvites,
      initError,
      pendingJoin,
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
