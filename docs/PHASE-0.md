# Phase 0 Feasibility Spike

## Automated status

- [x] Ionic React project scaffolded.
- [x] Protocol and native plugin contracts defined.
- [x] Drizzle SQLite schema defined.
- [x] Native SQLite adapter proven on an Android device.
- [x] Minimal Kotlin Capacitor plugin compiled into a debug APK.
- [x] Foreground service retained after UI closure.
- [x] NSD discovery proven between two physical devices.
- [x] Test event persisted and acknowledged.
- [x] Swipe-away, closed-UI background delivery, and notification tested.

## Verification Log

- **Status**: PASSED
- **Date**: 2026-11-05
- **Environment**: Two physical Android devices on local Wi-Fi.
- **Result**: Mutual NSD discovery established (`1 nearby peer`), Device B UI swiped away, probe event broadcast from Device A, received and acknowledged over TCP socket, stored in SQLite database, and incoming notification posted on Device B while UI closed. Phase 0 exit criteria fully satisfied.

## Physical-device prerequisites

1. JDK 21 (`C:\Program Files\Android\Android Studio\jbr` is available on the initial development machine).
2. Two Android devices with developer mode and USB debugging enabled.
3. Both devices on the same Wi-Fi network.
4. The access point permits client-to-client traffic and mDNS/NSD.
5. Nodic notification permission allowed.
6. For realistic testing, leave battery optimization enabled first, then compare with Nodic excluded.

## Exit test

1. Install the debug build on both devices.
2. Start Nodic networking on both.
3. Confirm each reports one discovered peer.
4. Close the receiving device's UI without force-stopping it.
5. Send a probe event from the first device.
6. Confirm the receiver's foreground service stores the event and posts a notification.
7. Reopen the receiver and confirm the probe appears in diagnostics.

Phase 0 passes only after this succeeds on physical hardware. Emulator-only success is insufficient.
