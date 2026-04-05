import DiscussionControls  from './DiscussionControls.vue'
import DiscussionNotifier  from './DiscussionNotifier.vue'
import ParticipantWindow   from './ParticipantWindow.vue'

// ── Per-member slot management ────────────────────────────────────────────────
// Each member who ever connects gets a persistent MediaStream registered as a
// compositor source with a stable key: participants-{memberId}.
// The stream object never changes — blank placeholder tracks are swapped for
// live WebRTC tracks when the popup calls window.__eluthDiscussion.registerStream(),
// and restored when unregisterStream() is called.
// Because the key is stable, saved scene layouts persist across sessions.

const _memberSlots = new Map()  // memberId → { stream, blankVideo, blankAudio, username, connected, stateCallback }

function createBlankVideoTrack() {
    const canvas = document.createElement('canvas')
    canvas.width  = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0f1117'
    ctx.fillRect(0, 0, 2, 2)
    const track = canvas.captureStream(1).getVideoTracks()[0]
    track._keepAlive = canvas   // prevent GC
    return track
}

function createBlankAudioTrack() {
    try {
        const ac   = new AudioContext()
        const dest = ac.createMediaStreamDestination()
        const gain = ac.createGain()
        gain.gain.value = 0
        gain.connect(dest)
        const track = dest.stream.getAudioTracks()[0]
        track._keepAlive = ac
        return track
    } catch {
        return null
    }
}

function ensureMemberSlot(memberId, username) {
    const slotKey = `participants-${memberId}`

    if (_memberSlots.has(memberId)) {
        const slot = _memberSlots.get(memberId)
        if (slot.username !== username) {
            slot.username = username
            const src = window.__EluthStreamSources?.[slotKey]
            if (src) src.label = `Discussion \u2014 ${username}\u2019s Webcam`
        }
        return slotKey
    }

    const blankVideo = createBlankVideoTrack()
    const blankAudio = createBlankAudioTrack()
    const stream = new MediaStream([blankVideo, blankAudio].filter(Boolean))

    _memberSlots.set(memberId, {
        stream,
        blankVideo,
        blankAudio,
        username,
        connected:     false,
        stateCallback: null,
    })

    window.__EluthStreamSources = window.__EluthStreamSources || {}
    window.__EluthStreamSources[slotKey] = {
        label: `Discussion \u2014 ${username}\u2019s Webcam`,
        icon:  '👥',
        slug:  'participants',

        setStateCallback(cb) {
            const s = _memberSlots.get(memberId)
            if (s) s.stateCallback = cb
        },

        async getStream() {
            return _memberSlots.get(memberId)?.stream ?? new MediaStream()
        },

        getState() {
            const s = _memberSlots.get(memberId)
            return { connected: !!s?.connected, username: s?.username ?? username }
        },

        handleMessage(_msg) {},
    }

    return slotKey
}

function disconnectMemberSlot(memberId) {
    const slot = _memberSlots.get(memberId)
    if (!slot) return
    slot.connected = false
    for (const t of slot.stream.getTracks()) slot.stream.removeTrack(t)
    if (slot.blankVideo) slot.stream.addTrack(slot.blankVideo)
    if (slot.blankAudio) slot.stream.addTrack(slot.blankAudio)
    slot.stateCallback?.({ connected: false, username: slot.username })
}

// ── Info canvas (base source visual) ─────────────────────────────────────────
// Small canvas showing session status, drawn into the base "Discussion" source.

const _store = {
    stateCallback:  null,
    infoCanvas:     null,
    infoCtx:        null,
    infoStream:     null,
    connectedCount: 0,
}

function ensureInfoCanvas() {
    if (_store.infoCanvas) return
    const c   = document.createElement('canvas')
    c.width   = 320
    c.height  = 180
    _store.infoCanvas = c
    _store.infoCtx    = c.getContext('2d')
    _store.infoStream = c.captureStream(2)
    drawInfoCanvas()
}

function drawInfoCanvas() {
    const ctx = _store.infoCtx
    if (!ctx) return
    ctx.fillStyle = '#0f1117'
    ctx.fillRect(0, 0, 320, 180)
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.font      = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
        _activeChannels.size
            ? `Discussion \u2022 ${_store.connectedCount} connected`
            : 'Discussion',
        160, 90,
    )
}

// ── Active channel tracking ───────────────────────────────────────────────────
// Updated from BroadcastChannel broadcasts sent by the popup (DiscussionControls.vue).

const _activeChannels = new Map()  // channelId → { pluginRoomId, ourRoomId }

// ── Main-window only: compositor source + cross-window API ────────────────────
// window.opener is non-null in popup contexts (opened via window.open).
// All code here must only run in the main community SPA tab.

if (!window.opener) {
    // Base "Discussion" compositor source.
    // Adding it to a scene reveals the Discussion control panel (DiscussionControls.vue).
    window.__EluthStreamSources = window.__EluthStreamSources || {}
    window.__EluthStreamSources['participants'] = {
        label: 'Discussion',
        icon:  '👥',
        slug:  'participants',

        setStateCallback(cb) { _store.stateCallback = cb },

        async getStream() {
            ensureInfoCanvas()
            return _store.infoStream
        },

        getState() {
            return {
                active:    _activeChannels.size > 0,
                connected: _store.connectedCount,
            }
        },

        handleMessage(_msg) {},
    }

    // Cross-window API — the streaming popup calls these via window.opener.__eluthDiscussion.
    // MediaStream cannot be cloned by postMessage (structured clone limitation), so a
    // direct same-origin function call is the only way to pass a live stream reference.
    window.__eluthDiscussion = {
        registerStream(memberId, stream, username) {
            const slotKey = ensureMemberSlot(memberId, username)
            const slot    = _memberSlots.get(memberId)
            if (!slot) return slotKey
            // Swap all tracks — called once per arriving track so the slot stays current
            for (const t of slot.stream.getTracks()) slot.stream.removeTrack(t)
            for (const t of stream.getTracks())      slot.stream.addTrack(t)
            slot.connected = true
            slot.stateCallback?.({ connected: true, username })
            return slotKey
        },

        unregisterStream(memberId) {
            disconnectMemberSlot(memberId)
        },
    }

    // Listen for state broadcasts from the popup.
    // The popup sends room-created / room-closed / peers-update on this channel
    // so that all open main-window tabs stay in sync (info canvas, context menu guard).
    const _stateBc = new BroadcastChannel('eluth-discussion-sync')
    _stateBc.onmessage = (e) => {
        const msg = e.data
        if (!msg?.type || !msg.channelId) return

        switch (msg.type) {
            case 'room-created':
                _activeChannels.set(msg.channelId, {
                    pluginRoomId: msg.pluginRoomId,
                    ourRoomId:    msg.ourRoomId,
                })
                _store.stateCallback?.({ active: true, connected: _store.connectedCount })
                drawInfoCanvas()
                break

            case 'room-closed':
                _activeChannels.delete(msg.channelId)
                _store.connectedCount = 0
                for (const peer of msg.peers ?? []) disconnectMemberSlot(peer.memberId)
                _store.stateCallback?.({ active: _activeChannels.size > 0, connected: 0 })
                drawInfoCanvas()
                break

            case 'peers-update':
                _store.connectedCount = (msg.peers ?? []).filter(p => p.state === 'connected').length
                _store.stateCallback?.({ active: _activeChannels.size > 0, connected: _store.connectedCount })
                drawInfoCanvas()
                break
        }
    }
}

// ── Plugin registration ───────────────────────────────────────────────────────

window.__EluthPluginControls = window.__EluthPluginControls || {}
window.__EluthPluginControls['participants'] = DiscussionControls

window.__EluthPlugins = window.__EluthPlugins || {}
window.__EluthPlugins['participants'] = {
    zones:     ['channel-header'],
    component: DiscussionNotifier,

    // Popup component — mounted by PopupShell when ?discuss_participantsjoin=<roomId> is present.
    // bootstrap() is never called in popup contexts.
    popupComponents: {
        ParticipantWindow,
    },

    async bootstrap(_api) {
        // All session management (room creation, WebRTC, invites) now lives in
        // DiscussionControls.vue, which runs inside the Advanced Streaming popup.
        // The main window only registers compositor sources and listens for
        // state broadcasts — all done above at script load time.
    },

    // Right-click a member → invite them to the active discussion in this channel.
    // Sends a command to the popup via a per-channel BroadcastChannel.
    contextMenuItems: [
        {
            label: '👥 Invite to Discussion',
            when: ({ isSelf }) => !isSelf,
            action({ channelId, memberId, author }) {
                if (!_activeChannels.has(channelId)) {
                    alert('Start a Discussion session first — open the streaming controls.')
                    return
                }
                const bc = new BroadcastChannel(`eluth-discussion-${channelId}`)
                bc.postMessage({ type: 'invite-member', memberId, username: author ?? '' })
                bc.close()
            },
        },
    ],
}
