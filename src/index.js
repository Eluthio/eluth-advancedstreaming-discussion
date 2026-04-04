import { createApp } from 'vue'
import DiscussionControls  from './DiscussionControls.vue'
import DiscussionNotifier  from './DiscussionNotifier.vue'
import ParticipantWindow   from './ParticipantWindow.vue'

// ── Constants ─────────────────────────────────────────────────────────────────
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

// ── Per-member slot management ────────────────────────────────────────────────
// Each member who ever connects gets a persistent MediaStream registered as a
// source in window.__EluthStreamSources with a stable key: participants-{memberId}
// The stream object never changes — blank placeholder tracks are swapped for
// live WebRTC tracks when the member connects, and back when they disconnect.
// Because the key is stable, the compositor's saved scene layout (which stores
// sourceKey) persists across sessions automatically.

const _memberSlots = new Map()  // memberId → { stream, blankVideo, blankAudio, pc, stateCallback }

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

// Returns the slotKey for this member, creating the source registration if new.
function ensureMemberSlot(memberId, username) {
    const slotKey = `participants-${memberId}`

    if (_memberSlots.has(memberId)) {
        // Update label if username changed
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
        pc:            null,
        stateCallback: null,
    })

    // Dynamically register a new compositor source for this member
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
            return { connected: !!s?.pc, username: s?.username ?? username }
        },

        handleMessage(_msg) {},
    }

    return slotKey
}

function disconnectMemberSlot(memberId) {
    const slot = _memberSlots.get(memberId)
    if (!slot) return

    slot.pc?.close()
    slot.pc = null

    // Restore blank placeholder tracks — keep source registered for next session
    for (const t of slot.stream.getTracks()) slot.stream.removeTrack(t)
    if (slot.blankVideo) slot.stream.addTrack(slot.blankVideo)
    if (slot.blankAudio) slot.stream.addTrack(slot.blankAudio)

    slot.stateCallback?.({ connected: false, username: slot.username })
}

// ── Base "Discussion" source ───────────────────────────────────────────────────
// Registered immediately so it appears in the source picker.
// Adding this source to a scene reveals the plugin control panel (DiscussionControls).
// Individual participant webcam sources appear dynamically as people connect.

window.__EluthStreamSources = window.__EluthStreamSources || {}
window.__EluthStreamSources['participants'] = {
    label: 'Discussion',
    icon:  '👥',
    slug:  'participants',

    setStateCallback(cb) { _store.stateCallback = cb },

    async getStream() {
        // Returns a minimal info canvas — updated as session state changes
        ensureInfoCanvas()
        return _store.infoStream
    },

    getState() {
        return {
            active: !!_sessions.size,
            connected: [..._memberSlots.values()].filter(s => !!s.pc).length,
        }
    },

    handleMessage(_msg) {},
}

// ── Info canvas (base source visual) ─────────────────────────────────────────
// Small canvas showing session status, drawn into the base "Discussion" source.

const _store = {
    stateCallback: null,
    infoCanvas:    null,
    infoCtx:       null,
    infoStream:    null,
}

function ensureInfoCanvas() {
    if (_store.infoCanvas) return
    const c   = document.createElement('canvas')
    c.width   = 320
    c.height  = 180
    const ctx = c.getContext('2d')
    _store.infoCanvas = c
    _store.infoCtx    = ctx
    _store.infoStream = c.captureStream(2)
    drawInfoCanvas()
}

function drawInfoCanvas() {
    const ctx = _store.infoCtx
    if (!ctx) return
    const active = [..._sessions.values()]
    const count  = [..._memberSlots.values()].filter(s => !!s.pc).length
    ctx.fillStyle = '#0f1117'
    ctx.fillRect(0, 0, 320, 180)
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.font      = 'bold 18px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(active.length ? `Discussion \u2022 ${count} connected` : 'Discussion', 160, 90)
}

// ── Sessions ──────────────────────────────────────────────────────────────────

const _sessions = new Map()  // channelId → session

function buildSessionState(channelId) {
    const session = _sessions.get(channelId)
    return {
        channelId,
        active:       !!session,
        pluginRoomId: session?.pluginRoomId ?? null,
        ourRoomId:    session?.ourRoomId    ?? null,
        peers: session?.peers.map(({ memberId, username, slotKey, state }) =>
            ({ memberId, username, slotKey, state })) ?? [],
    }
}

async function startSession(channelId, pluginRoomId, ourRoomId) {
    await stopSession(channelId)

    const session = { channelId, pluginRoomId, ourRoomId, answered: new Set(), peers: [], pollTimer: null }
    _sessions.set(channelId, session)

    const token = () => localStorage.getItem('eluth_token') ?? ''

    function apiFetch(method, path, body) {
        return fetch(path, {
            method,
            headers: {
                Authorization: `Bearer ${token()}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        }).then(r => r.json())
    }

    session.pollTimer = setInterval(async () => {
        let data
        try {
            const res = await apiFetch('GET', `/api/plugin-rooms/participants/${pluginRoomId}`)
            data = res.room?.data ?? {}
        } catch { return }

        for (const [key, offerSdp] of Object.entries(data)) {
            if (!key.endsWith('_offer') || typeof offerSdp !== 'string') continue
            const memberId = key.slice(0, -6)
            if (session.answered.has(memberId)) continue
            session.answered.add(memberId)
            const username = data[`${memberId}_username`] ?? 'Participant'
            connectPeer(session, memberId, username, offerSdp, pluginRoomId, apiFetch)
        }

        for (const peer of session.peers.slice()) {
            if (data[`${peer.memberId}_status`] === 'disconnected') removePeer(session, peer.memberId)
        }

        drawInfoCanvas()
        _syncBc?.postMessage({ type: 'peers-update', ...buildSessionState(channelId) })
    }, 2000)
}

async function stopSession(channelId) {
    const session = _sessions.get(channelId)
    if (!session) return
    clearInterval(session.pollTimer)
    for (const peer of session.peers) disconnectMemberSlot(peer.memberId)
    _sessions.delete(channelId)
    drawInfoCanvas()
    _syncBc?.postMessage({ type: 'room-closed', channelId, active: false, peers: [] })
}

// ── WebRTC host side ──────────────────────────────────────────────────────────

async function connectPeer(session, memberId, username, offerSdp, pluginRoomId, apiFetch) {
    const slotKey = ensureMemberSlot(memberId, username)
    const slot    = _memberSlots.get(memberId)
    const pc      = new RTCPeerConnection(RTC_CONFIG)
    slot.pc       = pc

    const peer = { memberId, username, slotKey, state: 'connecting' }
    session.peers.push(peer)
    _syncBc?.postMessage({ type: 'peers-update', ...buildSessionState(session.channelId) })

    pc.onconnectionstatechange = () => {
        const cs = pc.connectionState
        peer.state = cs === 'connected'   ? 'connected'
            : (cs === 'failed' || cs === 'disconnected' || cs === 'closed') ? 'failed'
            : 'connecting'
        slot.stateCallback?.({ connected: peer.state === 'connected', username })
        _syncBc?.postMessage({ type: 'peers-update', ...buildSessionState(session.channelId) })
        if (peer.state === 'failed') removePeer(session, memberId)
    }

    pc.ontrack = (e) => {
        const track = e.track
        if (track.kind === 'video') {
            slot.stream.getVideoTracks().forEach(t => slot.stream.removeTrack(t))
            slot.stream.addTrack(track)
        } else if (track.kind === 'audio') {
            slot.stream.getAudioTracks().forEach(t => slot.stream.removeTrack(t))
            slot.stream.addTrack(track)
        }
        slot.stateCallback?.({ connected: true, username })
    }

    try {
        await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await waitForIce(pc)
        await apiFetch('PUT', `/api/plugin-rooms/participants/${pluginRoomId}/data`, {
            data: { [`${memberId}_answer`]: pc.localDescription.sdp },
        })
    } catch (err) {
        console.warn('[Discussion] connectPeer failed:', memberId, err)
        peer.state = 'failed'
        removePeer(session, memberId)
    }
}

function removePeer(session, memberId) {
    const idx = session.peers.findIndex(p => p.memberId === memberId)
    if (idx === -1) return
    const peer = session.peers[idx]
    disconnectMemberSlot(peer.memberId)
    session.peers.splice(idx, 1)
    session.answered.delete(memberId)
    _syncBc?.postMessage({ type: 'peers-update', ...buildSessionState(session.channelId) })
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
        setTimeout(resolve, 8000)
    })
}

// ── BroadcastChannel relay (main window) ──────────────────────────────────────

let _syncBc = null

function listenForSync() {
    _syncBc = new BroadcastChannel('eluth-discussion-sync')
    _syncBc.onmessage = async (e) => {
        const msg = e.data
        if (!msg?.type) return

        const token = () => localStorage.getItem('eluth_token') ?? ''

        async function apiFetch(method, path, body) {
            const res = await fetch(path, {
                method,
                headers: {
                    Authorization: `Bearer ${token()}`,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            })
            let data = {}
            try { data = await res.json() } catch { /* non-JSON response (HTML error page etc.) */ }
            return { res, data }
        }

        switch (msg.type) {

            case 'create-room': {
                const { channelId } = msg
                try {
                    const { res: r1, data: d1 } = await apiFetch('POST', '/api/plugin-rooms/participants',
                        { channel_id: channelId, max_players: 12 })
                    if (!r1.ok) throw new Error(d1.message ?? `HTTP ${r1.status}`)
                    const pluginRoomId = d1.room?.id
                    if (!pluginRoomId) throw new Error('No plugin_room_id from platform')

                    const { res: r2, data: d2 } = await apiFetch('POST', '/api/plugins/participants/rooms',
                        { channel_id: channelId, plugin_room_id: pluginRoomId })
                    if (!r2.ok) throw new Error(d2.error ?? `HTTP ${r2.status}`)
                    const ourRoomId = d2.room?.id

                    await startSession(channelId, pluginRoomId, ourRoomId)
                    _syncBc.postMessage({ type: 'room-created', channelId, pluginRoomId, ourRoomId })
                } catch (err) {
                    _syncBc.postMessage({ type: 'room-error', error: err.message })
                }
                break
            }

            case 'close-room': {
                const { channelId, pluginRoomId, ourRoomId } = msg
                if (pluginRoomId) {
                    fetch(`/api/plugin-rooms/participants/${pluginRoomId}/close`, {
                        method: 'POST', headers: { Authorization: `Bearer ${token()}` },
                    }).catch(() => {})
                }
                if (ourRoomId) {
                    fetch(`/api/plugins/participants/rooms/${ourRoomId}`, {
                        method: 'DELETE', headers: { Authorization: `Bearer ${token()}` },
                    }).catch(() => {})
                }
                await stopSession(channelId)
                break
            }

            case 'invite-member': {
                const { ourRoomId, memberId, username } = msg
                try {
                    const { res, data } = await apiFetch('POST',
                        `/api/plugins/participants/rooms/${ourRoomId}/invite`,
                        { member_id: memberId, username })
                    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
                    _syncBc.postMessage({ type: 'invite-sent', memberId })
                } catch (err) {
                    _syncBc.postMessage({ type: 'invite-error', memberId, error: err.message })
                }
                break
            }

            case 'fetch-members': {
                const { channelId } = msg
                try {
                    const { data } = await apiFetch('GET', `/api/members?channel_id=${channelId}`)
                    _syncBc.postMessage({ type: 'members-data', channelId, members: data.members ?? data ?? [] })
                } catch {
                    _syncBc.postMessage({ type: 'members-error' })
                }
                break
            }

            case 'request-state': {
                const { channelId } = msg
                _syncBc.postMessage({ type: 'state', ...buildSessionState(channelId) })
                break
            }
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

    async bootstrap(api) {
        const params     = new URLSearchParams(window.location.search)
        const joinRoomId = params.get('participants_join')

        // ── Participant join popup ──────────────────────────────────────────
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

        // ── Streaming control popup — base source already registered ────────
        if (params.get('popup') === 'stream-control') return

        // ── Main window ─────────────────────────────────────────────────────
        listenForSync()
    },

    // Right-click a member → invite them to the active discussion in this channel
    contextMenuItems: [
        {
            label: '👥 Invite to Discussion',
            when: ({ isSelf }) => !isSelf,
            action({ channelId, memberId, author }) {
                const session = _sessions.get(channelId)
                if (!session) {
                    alert('Start a Discussion session first — open the streaming controls.')
                    return
                }
                const bc = new BroadcastChannel('eluth-discussion-sync')
                bc.postMessage({ type: 'invite-member', ourRoomId: session.ourRoomId, memberId, username: author ?? '' })
                bc.close()
            },
        },
    ],
}

// ── Global styles ─────────────────────────────────────────────────────────────
const style = document.createElement('style')
style.textContent = `
#pd-join-root {
    position: fixed; inset: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f1117;
}
`
document.head.appendChild(style)
