# Discussion Plugin — Pending Architecture Changes
_Last updated: 2026-04-05_

---

## Background: What We Found While Debugging WebRTC

Attempting to fix a guest "Timed out waiting for host answer" error exposed two
fundamental architectural problems — one in the Discussion plugin, one in the
platform itself.

---

## Problem 1: Web Locks Leader Election (Discussion Plugin)

### What it does now
`listenForSync()` in `index.js` uses the Web Locks API to elect a single "leader"
tab. The leader tab handles all relay messages (`create-room`, `close-room`,
`invite-member`) and runs the WebRTC polling loop. Other tabs wait behind the lock.

### Why it's broken
1. **Multiple calls per tab.** The platform calls `bootstrap()` on every SPA route
   navigation. Each call queues another lock request. The `unload` event that was
   meant to release the lock never fires in a SPA. Result: 18+ queued lock
   requests in a single tab, only the very first one ever executes.

2. **Wrong tab wins.** The lock is first-come-first-served across the origin. If
   the user has two community tabs open (different channels, different pages), a
   background tab becomes the leader. All session activity happens there silently.

3. **Popup windows compete for the lock.** Because popups load the full SPA (see
   Problem 2), they also call `bootstrap()`, which calls `listenForSync()`, which
   queues another lock request. Popups compete with main tabs for leadership.

### Proposed fix: session lives in the streaming popup
The streaming control popup is open exactly as long as the host wants a session.
It knows its channel. It should own the session directly — no relay, no leader
election.

- **`DiscussionControls.vue`** gets all session management: `apiFetch`, room
  creation, WebRTC polling, `connectPeer`, `sanitizeSdp`, the retry loop.
- **When a guest's track arrives**, the popup registers it in the main window via
  the popup–main messaging system (see "Popup ↔ Main Window Communication" below).
- **`index.js` (main window)** keeps only: media slot management, stream
  registration handler, `DiscussionNotifier` zone component, invite notification
  polling.
- **BroadcastChannel** kept only for: invite notifications to the notifier
  component, state display in other open tabs. Not used for session relay.
- **`listenForSync()` and Web Locks removed entirely.**
- **Guard:** All main-window-only logic gated on `window.opener === null` instead
  of URL param checks (more robust, covers all popup types).

---

## Problem 2: Popups Load the Full SPA (Platform)

### What happens now
Plugin popups (streaming controls, guest join window, any future plugin popup) are
opened as new windows pointing to the community SPA URL with query parameters
(e.g. `?popup=stream-control`, `?participants_join=UUID`). The full Vue SPA loads
— all routes, all plugins, all `bootstrap()` calls — before the popup content is
overlaid. This is slow, wasteful, and causes Problem 1.

### Proposed fix: plugin-declared popup registry

Extend `plugin.json` so plugins declare their popup resources and control panel
contributions. The platform builds a popup registry at install time.

**Example — Discussion plugin `plugin.json`:**
```json
{
  "name": "Discussion",
  "slug": "participants",
  "entry": "index.js",
  "zones": ["channel-header"],
  "popups": [
    {
      "param": "participants_join",
      "component": "ParticipantWindow",
      "title": "Join Discussion"
    }
  ],
  "controls": [
    {
      "popup": "stream-control",
      "component": "DiscussionControls"
    }
  ],
  "requires": {
    "tables": ["participants_rooms", "participants_invites"]
  }
}
```

**Example — Advanced Streaming plugin `plugin.json`:**
```json
{
  "popups": [
    {
      "param": "popup",
      "value": "stream-control",
      "title": "Streaming Controls",
      "accepts_controls": true
    }
  ]
}
```

`accepts_controls: true` means other plugins can contribute panels to this popup.
No plugin needs to know about any other plugin by name — the platform assembles
the registry from all manifests at install time.

### Platform responsibilities
1. **At plugin install/update** — rebuild the popup registry from all installed
   `plugin.json` manifests.
2. **On any page load** — before loading the SPA, check the URL against the popup
   registry. If matched:
   - Serve a lightweight popup shell (no SPA bootstrap, no router, no zone
     components, no auth flow)
   - Load only the owning plugin's entry script + contributing plugins' entries
   - Mount only the declared component with a minimal API surface (auth token,
     channel context, basic methods)
3. **Plugin `bootstrap()`** — never called in popup contexts. No more URL param
     sniffing in plugin code. `if (params.get('popup') === ...) return` hacks
     eliminated.

---

## Popup ↔ Main Window Communication

Popups need to control the main window (register media streams, update UI state).
The mechanism depends on the relationship:

### Popup → its opener (direct)
A popup opened via `window.open()` has `window.opener` as a direct JS reference
to the tab that opened it (same origin = full access).

```js
// In popup — register a guest's MediaStream in the main tab's slot system
// MediaStream objects CAN be passed this way (same-origin direct call, native object)
window.opener.__eluthDiscussion.registerStream(memberId, stream)
window.opener.__eluthDiscussion.unregisterStream(memberId)
window.opener.__eluthDiscussion.updatePeers(peersArray)
```

```js
// In main tab (index.js bootstrap) — register the handler
window.__eluthDiscussion = {
  registerStream(memberId, stream) { /* put stream into media slot */ },
  unregisterStream(memberId)       { /* clear slot */ },
  updatePeers(peers)               { /* update notifier UI state */ },
}
```

This works because:
- Same origin → no cross-origin restrictions
- `MediaStream` is a native browser object — it passes across window boundaries
  by reference, unlike structured-clone (which `postMessage` uses and which cannot
  clone MediaStream)
- No message queue needed for synchronous calls; async calls can return Promises

### Popup → all tabs (broadcast)
For notifying all open community tabs (e.g. "session ended", "new peer connected")
BroadcastChannel continues to work fine. The popup broadcasts; all tabs receive.

### Main tab → popup (reverse)
`window.opener` is one-directional. For the main tab to call into the popup:
- The popup registers itself on `window.opener` when it opens:
  ```js
  // In popup onMounted
  if (window.opener?.__eluthDiscussion) {
    window.opener.__eluthDiscussion.streamingPopup = {
      notifySessionState(state) { /* update local UI */ }
    }
  }
  ```
- Or use `BroadcastChannel` for main → popup messages (popup listens on the
  same channel it already uses for compositor state).

### Summary
| Direction | Mechanism | Passes MediaStream? |
|-----------|-----------|-------------------|
| Popup → opener (streams/state) | `window.opener.__eluthDiscussion.*()` | ✅ Yes |
| Popup → all tabs (broadcast) | `BroadcastChannel` | ❌ No |
| Main → popup (UI updates) | `BroadcastChannel` or opener-registered ref | ❌ No (not needed for streams) |

---

## Execution Order

**Platform first, then plugins.** The platform update fixes the root cause for
all plugins simultaneously. Individual plugin migrations happen after the platform
lands and the popup shell API is defined.

---

## Track 1 — Platform (community app) — DO FIRST

- [ ] Design popup registry data structure (built from `plugin.json` manifests)
- [ ] Add popup registry builder to plugin install/update pipeline
- [ ] Build lightweight popup shell (separate entry point, no SPA bootstrap)
- [ ] Define standard popup API surface (`window.__eluthPopup`:
      `getAuthToken()`, `getChannelId()`, `close()`, etc.)
- [ ] Platform serves popup shell for registered popup URLs
- [ ] Stop calling `bootstrap()` in popup contexts entirely
- [ ] Document the popup shell API for plugin authors

---

## Track 2 — Plugin audit & migration — AFTER Track 1

Every plugin that uses popups needs auditing. For each one:
1. Declare popups in `plugin.json` (`"popups"` and/or `"controls"`)
2. Remove any URL-param popup detection hacks from `bootstrap()`
3. If popup needs to pass data back to main window: register
   `window.__eluth{PluginName}` API in main bootstrap, call via `window.opener`

**Known plugins to audit (check each for popup usage):**
- [ ] **Discussion** (`participants`) — `?participants_join`, controls in `stream-control`
- [ ] **Advanced Streaming** — owns `?popup=stream-control`, `accepts_controls: true`
- [ ] All other installed plugins — check `plugin.json` and `bootstrap()` for
      any `params.get('popup')` or similar URL sniffing

**Discussion plugin specifics (most complex migration):**
- [ ] Move session management into `DiscussionControls.vue`
  - `apiFetch`, room creation, `startSession`, `stopSession`
  - WebRTC polling loop, `connectPeer`, `sanitizeSdp` + retry loop
  - `waitForIce`, `waitForConnection`
  - Member invite via direct API call (no relay)
- [ ] Register `window.__eluthDiscussion` API in `index.js` bootstrap
- [ ] Use `window.opener.__eluthDiscussion.registerStream()` for incoming tracks
- [ ] Remove `listenForSync()`, Web Locks, all relay message handling from `index.js`
- [ ] Gate all main-window logic on `window.opener === null`
- [ ] Update `plugin.json` with `popups` and `controls` declarations
- [ ] Remove debug/diagnostic logs added during debugging (v2.0.29–v2.0.31)
- [ ] Verify SDP sanitisation + retry loop works end-to-end

---

## SDP Sanitisation Status (as of v2.0.31)

The retry loop approach in `sanitizeSdp` (stripping bad codecs from the error
message and retrying `setRemoteDescription`) is correct but has never been properly
tested because the session was always running in the wrong tab. Once Track 2 is
complete and the session runs in the popup, this should be re-tested from scratch.

Known bad codecs (force-stripped regardless of `getCapabilities`):
- `ulpfec`, `red`, `flexfec-03` — FEC codecs, cause cross-browser parse failures
- `H265` — advertised by Brave/Chrome `getCapabilities` but silently rejected in
  `setRemoteDescription` on many platforms

The `getCapabilities`-based dynamic filtering was removed (v2.0.28) because it
stripped all video codecs in the plugin execution context. The current approach:
static strip of known-bad codecs + error-driven retry loop for anything else.
