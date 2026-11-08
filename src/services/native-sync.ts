import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  NodicEvent,
  PairedDevice,
  PairingRequest,
  PeerIdentity,
  PeerSession,
  SyncLog,
  SyncStatus,
} from '../../protocol/contracts';

export interface ProbeResult {
  pluginReady: boolean;
  databaseReady: boolean;
  serviceReady: boolean;
  deviceId: string;
  details: string[];
}

export interface NativeDiagnosticsSnapshot {
  peerIdentities: PeerIdentity[];
  peerSessions: PeerSession[];
  syncLogs: SyncLog[];
}

export interface NativeDeviceIdentity {
  deviceId: string;
  displayName?: string;
  publicKey: string;
  keystoreAlias?: string;
}

export interface DeepLinkData {
  route: string;
  channelId?: string;
  eventId?: string;
  taskId?: string;
}

export interface BatteryOptimizationStatus {
  ignoringBatteryOptimizations: boolean;
  canRequest: boolean;
  manufacturer?: string;
  model?: string;
}

export interface NativeWorkspaceChannelBackup {
  id: string;
  sessionId: string;
  name: string;
  description: string | null;
  leadDeviceId: string;
  genesisEventId: string;
  keyVersion: number;
  channelKey: string | null;
  isActive: boolean;
  createdAt: number;
}

export interface NativeWorkspaceBackup {
  channels: NativeWorkspaceChannelBackup[];
  events: NodicEvent[];
}

export interface NativePairingState {
  pairedDevices: PairedDevice[];
  pairingRequests: PairingRequest[];
}

interface NodicSyncPlugin {
  getStatus(): Promise<SyncStatus>;
  start(options: { displayName: string; deviceId?: string; publicKey?: string }): Promise<SyncStatus>;
  stop(): Promise<SyncStatus>;
  publishEvent(options: {
    eventJson: string;
    targetDeviceIds?: string[];
  }): Promise<{ accepted: boolean; eventId: string }>;
  publishBatch(options: {
    batchJson: string;
    targetDeviceIds?: string[];
  }): Promise<{ accepted: boolean; batchId: string }>;
  publishSummary(options: {
    summaryJson: string;
    targetDeviceIds?: string[];
  }): Promise<{ accepted: boolean }>;
  savePairedDevice(options: {
    deviceId: string;
    nodicId: string;
    displayName: string;
    publicSigningKey: string;
    host: string;
    port: number;
    pairingState: string;
    pairedAt: number;
    updatedAt: number;
  }): Promise<{ saved: boolean }>;
  savePairingRequest(options: {
    requestId: string;
    fromDeviceId: string;
    fromNodicId: string;
    fromDisplayName: string;
    fromPublicKey: string;
    host: string;
    port: number;
    direction: string;
    status: string;
    createdAt: number;
  }): Promise<{ saved: boolean }>;
  getPairingState(): Promise<NativePairingState>;
  secureSet(options: { key: string; value: string }): Promise<{ saved: boolean }>;
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  saveWorkspaceChannel(options: {
    id: string;
    sessionId: string;
    name: string;
    description?: string | null;
    leadDeviceId: string;
    genesisEventId: string;
    keyVersion?: number;
    channelKey?: string | null;
    isActive?: boolean;
    createdAt?: number;
  }): Promise<{ saved: boolean; id: string; sessionId: string }>;
  setActiveWorkspaceChannel(options: { channelId: string | null }): Promise<{ updated: boolean }>;
  saveWorkspaceEvent(options: { eventJson: string }): Promise<{ saved: boolean }>;
  getWorkspaceBackup(options?: { channelId?: string }): Promise<NativeWorkspaceBackup>;
  clearWorkspaceData(): Promise<{ cleared: boolean }>;
  getDeviceIdentity(options?: { displayName?: string }): Promise<NativeDeviceIdentity>;
  syncDeviceIdentity(options: {
    deviceId: string;
    displayName: string;
    publicKey: string;
  }): Promise<NativeDeviceIdentity>;
  connectPeer(options: { host: string; port: number }): Promise<{ connected: boolean; host: string; port: number }>;
  sendPairingRequest(options: {
    host: string;
    port: number;
    requestId: string;
  }): Promise<{ sent: boolean; requestId: string }>;
  sendPairingResponse(options: {
    host: string;
    port: number;
    requestId: string;
    accepted: boolean;
  }): Promise<{ sent: boolean; requestId: string; accepted: boolean }>;
  disconnectPeerLocally(options: { peerDeviceId: string }): Promise<{ disconnected: boolean }>;
  getDiagnostics(): Promise<NativeDiagnosticsSnapshot>;
  clearLogs(): Promise<{ cleared: boolean }>;
  runProbe(): Promise<ProbeResult>;
  sendProbe(): Promise<{ accepted: boolean; probeId: string }>;
  getPendingDeepLink(): Promise<DeepLinkData>;
  setActiveRoute(options: { route: string }): Promise<{ route: string }>;
  getBatteryOptimizationStatus(): Promise<BatteryOptimizationStatus>;
  requestIgnoreBatteryOptimizations(): Promise<{ launched: boolean }>;
  addListener(eventName: 'statusChanged', listener: (status: SyncStatus) => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'eventReceived',
    listener: (event: { eventJson: string; peerId: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'summaryReceived',
    listener: (data: { summaryJson: string; peerId: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'peerIdentityUpdated',
    listener: (peer: PeerIdentity) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'peerSessionUpdated',
    listener: (session: PeerSession) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'syncLogAdded',
    listener: (log: SyncLog) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'deepLinkOpened',
    listener: (data: DeepLinkData) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'pairingRequestReceived',
    listener: (data: {
      requestId: string;
      fromDeviceId: string;
      fromNodicId: string;
      fromDisplayName: string;
      fromPublicKey: string;
      host: string;
      port: number;
      sentAt: string;
    }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'pairingResponseReceived',
    listener: (data: {
      requestId: string;
      fromDeviceId: string;
      fromNodicId: string;
      fromDisplayName: string;
      fromPublicKey: string;
      host: string;
      port: number;
      accepted: boolean;
      sentAt: string;
    }) => void,
  ): Promise<PluginListenerHandle>;
}

const nativePlugin = registerPlugin<NodicSyncPlugin>('NodicSync');

const browserStatus: SyncStatus = {
  state: 'SEARCHING',
  peerCount: 0,
  pendingEventCount: 0,
  lastSyncAt: null,
  detail: 'Browser preview ready for local storage and peer simulation',
  localEndpoint: '127.0.0.1:8443',
};

export const nativeSync = {
  isNative: () => Capacitor.isNativePlatform(),

  async getStatus(): Promise<SyncStatus> {
    return Capacitor.isNativePlatform() ? nativePlugin.getStatus() : browserStatus;
  },

  async start(displayName: string, deviceId?: string, publicKey?: string): Promise<SyncStatus> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.start({ displayName, deviceId, publicKey });
    }
    browserStatus.state = 'SEARCHING';
    browserStatus.detail = `Advertising as ${displayName}`;
    return { ...browserStatus };
  },

  async stop(): Promise<SyncStatus> {
    if (Capacitor.isNativePlatform()) return nativePlugin.stop();
    browserStatus.state = 'STOPPED';
    browserStatus.peerCount = 0;
    browserStatus.detail = 'Networking stopped';
    return { ...browserStatus };
  },

  async getDeviceIdentity(displayName?: string): Promise<NativeDeviceIdentity> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.getDeviceIdentity(displayName ? { displayName } : {});
    }
    const fallbackId = `web-${crypto.randomUUID().slice(0, 8)}`;
    return {
      deviceId: fallbackId,
      displayName: displayName ?? `Node-${fallbackId.slice(0, 4).toUpperCase()}`,
      publicKey: `p256:web-${fallbackId}`,
      keystoreAlias: 'web-keystore',
    };
  },

  async syncDeviceIdentity(options: {
    deviceId: string;
    displayName: string;
    publicKey: string;
  }): Promise<NativeDeviceIdentity> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.syncDeviceIdentity(options);
    }
    return {
      deviceId: options.deviceId,
      displayName: options.displayName,
      publicKey: options.publicKey,
      keystoreAlias: 'web-keystore',
    };
  },

  async connectPeer(host: string, port: number): Promise<{ connected: boolean; host: string; port: number }> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.connectPeer({ host, port });
    }
    browserStatus.state = 'CONNECTED';
    browserStatus.peerCount = Math.max(1, browserStatus.peerCount);
    browserStatus.lastSyncAt = new Date().toISOString();
    browserStatus.detail = `Connected to ${host}:${port}`;
    return { connected: true, host, port };
  },

  async sendPairingRequest(
    host: string,
    port: number,
    requestId: string,
  ): Promise<{ sent: boolean; requestId: string }> {
    if (Capacitor.isNativePlatform()) {
      try {
        return await nativePlugin.sendPairingRequest({ host, port, requestId });
      } catch {
        return { sent: false, requestId };
      }
    }
    return { sent: true, requestId };
  },

  async sendPairingResponse(
    host: string,
    port: number,
    requestId: string,
    accepted: boolean,
  ): Promise<{ sent: boolean; requestId: string; accepted: boolean }> {
    if (Capacitor.isNativePlatform()) {
      try {
        return await nativePlugin.sendPairingResponse({ host, port, requestId, accepted });
      } catch {
        return { sent: false, requestId, accepted };
      }
    }
    return { sent: true, requestId, accepted };
  },

  async disconnectPeerLocally(peerDeviceId: string): Promise<{ disconnected: boolean }> {
    if (Capacitor.isNativePlatform()) {
      try {
        return await nativePlugin.disconnectPeerLocally({ peerDeviceId });
      } catch {
        return { disconnected: false };
      }
    }
    return { disconnected: true };
  },

  async savePairedDevice(device: PairedDevice): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await nativePlugin.savePairedDevice({
        deviceId: device.deviceId,
        nodicId: device.nodicId,
        displayName: device.displayName,
        publicSigningKey: device.publicSigningKey,
        host: device.host,
        port: device.port,
        pairingState: device.pairingState,
        pairedAt: new Date(device.pairedAt).getTime() || Date.now(),
        updatedAt: new Date(device.updatedAt).getTime() || Date.now(),
      });
    } catch (err) {
      console.warn('Failed to mirror paired device to native store:', err);
    }
  },

  async savePairingRequest(req: PairingRequest): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await nativePlugin.savePairingRequest({
        requestId: req.requestId,
        fromDeviceId: req.fromDeviceId,
        fromNodicId: req.fromNodicId,
        fromDisplayName: req.fromDisplayName,
        fromPublicKey: req.fromPublicKey,
        host: req.host,
        port: req.port,
        direction: req.direction,
        status: req.status,
        createdAt: new Date(req.createdAt).getTime() || Date.now(),
      });
    } catch (err) {
      console.warn('Failed to mirror pairing request to native store:', err);
    }
  },

  async getPairingState(): Promise<NativePairingState> {
    if (Capacitor.isNativePlatform()) {
      try {
        const res = await nativePlugin.getPairingState();
        return {
          pairedDevices: res?.pairedDevices ?? [],
          pairingRequests: res?.pairingRequests ?? [],
        };
      } catch {
        // fall through
      }
    }
    return { pairedDevices: [], pairingRequests: [] };
  },

  async secureSet(key: string, value: string): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      await nativePlugin.secureSet({ key, value });
    } catch (err) {
      console.warn('Failed to persist secret to native secure store:', err);
    }
  },

  async secureGet(key: string): Promise<string | null> {
    if (!Capacitor.isNativePlatform()) return null;
    try {
      const res = await nativePlugin.secureGet({ key });
      return res?.value ?? null;
    } catch {
      return null;
    }
  },

  async getDiagnostics(): Promise<NativeDiagnosticsSnapshot> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.getDiagnostics();
    }
    return {
      peerIdentities: [],
      peerSessions: [],
      syncLogs: [],
    };
  },

  async clearLogs(): Promise<{ cleared: boolean }> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.clearLogs();
    }
    return { cleared: true };
  },

  /**
   * Publish to paired peers. `targetDeviceIds` restricts delivery (e.g. to a channel's members);
   * an empty list delivers to nobody.
   */
  async publishEvent(
    event: NodicEvent,
    targetDeviceIds?: string[],
  ): Promise<{ accepted: boolean; eventId: string }> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.publishEvent({ eventJson: JSON.stringify(event), targetDeviceIds });
    }
    return { accepted: true, eventId: event.id };
  },

  async publishBatch(
    events: NodicEvent[],
    targetDeviceIds?: string[],
  ): Promise<{ accepted: boolean; batchId: string }> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.publishBatch({ batchJson: JSON.stringify(events), targetDeviceIds });
    }
    return { accepted: true, batchId: crypto.randomUUID() };
  },

  async publishSummary(
    channelId: string,
    sequences: Record<string, number>,
    targetDeviceIds?: string[],
  ): Promise<{ accepted: boolean }> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.publishSummary({
        summaryJson: JSON.stringify({ channelId, sequences }),
        targetDeviceIds,
      });
    }
    return { accepted: true };
  },

  async saveWorkspaceChannel(options: {
    id: string;
    sessionId: string;
    name: string;
    description?: string | null;
    leadDeviceId: string;
    genesisEventId: string;
    keyVersion?: number;
    channelKey?: string | null;
    isActive?: boolean;
    createdAt?: number;
  }): Promise<{ saved: boolean; id: string; sessionId: string }> {
    if (Capacitor.isNativePlatform()) {
      try {
        return await nativePlugin.saveWorkspaceChannel(options);
      } catch {
        return { saved: false, id: options.id, sessionId: options.sessionId };
      }
    }
    return { saved: true, id: options.id, sessionId: options.sessionId };
  },

  async setActiveWorkspaceChannel(channelId: string | null): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      try {
        await nativePlugin.setActiveWorkspaceChannel({ channelId });
      } catch {}
    }
  },

  async saveWorkspaceEvent(event: NodicEvent): Promise<boolean> {
    if (Capacitor.isNativePlatform()) {
      try {
        const res = await nativePlugin.saveWorkspaceEvent({ eventJson: JSON.stringify(event) });
        return res.saved;
      } catch {
        return false;
      }
    }
    return true;
  },

  async getWorkspaceBackup(channelId?: string): Promise<NativeWorkspaceBackup> {
    if (Capacitor.isNativePlatform()) {
      try {
        const backup = await nativePlugin.getWorkspaceBackup(channelId ? { channelId } : {});
        return {
          channels: backup?.channels ?? [],
          events: backup?.events ?? [],
        };
      } catch {
        return { channels: [], events: [] };
      }
    }
    return { channels: [], events: [] };
  },

  async clearWorkspaceData(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      try {
        await nativePlugin.clearWorkspaceData();
      } catch {}
    }
  },

  runProbe(): Promise<ProbeResult> {
    if (Capacitor.isNativePlatform()) return nativePlugin.runProbe();
    return Promise.resolve({
      pluginReady: false,
      databaseReady: true,
      serviceReady: browserStatus.state !== 'STOPPED',
      deviceId: 'browser-preview',
      details: ['Local storage database active. Build on Android for native NSD socket transport.'],
    });
  },

  sendProbe(): Promise<{ accepted: boolean; probeId: string }> {
    if (Capacitor.isNativePlatform()) return nativePlugin.sendProbe();
    return Promise.resolve({ accepted: browserStatus.peerCount > 0, probeId: crypto.randomUUID() });
  },

  async getPendingDeepLink(): Promise<DeepLinkData | null> {
    if (Capacitor.isNativePlatform()) {
      try {
        const link = await nativePlugin.getPendingDeepLink();
        return link?.route ? link : null;
      } catch {
        return null;
      }
    }
    return null;
  },

  async setActiveRoute(route: string): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      try {
        await nativePlugin.setActiveRoute({ route });
      } catch {
        // Ignore route report errors
      }
    }
  },

  async getBatteryOptimizationStatus(): Promise<BatteryOptimizationStatus> {
    if (Capacitor.isNativePlatform()) {
      try {
        return await nativePlugin.getBatteryOptimizationStatus();
      } catch {
        return {
          ignoringBatteryOptimizations: false,
          canRequest: false,
          manufacturer: 'Android',
        };
      }
    }
    return {
      ignoringBatteryOptimizations: true,
      canRequest: false,
      manufacturer: 'Web Browser',
      model: 'Preview',
    };
  },

  async requestIgnoreBatteryOptimizations(): Promise<{ launched: boolean }> {
    if (Capacitor.isNativePlatform()) {
      try {
        return await nativePlugin.requestIgnoreBatteryOptimizations();
      } catch {
        return { launched: false };
      }
    }
    return { launched: false };
  },

  onDeepLinkOpened(listener: (data: DeepLinkData) => void): Promise<PluginListenerHandle> | null {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.addListener('deepLinkOpened', listener);
    }
    return null;
  },

  plugin: nativePlugin,
};
