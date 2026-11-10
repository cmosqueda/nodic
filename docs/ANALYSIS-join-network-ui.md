# Analysis: join/connection bugs, bottom-nav overlap, Network complexity

## 1. Join-by-code / membership bugs
Files: `src/app/workspace-context.tsx` (joinChannelWithCode ~743, JOIN_REQUESTED handler ~214),
`src/db/repository.ts` (joinChannel 1837, processJoinRequest 3166, handleIncomingJoinRequest 3296).

1. **False success.** `joinChannelWithCode` calls `repository.joinChannel()` (inserts the channel, self as
   MEMBER and the lead into SQLite/memory) *before* the lead has approved. It then returns
   `success: true` even though `publishEvent` is fire-and-forget. If the lead is offline, the invite is
   wrong/used/expired, or the send fails, the joiner still sees a channel they were never admitted to.
2. **No reply path.** The lead's `handleIncomingJoinRequest` returns `accepted:false, reason` but nothing is
   sent back. The joiner never learns about "expired", "already used" or "bad secret". Stuck "joined" ghost channel.
3. **Channel key never delivered.** `processJoinRequest` returns `channelKey`, but the JOIN_REQUESTED handler drops it.
   The joiner has no key for the channel, so encrypted history/chat cannot be decrypted until a later rotation.
4. **Hidden prerequisite.** Join requires the devices to be paired first (Network > Connect by Nodic ID) and
   the error message just tells the user to go do it. Two flows for one intent.
5. **Invite is single-use but state is device-local.** `storedInvitations` lives only on the lead device; the
   lead's `leadEndpoint` is in the code but never used to auto-connect. Reusing a code, or a lead reinstall, = silent reject.
6. **Joiner-side race.** The `MEMBER_ADDED` event for the joiner is applied via `applyEvent`, which quarantines
   events for unknown channels. This only works because bug 1 pre-creates the channel. Fixing 1 requires
   a "pending join" state that accepts the lead's admission reply.
7. **UI.** Join modal is duplicated in both MembersPage branches; the "Join" button shows to members already in a
   channel; `Sync`/`Join`/`Invite` crowd the header on narrow screens.

### Proposed fix
- Add `pendingJoin` state (`REQUESTED -> ADMITTED | REJECTED | TIMEOUT`), no channel rows until ADMITTED.
- New transient events `JOIN_ACCEPTED {memberEvent, wrappedChannelKey, history}` / `JOIN_REJECTED {reason}`
  sent lead -> applicant; applicant creates channel only on ACCEPTED.
- Invite code carries `leadEndpoint`; joining auto-pairs with the lead (implicit pairing, no separate step).
- 30 s timeout with "Lead not reachable. Ask them to open Nodic" + retry.
- Extract one `<JoinChannelSheet>`; show Join only when not in a channel (or under a menu).

## 2. Bottom content hidden by tab bar
`app.css`: `.main-stage` reserves a hard-coded `66px + safe-area` while `.mobile-nav` height varies
(font scale, gesture bar, `env()` returning 0 in WebView). Page content (`.page-wrap` 32px) and the Board
FAB/sheets are then partly covered; `.mobile-nav` is `position:fixed; z-index:99999` which also sits over modals' lower edge.
Fix: single `--nav-h` variable (measured with ResizeObserver in AppShell), `padding-bottom: calc(var(--nav-h) + 16px)`
on `.main-stage`, `scroll-padding-bottom`, drop `!important`s, nav z-index below modal/sheet layers
(modals 100001+), sheets/composers use `bottom: var(--nav-h)`.

## 3. Network page is too complex
NetworkPage.tsx (583 lines) shows 5 cards: Device, Pairing requests, Connect by ID, Saved connections,
Nearby devices, plus summary strip and diagnostics. Users must understand pairing vs channel vs sync.
Simplify to: **My ID (copy/QR) -> Nearby people (one "Connect" button) -> Requests (Accept/Decline)**;
status is a single line ("Connected to 2 people"); saved connections + diagnostics under "Advanced".
Joining a channel connects automatically, so most users never open this page.

See `prototype-guided-flow.html` for the target flow.
