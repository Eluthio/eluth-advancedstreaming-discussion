import { createApp } from 'vue'
import DiscussionControls from './DiscussionControls.vue'
import ParticipantWindow from './ParticipantWindow.vue'

// ── Shared state (main window + popup share the same module scope) ─────────────
// In the popup window the module re-executes, so _store is separate per window.
// Communication between windows uses BroadcastChannel.
const _store = {
    api:          null,   // { authToken, apiBase } from bootstrap()
    channelId:    null,   // set by DiscussionControls popup → broadcast to main window
    session:      null,   // { roomId, canvasStream, peers, pollTimer }
    stateCallback: null,
    syncBc:       null,   // BroadcastChannel('eluth-discussion-sync')
}

// ── Canvas grid compositor ────────────────────────────────────────────────────
let _canvas = null
let _ctx    = null
let _rafId  = null
const _peerEls = {}  // memberId → <video>

function ensureCanvas() {
    if (_canvas) return
    _canvas = document.createElement('canvas')
    _canvas.width  = 1280
    _canvas.height = 720
    _ctx = _canvas.getContext('2d')
    startDrawLoop()
}

function startDrawLoop() {
    const loop = () => {
        drawGrid()
        _rafId = requestAnimationFrame(loop)
    }
    _rafId = requestAnimationFrame(loop)
}

function drawGrid() {
    if (!_ctx) return
    _ctx.fillStyle = '#111'
    _ctx.fillRect(0, 0, 1280, 720)

    const peers  = _store.session?.peers ?? []
    const active = peers.filter(p => p.state === 'connected' && _peerEls[p.memberId])

    if (!active.length) {
        _ctx.fillStyle = 'rgba(255,255,255,0.12)'
        _ctx.font = '22px sans-serif'
        _ctx.textAlign = 'center'
        _ctx.textBaseline = 'middle'
        _ctx.fillText('Waiting for participants…', 640, 360)
        return
    }

    const n    = active.length
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : 3
    const rows = Math.ceil(n / cols)
    const w    = Math.floor(1280 / cols)
    const h    = Math.floor(720  / rows)

    active.forEach((p, i) => {
        const el  = _peerEls[p.memberId]
        const col = i % cols
        const row = Math.floor(i / cols)
        const x   = col * w
        const y   = row * h

        if (el && el.readyState >= 2) {
            try { _ctx.drawImage(el, x, y, w, h) } catch { /* unavailable */ }
        } else {
            _ctx.fillStyle = '#1a1f2e'
            _ctx.fillRect(x, y, w, h)
        }

        // Name label
        _ctx.fillStyle = 'rgba(0,0,0,0.6)'
        _ctx.fillRect(x, y + h - 26, w, 26)
        _ctx.fillStyle = '#fff'
        _ctx.font = '13px sans-serif'
        _ctx.textAlign = 'left'
        _ctx.textBaseline = 'middle'
        _ctx.fillText(p.username, x + 8, y + h - 13)
    })
}

// ── WebRTC: host side ─────────────────────────────────────────────────────────
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
const _answered  = new Set()  // memberIds we've already sent an answer to

async function startSession(roomId) {
    const authToken = localStorage.getItem('eluth_token') ?? ''

    function apiCall(method, path, body) {
        return fetch(path, {
            method,
            headers: { Authorization: `Bearer ${authToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        }).then(r => r.json())
    }

    const peers = []
    const pollTimer = setInterval(async () => {
        let data
        try {
            const res = await apiCall('GET', `/api/plugin-rooms/participants/${roomId}`)
            data = res.room?.data ?? {}
        } catch { return }

        for (const [key, offerSdp] of Object.entries(data)) {
            if (!key.endsWith('_offer') || typeof offerSdp !== 'string') continue
            const memberId = key.slice(0, -6)
            if (_answered.has(memberId)) continue
            _answered.add(memberId)
            const username = data[`${memberId}_username`] ?? 'Participant'
            connectPeer(memberId, username, offerSdp, roomId, peers, apiCall)
        }

        // Remove peers that signalled disconnect
        for (const peer of peers.slice()) {
            if (data[`${peer.memberId}_status`] === 'disconnected') removePeer(peer.memberId, peers)
        }

        notifyState()
        _store.syncBc?.postMessage({ type: 'peers-update', peers: peers.map(({ memberId, username, state }) => ({ memberId, username, state })) })
    }, 2000)

    _store.session = { roomId, peers, pollTimer, canvasStream: _canvas.captureStream(30) }
    notifyState()
    return _store.session.canvasStream
}

async function connectPeer(memberId, username, offerSdp, roomId, peers, apiCall) {
    const pc = new RTCPeerConnection(RTC_CONFIG)

    const peer = { memberId, username, pc, state: 'connecting', stream: null }
    peers.push(peer)
    notifyState()

    pc.onconnectionstatechange = () => {
        const s = pc.connectionState
        peer.state = s === 'connected' ? 'connected'
            : (s === 'failed' || s === 'disconnected' || s === 'closed') ? 'failed'
            : 'connecting'
        notifyState()
        _store.syncBc?.postMessage({ type: 'peers-update', peers: peers.map(({ memberId, username, state }) => ({ memberId, username, state })) })
    }

    pc.ontrack = (e) => {
        peer.stream = e.streams[0] ?? new MediaStream([e.track])
        const el = _peerEls[memberId]
        if (el) { el.srcObject = peer.stream; el.play().catch(() => {}) }
        else {
            // Create hidden video element
            const vid = document.createElement('video')
            vid.autoplay = true; vid.muted = true; vid.playsInline = true
            Object.assign(vid.style, { position: 'absolute', width: '1px', height: '1px', top: '-9999px', opacity: '0' })
            document.body.appendChild(vid)
            vid.srcObject = peer.stream
            vid.play().catch(() => {})
            _peerEls[memberId] = vid
        }
    }

    try {
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await waitForIce(pc)
        await apiCall('PUT', `/api/plugin-rooms/participants/${roomId}/data`, {
            data: { [`${memberId}_answer`]: pc.localDescription.sdp },
        })
    } catch (e) {
        console.warn('[Discussion] connectPeer failed', memberId, e)
        peer.state = 'failed'
        notifyState()
    }
}

function waitForIce(pc) {
    return new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') { resolve(); return }
        const check = () => {
            if (pc.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', check)
                resolve()
            }
        }
        pc.addEventListener('icegatheringstatechange', check)
        setTimeout(resolve, 8000)  // safety timeout
    })
}

function removePeer(memberId, peers) {
    const idx = peers.findIndex(p => p.memberId === memberId)
    if (idx === -1) return
    peers[idx].pc?.close()
    peers.splice(idx, 1)
    _peerEls[memberId]?.remove()
    delete _peerEls[memberId]
    _answered.delete(memberId)
}

function endSession() {
    if (!_store.session) return
    clearInterval(_store.session.pollTimer)
    for (const peer of _store.session.peers) { peer.pc?.close() }
    for (const el of Object.values(_peerEls)) el?.remove()
    for (const k of Object.keys(_peerEls)) delete _peerEls[k]
    _answered.clear()
    _store.session = null
    notifyState()
}

function notifyState() {
    _store.stateCallback?.({ ..._buildState() })
}

function _buildState() {
    return {
        active:   !!_store.session,
        roomId:   _store.session?.roomId ?? null,
        peers:    _store.session?.peers?.map(({ memberId, username, state }) => ({ memberId, username, state })) ?? [],
        channelId: _store.channelId,
    }
}

// ── BroadcastChannel listener (main window only) ──────────────────────────────
function listenForSync() {
    _store.syncBc = new BroadcastChannel('eluth-discussion-sync')
    _store.syncBc.onmessage = async (e) => {
        const msg = e.data
        if (!msg?.type) return
        switch (msg.type) {
            case 'channel-context':
                _store.channelId = msg.channelId
                break
            case 'session-started':
                _store.channelId = msg.channelId
                ensureCanvas()
                startSession(msg.roomId)
                break
            case 'session-ended':
                endSession()
                break
            case 'request-state':
                _store.syncBc.postMessage({ type: 'state', ..._buildState() })
                break
            // Popup asks main window to create a room (popup has no auth token)
            case 'create-room': {
                const { channelId } = msg
                try {
                    const authToken = localStorage.getItem('eluth_token') ?? ''
                    const res = await fetch('/api/plugin-rooms/participants', {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ channel_id: channelId, max_players: 8 }),
                    })
                    const data = await res.json()
                    if (!res.ok) throw new Error(data.message ?? `HTTP ${res.status}`)
                    const roomId = data.room?.id
                    if (!roomId) throw new Error('No room ID returned')
                    _store.channelId = channelId
                    ensureCanvas()
                    startSession(roomId)
                    _store.syncBc.postMessage({ type: 'room-created', roomId, channelId })
                } catch (err) {
                    _store.syncBc.postMessage({ type: 'room-error', error: err.message })
                }
                break
            }
            // Popup asks main window to post invite link to chat
            case 'share-to-chat': {
                const { channelId: cid, joinUrl } = msg
                try {
                    const authToken = localStorage.getItem('eluth_token') ?? ''
                    await fetch(`/api/channels/${cid}/messages`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: joinUrl }),
                    })
                } catch { /* ignore */ }
                break
            }
            // Popup asks main window to close a room
            case 'close-room': {
                const { roomId } = msg
                try {
                    const authToken = localStorage.getItem('eluth_token') ?? ''
                    await fetch(`/api/plugin-rooms/participants/${roomId}/close`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${authToken}` },
                    })
                } catch { /* ignore */ }
                endSession()
                _store.syncBc.postMessage({ type: 'room-closed' })
                break
            }
        }
    }
}

// ── Plugin registration ───────────────────────────────────────────────────────
window.__EluthStreamSources = window.__EluthStreamSources || {}
window.__EluthStreamSources['participants'] = {
    label: 'Discussion',
    icon:  '👥',
    slug:  'participants',

    setStateCallback(cb) { _store.stateCallback = cb },

    async getStream() {
        ensureCanvas()
        // If session already running, return its stream
        if (_store.session) return _store.session.canvasStream
        // Return the canvas stream; session starts when DiscussionControls broadcasts 'session-started'
        return _canvas.captureStream(30)
    },

    getState() { return _buildState() },

    // Advanced streaming relays plex-* messages; for participants messages the controls
    // communicate directly via BroadcastChannel, so handleMessage is a no-op here.
    handleMessage(_msg) {},
}

window.__EluthPluginControls = window.__EluthPluginControls || {}
window.__EluthPluginControls['participants'] = DiscussionControls

window.__EluthPlugins = window.__EluthPlugins || {}
window.__EluthPlugins['participants'] = {
    zones: [],

    async bootstrap(api) {
        _store.api = api
        // Always expose api globally — DiscussionControls reads authToken from here.
        // This runs in every window context (main, streaming popup, join popup).
        window.__EluthDiscussionApi = api

        const params = new URLSearchParams(window.location.search)
        const joinRoomId = params.get('participants_join')

        // ── Participant join popup ──────────────────────────────────────────────
        if (joinRoomId) {
            document.title = 'Discussion — Joining'
            const div = document.createElement('div')
            div.id = 'pd-join-root'
            document.body.appendChild(div)
            createApp(ParticipantWindow, {
                roomId:    joinRoomId,
                authToken: localStorage.getItem('eluth_token') ?? '',
                apiBase:   api.apiBase ?? '/api',
            }).mount(div)
            return
        }

        // ── Advanced streaming control popup ───────────────────────────────────
        // DiscussionControls is mounted by the advanced streaming popup
        // infrastructure via window.__EluthPluginControls. Nothing to mount here.
        if (params.get('popup') === 'stream-control') return

        // ── Main window ────────────────────────────────────────────────────────
        // Listen for messages from the controls popup (session start/end, etc.)
        listenForSync()
        ensureCanvas()
    },

    // Render join URL as a card in chat
    messageRenderer: {
        pattern: /[?&]participants_join=[0-9a-f-]{36}/,
        render(url) {
            const m = url.match(/[?&]participants_join=([0-9a-f-]{36})/)
            if (!m) return null
            const roomId = m[1]
            const origin = window.__EluthStreamSources?.['participants']?._origin ?? window.location.origin
            return `<span class="pd-card">
                <span class="pd-card-icon">👥</span>
                <span class="pd-card-text">You&apos;ve been invited to a live discussion</span>
                <button class="pd-card-btn" onclick="(function(){
                    var o=window.__EluthStreamSources?.['participants']?._origin||window.location.origin;
                    window.open(o+'/?participants_join=${roomId}','pd-join-${roomId}','width=480,height=540');
                })()">Join</button>
            </span>`
        },
    },

    // Right-click a member → send them an invite
    contextMenuItems: [
        {
            label: '👥 Invite to Discussion',
            when: ({ isSelf }) => !isSelf,
            action({ channelId }) {
                const src = window.__EluthStreamSources?.['participants']
                if (!src?.getState?.().active) {
                    alert('Start a Discussion session first — open the streaming controls.')
                    return
                }
                const roomId = src.getState().roomId
                const origin = src._origin ?? window.location.origin
                const joinUrl = `${origin}/?participants_join=${roomId}`
                // Try to insert into the current channel's chat
                document.dispatchEvent(new CustomEvent('participants:invite', { detail: { channelId, joinUrl } }))
            },
        },
    ],
}

// Chat card styles
const style = document.createElement('style')
style.textContent = `
#pd-join-root {
    position: fixed; inset: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f1117;
}
.pd-card {
    display: inline-flex; align-items: center; gap: 10px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px; padding: 8px 14px; margin: 4px 0;
    font-size: 13px; color: rgba(255,255,255,0.85);
}
.pd-card-icon { font-size: 20px; }
.pd-card-text { flex: 1; }
.pd-card-btn {
    background: var(--accent, #a78bfa); color: #fff; border: none;
    border-radius: 5px; padding: 4px 14px; font-size: 12px; font-weight: 600;
    cursor: pointer; flex-shrink: 0;
}
.pd-card-btn:hover { opacity: 0.85; }
`
document.head.appendChild(style)
