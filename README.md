# Nodic

Nodic is an Android-first, local-first team chat and Kanban app that synchronizes over a department Wi-Fi network.

## Development

```bash
npm install
npm run dev
npm test
npm run build
```

The web build uses demo data until native SQLite is available. Android uses Capacitor and the Nodic native sync plugin.

## Android

Capacitor 8 requires JDK 21. Android Studio's bundled JBR is suitable; configure `JAVA_HOME` to that JBR before invoking Gradle.

```bash
npm run android:sync
npm run android:open
```

The debug APK is produced at `android/app/build/outputs/apk/debug/app-debug.apk`.

Phase 0 status and physical-device instructions are tracked in [`docs/PHASE-0.md`](docs/PHASE-0.md).

## Architecture

- [`SPEC.md`](SPEC.md): product and technical source of truth
- [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md): wire and native plugin contracts
- [`docs/adr`](docs/adr): implementation decisions
