import { createApp } from 'vue'
import DiscussionControls  from './DiscussionControls.vue'
import DiscussionNotifier  from './DiscussionNotifier.vue'
import ParticipantWindow   from './ParticipantWindow.vue'

// ── Constants ─────────────────────────────────────────────────────────────────
const SLOT_COUNT = 12
const SLOT_KEYS  = Array.from({ length: SLOT_COUNT }, (_, i) => `participants-${i + 1}`)
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

// ── Slot management ───────────────────────────────────────────────────────────
// Each slot is a pre-created MediaStream with blank placeholder tracks.
// When a participant connects, their live tracks are swapped in.
// The stream object reference never changes → compositor video element auto-updates.

let _slotsReady = false
const _slots = {}   // slotKey → { stream, blankVideo, blankAudio, memberId, username, pc, stateCallback }

function slotDefaultLabel(key) {
    return `Discussion — Seat ${key.split('-')[1]}`
}

function createBlankVideoTrack() {
    const canvas = document.createElement('canvas')
    canvas.width  = 2
    canvas.height = 2
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#0f1117'
    ctx.fillRect(0, 0, 2, 2)
    const track = canvas.captureStream(1).getVideoTracks()[0]
    track._keepAliveCanvas = canvas   // prevent GC
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
        track._keepAliveAc = ac   // prevent GC
        return track
    } catch {
        return null
    }
}

function initSlots() {
    if (_slotsReady) return
    _slotsReady = true

    for (const key of SLOT_KEYS) {
        const blankVideo = createBlankVideoTrack()
        const blankAudio = createBlankAudioTrack()
        const stream = new MediaStream([blankVideo, blankAudio].filter(Boolean))

        _slots[key] = {
            stream,
            blankVideo,
            blankAudio,
            memberId:      null,
            username:      null,
            pc:            null,
            stateCallback: null,
        }
    }
}

function findFreeSlot() {
    return SLOT_KEYS.find(k => !_slots[k]?.memberId) ?? null
}

function slotForMember(memberId) {
    return SLOT_KEYS.find(k => _slots[k]?.memberId === memberId) ?? null
}

function assignSlot(slotKey, memberId, username) {
    const slot = _slots[slotKey]
    slot.memberId = memberId
    slot.username = username
    const src = window.__EluthStreamSources?.[slotKey]
    if (src) src.label = `Discussion \u2014 ${username}\u2019s Webcam`
    slot.stateCallback?.({ occupied: true, memberId, username })
}

function releaseSlot(slotKey) {
    const slot = _slots[slotKey]
    if (!slot) return

    // Close peer connection
    slot.pc?.close()
    slot.pc = null

    // Restore blank tracks
    for (const t of slot.stream.getTracks()) slot.stream.removeTrack(t)
    if (slot.blankVideo) slot.stream.addTrack(slot.blankVideo)
    if (slot.blankAudio) slot.stream.addTrack(slot.blankAudio)

    slot.memberId = null
    slot.username = null

    const src = window.__EluthStreamSources?.[slotKey]
    if (src) src.label = slotDefaultLabel(slotKey)
    slot.stateCallback?.({ occupied: false, memberId: null, username: null })
}

// Register all 12 slot sources immediately so they appear in the compositor
// source picker. Actual stream objects are created lazily by initSlots().
window.__EluthStreamSources = window.__EluthStreamSources || {}
for (const key of SLOT_KEYS) {
    ;(function register(k) {
        window.__EluthStreamSources[k] = {
            label: slotDefaultLabel(k),
            icon:  '👥',
            slug:  'participants',

            setStateCallback(cb) {
                initSlots()
                _slots[k].stateCallback = cb
            },

            async getStream() {
                initSlots()
                return _slots[k].stream
            },

            getState() {
                const slot = _slots[k]
                if (!slot) return { occupied: false }
                return { occupied: !!slot.memberId, memberId: slot.memberId, username: slot.username }
            },

            handleMessage(_msg) {},
        }
    })(key)
}

// ── Sessions ──────────────────────────────────────────────────────────────────
// Multiple channels can have concurrent discussions, each session keyed by channelId.

const _sessions = new Map()  // channelId → session object

function getSession(channelId) {
    return _sessions.get(channelId) ?? null
}

function buildSessionState(channelId) {
    const session = _sessions.get(channelId)
    return {
        channelId,
        active:       !!session,
        pluginRoomId: session?.pluginRoomId ?? null,
        ourRoomId:    session?.ourRoomId    ?? null,
        peers:        session?.peers.map(({ memberId, username, slotKey, state }) =>
                          ({ memberId, username, slotKey, state })) ?? [],
    }
}

async function startSession(channelId, pluginRoomId, ourRoomId) {
    await stopSession(channelId)

    const session = {
        channelId,
        pluginRoomId,
        ourRoomId,
        answered: new Set(),
        peers:    [],
        pollTimer: null,
    }
    _sessions.set(channelId, session)

    const authToken = () => localStorage.getItem('eluth_token') ?? ''

    function apiFetch(method, path, body) {
        return fetch(path, {
            method,
            headers: {
                Authorization: `Bearer ${authToken()}`,
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

        // Handle new offers
        for (const [key, offerSdp] of Object.entries(data)) {
            if (!key.endsWith('_offer') || typeof offerSdp !== 'string') continue
            const memberId = key.slice(0, -6)
            if (session.answered.has(memberId)) continue
            session.answered.add(memberId)
            const username = data[`${memberId}_username`] ?? 'Participant'
            connectPeer(session, memberId, username, offerSdp, pluginRoomId, apiFetch)
        }

        // Handle disconnections
        for (const peer of session.peers.slice()) {
            if (data[`${peer.memberId}_status`] === 'disconnected') {
                removePeer(session, peer.memberId)
            }
        }

        _syncBc?.postMessage({ type: 'peers-update', ...buildSessionState(channelId) })
    }, 2000)

    return session
}

async function stopSession(channelId) {
    const session = _sessions.get(channelId)
    if (!session) return
    clearInterval(session.pollTimer)
    for (const peer of session.peers) releaseSlot(peer.slotKey)
    _sessions.delete(channelId)
    _syncBc?.postMessage({ type: 'room-closed', channelId, active: false, peers: [] })
}

// ── WebRTC host side ──────────────────────────────────────────────────────────

async function connectPeer(session, memberId, username, offerSdp, pluginRoomId, apiFetch) {
    initSlots()
    const slotKey = findFreeSlot()
    if (!slotKey) {
        console.warn('[Discussion] No free slots for', username)
        return
    }

    const slot = _slots[slotKey]
    const pc   = new RTCPeerConnection(RTC_CONFIG)
    slot.pc    = pc

    const peer = { memberId, username, slotKey, state: 'connecting' }
    session.peers.push(peer)
    assignSlot(slotKey, memberId, username)
    _syncBc?.postMessage({ type: 'peers-update', ...buildSessionState(session.channelId) })

    pc.onconnectionstatechange = () => {
        const cs = pc.connectionState
        peer.state = cs === 'connected' ? 'connected'
            : (cs === 'failed' || cs === 'disconnected' || cs === 'closed') ? 'failed'
            : 'connecting'
        slot.stateCallback?.({ occupied: true, memberId, username, state: peer.state })
        _syncBc?.postMessage({ type: 'peers-update', ...buildSessionState(session.channelId) })
        if (peer.state === 'failed') removePeer(session, memberId)
    }

    pc.ontrack = (e) => {
        const track = e.track
        // Swap incoming track into the slot's persistent MediaStream
        if (track.kind === 'video') {
            slot.stream.getVideoTracks().forEach(t => slot.stream.removeTrack(t))
            slot.stream.addTrack(track)
        } else if (track.kind === 'audio') {
            slot.stream.getAudioTracks().forEach(t => slot.stream.removeTrack(t))
            slot.stream.addTrack(track)
        }
        slot.stateCallback?.({ occupied: true, memberId, username })
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
    releaseSlot(peer.slotKey)
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

// ── BroadcastChannel relay (main window only) ─────────────────────────────────

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
            return { res, data: await res.json() }
        }

        switch (msg.type) {

            // ── Create room ─────────────────────────────────────────────────
            case 'create-room': {
                const { channelId } = msg
                try {
                    // 1. Create platform plugin-room (handles WebRTC signalling data)
                    const { res: r1, data: d1 } = await apiFetch('POST', '/api/plugin-rooms/participants',
                        { channel_id: channelId, max_players: 12 })
                    if (!r1.ok) throw new Error(d1.message ?? `HTTP ${r1.status}`)
                    const pluginRoomId = d1.room?.id
                    if (!pluginRoomId) throw new Error('No plugin_room_id from platform')

                    // 2. Create discussion room (tracks invites)
                    const { res: r2, data: d2 } = await apiFetch('POST', '/api/plugins/participants/rooms',
                        { channel_id: channelId, plugin_room_id: pluginRoomId })
                    if (!r2.ok) throw new Error(d2.error ?? `HTTP ${r2.status}`)
                    const ourRoomId = d2.room?.id

                    initSlots()
                    await startSession(channelId, pluginRoomId, ourRoomId)
                    _syncBc.postMessage({ type: 'room-created', channelId, pluginRoomId, ourRoomId })
                } catch (err) {
                    _syncBc.postMessage({ type: 'room-error', error: err.message })
                }
                break
            }

            // ── Close room ──────────────────────────────────────────────────
            case 'close-room': {
                const { channelId, pluginRoomId, ourRoomId } = msg
                // Close platform room
                if (pluginRoomId) {
                    fetch(`/api/plugin-rooms/participants/${pluginRoomId}/close`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token()}` },
                    }).catch(() => {})
                }
                // Close discussion room
                if (ourRoomId) {
                    fetch(`/api/plugins/participants/rooms/${ourRoomId}`, {
                        method: 'DELETE',
                        headers: { Authorization: `Bearer ${token()}` },
                    }).catch(() => {})
                }
                await stopSession(channelId)
                break
            }

            // ── Invite a specific member ────────────────────────────────────
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

            // ── Fetch channel members for the picker ────────────────────────
            case 'fetch-members': {
                const { channelId } = msg
                try {
                    const { data } = await apiFetch('GET', `/api/members?channel_id=${channelId}`)
                    _syncBc.postMessage({ type: 'members-data', channelId, members: data.members ?? data ?? [] })
                } catch (err) {
                    _syncBc.postMessage({ type: 'members-error', error: err.message })
                }
                break
            }

            // ── State request from popup ────────────────────────────────────
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
        const params      = new URLSearchParams(window.location.search)
        const joinRoomId  = params.get('participants_join')

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

        // ── Streaming control popup — sources are already registered ───────
        if (params.get('popup') === 'stream-control') return

        // ── Main window — start session management listener ─────────────────
        initSlots()
        listenForSync()
    },

    // Right-click a member → invite them to the active discussion in this channel
    contextMenuItems: [
        {
            label: '👥 Invite to Discussion',
            when: ({ isSelf }) => !isSelf,
            action({ channelId, memberId, author }) {
                // Find the active session for this channel
                const session = _sessions.get(channelId)
                if (!session) {
                    alert('Start a Discussion session first — open the streaming controls.')
                    return
                }
                // Send invite via BC relay through main window
                const bc = new BroadcastChannel('eluth-discussion-sync')
                bc.postMessage({
                    type:      'invite-member',
                    ourRoomId: session.ourRoomId,
                    memberId,
                    username:  author ?? '',
                })
                bc.close()
            },
        },
    ],
}

// Global styles
const style = document.createElement('style')
style.textContent = `
#pd-join-root {
    position: fixed; inset: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f1117;
}
`
document.head.appendChild(style)
