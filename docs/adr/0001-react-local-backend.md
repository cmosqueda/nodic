# ADR 0001: React UI and local backend boundary

- Status: Accepted
- Date: 2026-11-04

## Decision

Use Ionic React with TypeScript. The MVP has no cloud application server. Domain events, SQLite repositories, the native Android sync service, and the peer protocol collectively form the backend boundary.

Use Android NSD and framed TCP for the Phase 0 transport spike. This transport is replaceable and is not considered production-secure until authenticated encryption is added.

## Rationale

React provides a compact component and testing model. Keeping the backend local preserves Nodic's offline and department-LAN requirements. The early NSD/TCP spike tests the largest platform risk before security and full synchronization complexity are added.

## Consequences

- TypeScript and Kotlin need matching protocol fixtures.
- SQLite access must be safe across the web view and foreground service.
- A future cloud relay can implement the same event contract without becoming the source of truth.
