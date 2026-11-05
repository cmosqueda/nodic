import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { NodicEvent, SyncStatus } from '../../protocol/contracts';

export interface ProbeResult {
  pluginReady: boolean;
  databaseReady: boolean;
  serviceReady: boolean;
  deviceId: string;
  details: string[];
}

interface NodicSyncPlugin {
  getStatus(): Promise<SyncStatus>;
  start(options: { displayName: string }): Promise<SyncStatus>;
  stop(): Promise<SyncStatus>;
  publishEvent(options: { eventJson: string }): Promise<{ accepted: boolean; eventId: string }>;
  publishBatch(options: { batchJson: string }): Promise<{ accepted: boolean; batchId: string }>;
  getDeviceIdentity(): Promise<{ deviceId: string; publicKey: string }>;
  runProbe(): Promise<ProbeResult>;
  sendProbe(): Promise<{ accepted: boolean; probeId: string }>;
  addListener(eventName: 'statusChanged', listener: (status: SyncStatus) => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'eventReceived',
    listener: (event: { eventJson: string; peerId: string }) => void,
  ): Promise<PluginListenerHandle>;
}

const nativePlugin = registerPlugin<NodicSyncPlugin>('NodicSync');

const browserStatus: SyncStatus = {
  state: 'SEARCHING',
  peerCount: 3,
  pendingEventCount: 1,
  lastSyncAt: new Date().toISOString(),
  detail: 'Browser preview uses simulated peers',
};

export const nativeSync = {
  isNative: () => Capacitor.isNativePlatform(),

  async getStatus(): Promise<SyncStatus> {
    return Capacitor.isNativePlatform() ? nativePlugin.getStatus() : browserStatus;
  },

  async start(displayName: string): Promise<SyncStatus> {
    return Capacitor.isNativePlatform() ? nativePlugin.start({ displayName }) : browserStatus;
  },

  async stop(): Promise<SyncStatus> {
    if (Capacitor.isNativePlatform()) return nativePlugin.stop();
    return { ...browserStatus, state: 'STOPPED', peerCount: 0 };
  },

  async publishEvent(event: NodicEvent): Promise<{ accepted: boolean; eventId: string }> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.publishEvent({ eventJson: JSON.stringify(event) });
    }
    return { accepted: true, eventId: event.id };
  },

  async publishBatch(events: NodicEvent[]): Promise<{ accepted: boolean; batchId: string }> {
    if (Capacitor.isNativePlatform()) {
      return nativePlugin.publishBatch({ batchJson: JSON.stringify(events) });
    }
    return { accepted: true, batchId: crypto.randomUUID() };
  },

  runProbe(): Promise<ProbeResult> {
    if (Capacitor.isNativePlatform()) return nativePlugin.runProbe();
    return Promise.resolve({
      pluginReady: false,
      databaseReady: false,
      serviceReady: false,
      deviceId: 'browser-preview',
      details: ['Native Phase 0 checks require an Android build.'],
    });
  },

  sendProbe(): Promise<{ accepted: boolean; probeId: string }> {
    if (Capacitor.isNativePlatform()) return nativePlugin.sendProbe();
    return Promise.resolve({ accepted: false, probeId: crypto.randomUUID() });
  },

  plugin: nativePlugin,
};
