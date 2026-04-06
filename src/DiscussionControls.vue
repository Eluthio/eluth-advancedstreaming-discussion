<template>
    <div class="dc-root">

        <!-- ── Session control ────────────────────────────────────────────── -->
        <div class="dc-section">
            <div v-if="!session.active">
                <button class="dc-btn dc-btn--primary" :disabled="starting" @click="startSession">
                    {{ starting ? 'Starting…' : 'Start Discussion' }}
                </button>
                <div v-if="error" class="dc-error">{{ error }}</div>
            </div>
            <div v-else class="dc-row dc-row--spread">
                <div class="dc-row dc-row--gap">
                    <span class="dc-live-dot" />
                    <span class="dc-label-sm">Active · {{ activePeers.length }}/12</span>
                </div>
                <button class="dc-btn dc-btn--danger" @click="endSession">End Session</button>
            </div>
        </div>

        <!-- ── Invite members ─────────────────────────────────────────────── -->
        <div v-if="session.active" class="dc-section">
            <div class="dc-section-title">Invite Participants</div>
            <input
                class="dc-input"
                v-model="memberSearch"
                placeholder="Search channel members…"
                @focus="fetchMembers"
            />
            <div v-if="loadingMembers" class="dc-hint">Loading members…</div>
            <div v-else class="dc-member-list">
                <div
                    v-for="m in filteredMembers"
                    :key="m.id ?? m.member_id"
                    class="dc-member-row"
                >
                    <span class="dc-member-name">{{ m.username }}</span>
                    <span v-if="inviteState[m.id ?? m.member_id] === 'sending'" class="dc-badge dc-badge--sending">Sending…</span>
                    <span v-else-if="inviteState[m.id ?? m.member_id] === 'sent'"  class="dc-badge dc-badge--sent">Invited ✓</span>
                    <span v-else-if="inviteState[m.id ?? m.member_id] === 'error'" class="dc-badge dc-badge--error">Failed</span>
                    <button
                        v-else
                        class="dc-btn dc-btn--sm"
                        :disabled="peers.length >= 12"
                        @click="inviteMember(m)"
                    >Invite</button>
                </div>
                <div v-if="filteredMembers.length === 0 && memberSearch" class="dc-hint">No matches</div>
                <div v-if="members.length === 0 && !loadingMembers && !memberSearch" class="dc-hint">
                    Click the search box to load members
                </div>
            </div>
        </div>

        <!-- ── Connected participant sources ──────────────────────────────── -->
        <!-- Each participant's webcam is a separate compositor source.        -->
        <!-- They can be positioned individually here or via Auto-Layout.      -->
        <div v-if="session.active && peers.length" class="dc-section">
            <div class="dc-section-title">Webcam Sources</div>

            <div v-for="p in peers" :key="p.memberId" class="dc-cam-block">
                <!-- Header row -->
                <div class="dc-cam-header" @click="toggleExpanded(p.memberId)">
                    <span class="dc-peer-dot" :class="`dc-peer-dot--${p.state}`" />
                    <span class="dc-cam-name">{{ p.username }}</span>
                    <span class="dc-cam-hint">{{ layerForPeer(p) ? 'In scene' : 'Not in scene' }}</span>
                    <span class="dc-cam-caret">{{ expandedPeer === p.memberId ? '▲' : '▼' }}</span>
                </div>

                <!-- Expanded controls -->
                <div v-if="expandedPeer === p.memberId" class="dc-cam-detail">
                    <!-- Add to scene / remove -->
                    <div v-if="!layerForPeer(p)" class="dc-cam-row">
                        <button class="dc-btn dc-btn--add" @click="addToScene(p)">＋ Add to scene</button>
                    </div>
                    <div v-else class="dc-cam-row">
                        <span class="dc-in-scene-label">In scene</span>
                        <button class="dc-btn dc-btn--remove" @click="removeFromScene(p)">Remove</button>
                    </div>

                    <!-- Transform controls (only if in scene) -->
                    <template v-if="layerForPeer(p)">
                        <!-- Quick presets -->
                        <div class="dc-cam-row dc-cam-row--wrap">
                            <button
                                v-for="preset in PRESETS"
                                :key="preset.label"
                                class="dc-btn dc-btn--preset"
                                @click="applyPreset(p, preset)"
                            >{{ preset.label }}</button>
                        </div>

                        <!-- Fine-grained position -->
                        <div class="dc-xywh">
                            <div class="dc-xywh-row" v-for="field in ['x','y','w','h']" :key="field">
                                <label class="dc-xywh-label">{{ field.toUpperCase() }}</label>
                                <input
                                    type="number"
                                    class="dc-xywh-input"
                                    step="0.01" min="0" max="1"
                                    :value="peerTransform(p)[field]"
                                    @change="onTransformField(p, field, $event.target.value)"
                                />
                                <span class="dc-xywh-unit">×1</span>
                            </div>
                        </div>
                    </template>
                </div>
            </div>
        </div>

        <!-- ── Auto-layout ────────────────────────────────────────────────── -->
        <div v-if="session.active" class="dc-section">
            <div class="dc-section-title">Auto-Layout All</div>
            <div class="dc-form-row">
                <label class="dc-form-label">Align cams</label>
                <select class="dc-select" v-model="layout.align" @change="saveSettings">
                    <option value="right">Right edge</option>
                    <option value="left">Left edge</option>
                    <option value="top">Top edge</option>
                    <option value="bottom">Bottom edge</option>
                </select>
            </div>
            <div class="dc-form-row">
                <label class="dc-form-label">
                    Max per {{ isVerticalAlign ? 'column' : 'row' }}
                </label>
                <input
                    type="number"
                    class="dc-input dc-input--num"
                    v-model.number="layout.maxPer"
                    min="1"
                    max="6"
                    @change="saveSettings"
                />
            </div>
            <button
                class="dc-btn dc-btn--layout"
                :disabled="activePeers.length === 0 || applyingLayout"
                @click="applyLayout"
            >
                {{ applyingLayout ? 'Applying…' : 'Apply Layout' }}
            </button>
            <div v-if="layoutError" class="dc-error">{{ layoutError }}</div>
        </div>

    </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'

// ── Popup context ──────────────────────────────────────────────────────────────
const _popup    = window.__eluthPopup
const channelId = _popup?.getChannelId() ?? new URLSearchParams(window.location.search).get('channel') ?? ''

// ── Constants ──────────────────────────────────────────────────────────────────
const PRESETS = [
    { label: 'Small TL',    x: 0.01,  y: 0.01,  w: 0.22, h: 0.22 },
    { label: 'Small TR',    x: 0.77,  y: 0.01,  w: 0.22, h: 0.22 },
    { label: 'Small BL',    x: 0.01,  y: 0.77,  w: 0.22, h: 0.22 },
    { label: 'Small BR',    x: 0.77,  y: 0.77,  w: 0.22, h: 0.22 },
    { label: '½ Left',      x: 0,     y: 0,     w: 0.5,  h: 1    },
    { label: '½ Right',     x: 0.5,   y: 0,     w: 0.5,  h: 1    },
    { label: 'Full',        x: 0,     y: 0,     w: 1,    h: 1    },
]

const SETTINGS_KEY = `discussion-settings-${channelId}`
const RTC_CONFIG   = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

// ── State ──────────────────────────────────────────────────────────────────────
const session        = ref({ active: false, pluginRoomId: null, ourRoomId: null })
const peers          = ref([])
const members        = ref([])
const memberSearch   = ref('')
const loadingMembers = ref(false)
const membersLoaded  = ref(false)
const inviteState    = ref({})
const starting       = ref(false)
const error          = ref('')
const applyingLayout = ref(false)
const layoutError    = ref('')
const expandedPeer   = ref(null)
const compositorState = ref(null)
const layout = ref(loadSettings())

// Internal WebRTC state — not reactive, managed imperatively
const _pcs     = new Map()   // memberId → RTCPeerConnection
const _answered = new Set()  // memberIds already answered this session
let   _pollTimer = null

// ── Settings persistence ───────────────────────────────────────────────────────
function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
        return { align: s.align ?? 'right', maxPer: s.maxPer ?? 3 }
    } catch { return { align: 'right', maxPer: 3 } }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            align:  layout.value.align,
            maxPer: layout.value.maxPer,
        }))
    } catch { /* ignore */ }
}

// ── Computed ───────────────────────────────────────────────────────────────────
const isVerticalAlign = computed(() =>
    layout.value.align === 'right' || layout.value.align === 'left'
)

const activePeers = computed(() => peers.value.filter(p => p.state !== 'failed'))

const filteredMembers = computed(() => {
    const q       = memberSearch.value.trim().toLowerCase()
    const peerIds = new Set(peers.value.map(p => p.memberId))
    return members.value
        .filter(m => !peerIds.has(m.id ?? m.member_id))
        .filter(m => !q || m.username?.toLowerCase().includes(q))
})

function activeScene() {
    return compositorState.value?.scenes?.find(
        s => s.id === compositorState.value?.activeSceneId
    )
}

function layerForPeer(peer) {
    return activeScene()?.layers?.find(l => l.sourceKey === peer.slotKey) ?? null
}

function peerTransform(peer) {
    const layer = layerForPeer(peer)
    if (!layer) return { x: 0, y: 0, w: 0.22, h: 0.22 }
    return { x: round4(layer.x), y: round4(layer.y), w: round4(layer.w), h: round4(layer.h) }
}

function round4(n) { return Math.round((n ?? 0) * 10000) / 10000 }

// ── API helper ─────────────────────────────────────────────────────────────────
function apiFetch(method, path, body) {
    return fetch(path, {
        method,
        headers: {
            Authorization: `Bearer ${_popup?.getAuthToken() ?? ''}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async r => {
        let data = {}
        try { data = await r.json() } catch { /* non-JSON response */ }
        return { res: r, data }
    })
}

// ── SDP sanitisation ───────────────────────────────────────────────────────────
// Strips a=ssrc lines (Unified Plan doesn't need them; Brave privacy modes
// generate/reject them inconsistently).
// Proactively strips known-incompatible codecs (FEC family, H265) and their RTX
// chains — BUT only for media sections that have at least one surviving codec.
// If stripping would empty a section's m= line, that section is left untouched
// so the browser can at least attempt negotiation.
// extraBadPt: additional payload types from the setRemoteDescription retry loop.
function sanitizeSdp(sdp, extraBadPt = null) {
    const lines = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

    const BAD_CODECS = /^a=rtpmap:(\d+) (?:ulpfec|red|flexfec-03|H265)\//
    const badPt = new Set(extraBadPt ?? [])
    for (const l of lines) {
        const m = l.match(/^a=rtpmap:(\d+) /)
        if (m && BAD_CODECS.test(l)) badPt.add(m[1])
    }
    // Fixpoint: chase RTX chains — RTX whose apt= target is removed must also be removed
    let grew = true
    while (grew) {
        grew = false
        for (const l of lines) {
            const m = l.match(/^a=fmtp:(\d+) apt=(\d+)/)
            if (m && badPt.has(m[2]) && !badPt.has(m[1])) {
                badPt.add(m[1])
                grew = true
            }
        }
    }

    // Per-section safety: if stripping would leave a section with zero codecs,
    // exempt that section's payload types so it's passed through intact.
    for (const l of lines) {
        if (!l.startsWith('m=')) continue
        const pts      = l.split(' ').slice(3)
        const surviving = pts.filter(pt => !badPt.has(pt))
        if (surviving.length === 0) pts.forEach(pt => badPt.delete(pt))
    }

    return lines
        .filter(l => {
            if (/^a=ssrc[-:]/.test(l)) return false
            const pt = l.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)[ /]/)
            if (pt && badPt.has(pt[1])) return false
            return true
        })
        .map(l => {
            if (!l.startsWith('m=')) return l
            const parts = l.split(' ')
            const fmts  = parts.slice(3).filter(pt => !badPt.has(pt))
            return [...parts.slice(0, 3), ...fmts].join(' ')
        })
        .join('\r\n')
}

// ── ICE gathering ──────────────────────────────────────────────────────────────
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

// ── BroadcastChannels ──────────────────────────────────────────────────────────
let syncBc       = null   // sends room-created / room-closed / peers-update to main window tabs
let cmdBc        = null   // receives invite commands from the context menu
let compositorBc = null

function broadcastPeersUpdate() {
    syncBc?.postMessage({
        type: 'peers-update',
        channelId,
        peers: peers.value.map(({ memberId, username, slotKey, state }) =>
            ({ memberId, username, slotKey, state })),
    })
}

// ── Session management ─────────────────────────────────────────────────────────
async function startSession() {
    starting.value = true
    error.value    = ''
    try {
        // Create platform plugin-room (handles channel locking)
        let { res: r1, data: d1 } = await apiFetch('POST', '/api/plugin-rooms/participants',
            { channel_id: channelId })

        // 409 means a stale room exists — close it and retry once
        if (r1.status === 409 && d1.room?.id) {
            await apiFetch('POST', `/api/plugin-rooms/participants/${d1.room.id}/close`)
            ;({ res: r1, data: d1 } = await apiFetch('POST', '/api/plugin-rooms/participants',
                { channel_id: channelId }))
        }

        if (!r1.ok) throw new Error(d1.message ?? `HTTP ${r1.status}`)
        const pluginRoomId = d1.room?.id
        if (!pluginRoomId) throw new Error('No plugin_room_id from platform')

        // Create our own discussion room record
        const { res: r2, data: d2 } = await apiFetch('POST', '/api/plugins/participants/rooms',
            { channel_id: channelId, plugin_room_id: pluginRoomId })
        if (!r2.ok) throw new Error(d2.message ?? d2.error ?? `HTTP ${r2.status}`)
        const ourRoomId = d2.room?.id

        session.value = { active: true, pluginRoomId, ourRoomId }
        syncBc.postMessage({ type: 'room-created', channelId, pluginRoomId, ourRoomId })
        startPolling(pluginRoomId)
        fetchMembers()
    } catch (err) {
        error.value = 'Could not start: ' + (err.message ?? 'Unknown error')
    } finally {
        starting.value = false
    }
}

async function endSession() {
    const { pluginRoomId, ourRoomId } = session.value
    stopPolling()
    // Disconnect all peers before broadcasting room-closed
    for (const [memberId] of _pcs) removePeer(memberId)
    if (pluginRoomId) apiFetch('POST', `/api/plugin-rooms/participants/${pluginRoomId}/close`).catch(() => {})
    if (ourRoomId)    apiFetch('DELETE', `/api/plugins/participants/rooms/${ourRoomId}`).catch(() => {})
    session.value = { active: false, pluginRoomId: null, ourRoomId: null }
    syncBc.postMessage({ type: 'room-closed', channelId, peers: [] })
}

// ── Polling ────────────────────────────────────────────────────────────────────
function startPolling(pluginRoomId) {
    stopPolling()
    _pollTimer = setInterval(() => pollRoom(pluginRoomId), 2000)
}

function stopPolling() {
    clearInterval(_pollTimer)
    _pollTimer = null
}

async function pollRoom(pluginRoomId) {
    let data
    try {
        const { res, data: d } = await apiFetch('GET', `/api/plugin-rooms/participants/${pluginRoomId}`)
        if (!res.ok || !d.room) return
        data = d.room.data ?? {}
    } catch { return }

    for (const [key, offerSdp] of Object.entries(data)) {
        if (!key.endsWith('_offer') || typeof offerSdp !== 'string') continue
        const memberId = key.slice(0, -6)
        if (_answered.has(memberId)) continue
        _answered.add(memberId)
        const username = data[`${memberId}_username`] ?? 'Participant'
        connectPeer(memberId, username, offerSdp, pluginRoomId)
    }

    for (const peer of peers.value.slice()) {
        if (data[`${peer.memberId}_status`] === 'disconnected') removePeer(peer.memberId)
    }

    broadcastPeersUpdate()
}

// ── WebRTC ─────────────────────────────────────────────────────────────────────
async function connectPeer(memberId, username, offerSdp, pluginRoomId) {
    const slotKey = `participants-${memberId}`
    const pc = new RTCPeerConnection(RTC_CONFIG)
    _pcs.set(memberId, pc)

    const peer = { memberId, username, slotKey, state: 'connecting' }
    peers.value.push(peer)
    broadcastPeersUpdate()

    pc.onconnectionstatechange = () => {
        const peerEntry = peers.value.find(p => p.memberId === memberId)
        if (!peerEntry) return
        const cs = pc.connectionState
        peerEntry.state = cs === 'connected'   ? 'connected'
            : (cs === 'failed' || cs === 'disconnected' || cs === 'closed') ? 'failed'
            : 'connecting'
        broadcastPeersUpdate()
        if (peerEntry.state === 'failed') removePeer(memberId)
    }

    // Accumulate arriving tracks into a single stream — ontrack fires once per track
    // (video first, then audio). We call registerStream on each arrival so the
    // compositor slot gets updated progressively.
    const incomingStream = new MediaStream()
    pc.ontrack = (e) => {
        incomingStream.addTrack(e.track)
        if (window.opener?.__eluthDiscussion) {
            window.opener.__eluthDiscussion.registerStream(memberId, incomingStream, username)
        }
    }

    try {
        // Retry loop: if setRemoteDescription fails with "a=fmtp:<rtx> apt=<pt>
        // Invalid SDP line", the browser silently rejected <pt>'s definition.
        // Extract the bad payload types from the error, re-sanitize, and retry.
        const extraBadPt = new Set()
        let cleanSdp = sanitizeSdp(offerSdp)
        let sdpSet   = false
        for (let attempt = 0; attempt < 30 && !sdpSet; attempt++) {
            try {
                await pc.setRemoteDescription({ type: 'offer', sdp: cleanSdp })
                sdpSet = true
            } catch (e) {
                const m = e.message.match(/a=fmtp:(\d+) apt=(\d+) Invalid SDP line/)
                if (!m) throw e
                extraBadPt.add(m[1])
                extraBadPt.add(m[2])
                cleanSdp = sanitizeSdp(offerSdp, extraBadPt)
            }
        }
        if (!sdpSet) throw new Error('Could not set remote description after stripping incompatible codecs')
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        await waitForIce(pc)
        const { res: ansRes } = await apiFetch('PUT', `/api/plugin-rooms/participants/${pluginRoomId}/data`, {
            data: { [`${memberId}_answer`]: pc.localDescription.sdp },
        })
        if (!ansRes.ok) throw new Error(`Could not write answer: HTTP ${ansRes.status}`)
    } catch (err) {
        console.warn('[DiscussionControls] connectPeer failed:', memberId, err)
        const peerEntry = peers.value.find(p => p.memberId === memberId)
        if (peerEntry) peerEntry.state = 'failed'
        removePeer(memberId)
    }
}

function removePeer(memberId) {
    const idx = peers.value.findIndex(p => p.memberId === memberId)
    if (idx !== -1) peers.value.splice(idx, 1)
    const pc = _pcs.get(memberId)
    if (pc) { pc.close(); _pcs.delete(memberId) }
    _answered.delete(memberId)
    if (window.opener?.__eluthDiscussion) {
        window.opener.__eluthDiscussion.unregisterStream(memberId)
    }
    broadcastPeersUpdate()
}

// ── Member fetch & invite ──────────────────────────────────────────────────────
async function fetchMembers() {
    if (membersLoaded.value || loadingMembers.value) return
    loadingMembers.value = true
    try {
        const { data } = await apiFetch('GET', `/api/members?channel_id=${channelId}`)
        members.value       = data.members ?? data ?? []
        membersLoaded.value = true
    } catch { /* silent fail */ } finally {
        loadingMembers.value = false
    }
}

async function inviteMember(member) {
    const memberId = member.id ?? member.member_id
    if (!memberId || !session.value.ourRoomId) return
    inviteState.value = { ...inviteState.value, [memberId]: 'sending' }
    try {
        const { res, data } = await apiFetch('POST',
            `/api/plugins/participants/rooms/${session.value.ourRoomId}/invite`,
            { member_id: memberId, username: member.username ?? '' })
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
        inviteState.value = { ...inviteState.value, [memberId]: 'sent' }
    } catch {
        inviteState.value = { ...inviteState.value, [memberId]: 'error' }
    }
}

// ── Per-participant source controls ────────────────────────────────────────────
function toggleExpanded(memberId) {
    expandedPeer.value = expandedPeer.value === memberId ? null : memberId
}

function sendTransform(peer, x, y, w, h) {
    const layer = layerForPeer(peer)
    if (!layer) return
    compositorBc.postMessage({ type: 'set-transform', id: layer.id, x, y, w, h })
}

function applyPreset(peer, preset) {
    const layer = layerForPeer(peer)
    if (!layer) return
    compositorBc.postMessage({ type: 'set-transform', id: layer.id, ...preset, label: undefined })
}

function onTransformField(peer, field, rawValue) {
    const val = parseFloat(rawValue)
    if (isNaN(val)) return
    const t = peerTransform(peer)
    t[field] = Math.max(0, Math.min(1, val))
    sendTransform(peer, t.x, t.y, t.w, t.h)
}

function addToScene(peer) {
    compositorBc.postMessage({ type: 'add-layer', sourceKey: peer.slotKey })
    waitForCompositorState().then(() => {
        const layer = layerForPeer(peer)
        if (layer && layer.w === 1 && layer.h === 1) {
            compositorBc.postMessage({ type: 'set-transform', id: layer.id, x: 0.77, y: 0.01, w: 0.22, h: 0.22 })
        }
    })
}

function removeFromScene(peer) {
    const layer = layerForPeer(peer)
    if (layer) compositorBc.postMessage({ type: 'remove-layer', id: layer.id })
}

// ── Auto-layout ────────────────────────────────────────────────────────────────
function calculatePositions(peerList) {
    const { align, maxPer } = layout.value
    const MARGIN = 0.015
    const isVert = align === 'right' || align === 'left'
    const positions = []

    if (isVert) {
        const maxPerCol = Math.max(1, maxPer)
        const camH = (1 - MARGIN * (maxPerCol + 1)) / maxPerCol
        const camW = camH
        peerList.forEach((peer, i) => {
            const col = Math.floor(i / maxPerCol)
            const row = i % maxPerCol
            const x   = align === 'right'
                ? 1 - MARGIN - camW - col * (camW + MARGIN)
                : MARGIN + col * (camW + MARGIN)
            const y   = MARGIN + row * (camH + MARGIN)
            positions.push({ slotKey: peer.slotKey, x, y, w: camW, h: camH })
        })
    } else {
        const maxPerRow = Math.max(1, maxPer)
        const camW = (1 - MARGIN * (maxPerRow + 1)) / maxPerRow
        const camH = camW
        peerList.forEach((peer, i) => {
            const col = i % maxPerRow
            const row = Math.floor(i / maxPerRow)
            const x   = MARGIN + col * (camW + MARGIN)
            const y   = align === 'top'
                ? MARGIN + row * (camH + MARGIN)
                : 1 - MARGIN - camH - row * (camH + MARGIN)
            positions.push({ slotKey: peer.slotKey, x, y, w: camW, h: camH })
        })
    }
    return positions
}

function waitForCompositorState() {
    return new Promise(resolve => {
        const handler = (e) => {
            if (e.data?.type === 'state') {
                compositorBc.removeEventListener('message', handler)
                nextTick(resolve)
            }
        }
        compositorBc.addEventListener('message', handler)
        setTimeout(resolve, 2000)
    })
}

async function applyLayout() {
    const toPosition = activePeers.value.slice()
    if (!toPosition.length) return
    applyingLayout.value = true
    layoutError.value    = ''
    try {
        const existingKeys = new Set((activeScene()?.layers ?? []).map(l => l.sourceKey))
        const toAdd = toPosition.filter(p => !existingKeys.has(p.slotKey))
        for (const peer of toAdd) compositorBc.postMessage({ type: 'add-layer', sourceKey: peer.slotKey })
        if (toAdd.length) await waitForCompositorState()

        const freshLayers = activeScene()?.layers ?? []
        const positions   = calculatePositions(toPosition)
        for (const { slotKey, x, y, w, h } of positions) {
            const layer = freshLayers.find(l => l.sourceKey === slotKey)
            if (!layer) continue
            compositorBc.postMessage({ type: 'set-transform', id: layer.id, x, y, w, h })
        }
    } catch (err) {
        layoutError.value = 'Layout failed: ' + err.message
    } finally {
        applyingLayout.value = false
    }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────
const _handleBeforeUnload = () => {
    if (session.value.active) {
        syncBc?.postMessage({ type: 'room-closed', channelId, peers: [] })
        for (const pc of _pcs.values()) pc.close()
    }
}

onMounted(() => {
    syncBc       = new BroadcastChannel('eluth-discussion-sync')
    compositorBc = new BroadcastChannel(`eluth-stream-${channelId}`)
    compositorBc.onmessage = (e) => {
        if (e.data?.type === 'state') compositorState.value = e.data
    }

    // Listen for invite commands broadcast by the context menu handler in index.js
    if (channelId) {
        cmdBc = new BroadcastChannel(`eluth-discussion-${channelId}`)
        cmdBc.onmessage = (e) => {
            const msg = e.data
            if (msg?.type === 'invite-member' && session.value.active) {
                inviteMember({ id: msg.memberId, username: msg.username })
            }
        }
    }

    window.addEventListener('beforeunload', _handleBeforeUnload)
})

onUnmounted(() => {
    window.removeEventListener('beforeunload', _handleBeforeUnload)
    stopPolling()
    for (const [memberId, pc] of _pcs) {
        pc.close()
        if (window.opener?.__eluthDiscussion) {
            window.opener.__eluthDiscussion.unregisterStream(memberId)
        }
    }
    _pcs.clear()
    _answered.clear()
    if (session.value.active) {
        syncBc?.postMessage({ type: 'room-closed', channelId, peers: [] })
    }
    syncBc?.close()
    cmdBc?.close()
    compositorBc?.close()
})
</script>

<style scoped>
.dc-root {
    display: flex; flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #e2e8f0; font-size: 12px;
}

.dc-section {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
}
.dc-section:last-child { border-bottom: none; }

.dc-section-title {
    font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: #64748b; margin-bottom: 8px;
}

.dc-row { display: flex; align-items: center; }
.dc-row--spread { justify-content: space-between; }
.dc-row--gap    { gap: 8px; }

.dc-live-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #22c55e; box-shadow: 0 0 6px #22c55e80;
    animation: dcPulse 2s ease-in-out infinite; flex-shrink: 0;
}
@keyframes dcPulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }

.dc-label-sm { font-size: 11px; color: #94a3b8; }

.dc-btn {
    border: none; border-radius: 6px; cursor: pointer;
    font-size: 11px; font-weight: 600; padding: 6px 12px;
    transition: opacity 0.15s;
}
.dc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dc-btn:hover:not(:disabled) { opacity: 0.85; }

.dc-btn--primary { background: var(--accent, #a78bfa); color: #fff; width: 100%; padding: 8px 12px; }
.dc-btn--danger  { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; }
.dc-btn--sm      { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #e2e8f0; padding: 3px 8px; }
.dc-btn--layout  { background: rgba(167,139,250,0.15); border: 1px solid rgba(167,139,250,0.3); color: #c4b5fd; width: 100%; padding: 7px; margin-top: 8px; }
.dc-btn--add     { background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.25); color: #86efac; width: 100%; padding: 5px; }
.dc-btn--remove  { background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); color: #fca5a5; padding: 3px 8px; }
.dc-btn--preset  { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #94a3b8; padding: 3px 7px; font-size: 10px; }

.dc-error { font-size: 11px; color: #f87171; margin-top: 6px; }
.dc-hint  { font-size: 11px; color: #475569; padding: 4px 0; }

.dc-input {
    width: 100%; box-sizing: border-box;
    background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; color: #e2e8f0; font-size: 11px; padding: 5px 8px; outline: none;
}
.dc-input:focus { border-color: var(--accent, #a78bfa); }
.dc-input--num  { width: 56px; }

.dc-select {
    background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; color: #e2e8f0; font-size: 11px;
    padding: 5px 8px; outline: none; cursor: pointer; flex: 1;
}
.dc-select:focus { border-color: var(--accent, #a78bfa); }

.dc-form-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dc-form-label { font-size: 11px; color: #94a3b8; white-space: nowrap; min-width: 80px; }

.dc-member-list {
    display: flex; flex-direction: column; gap: 4px;
    max-height: 140px; overflow-y: auto; margin-top: 6px;
}
.dc-member-row  { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }
.dc-member-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dc-badge { font-size: 10px; font-weight: 600; border-radius: 4px; padding: 2px 6px; flex-shrink: 0; }
.dc-badge--sending { background: rgba(255,255,255,0.08); color: #94a3b8; }
.dc-badge--sent    { background: rgba(34,197,94,0.15);   color: #86efac; }
.dc-badge--error   { background: rgba(239,68,68,0.15);   color: #fca5a5; }

/* Participant webcam blocks */
.dc-cam-block {
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 6px; margin-bottom: 5px; overflow: hidden;
}
.dc-cam-header {
    display: flex; align-items: center; gap: 7px;
    padding: 6px 8px; cursor: pointer; background: rgba(255,255,255,0.03);
    user-select: none;
}
.dc-cam-header:hover { background: rgba(255,255,255,0.06); }
.dc-cam-name  { flex: 1; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-cam-hint  { font-size: 10px; color: #475569; flex-shrink: 0; }
.dc-cam-caret { font-size: 9px; color: #475569; flex-shrink: 0; }

.dc-cam-detail { padding: 6px 8px; background: rgba(0,0,0,0.15); display: flex; flex-direction: column; gap: 6px; }
.dc-cam-row    { display: flex; align-items: center; gap: 6px; }
.dc-cam-row--wrap { flex-wrap: wrap; }

.dc-in-scene-label { font-size: 10px; color: #86efac; flex: 1; }

.dc-xywh { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.dc-xywh-row { display: flex; align-items: center; gap: 4px; }
.dc-xywh-label { font-size: 10px; color: #64748b; width: 14px; flex-shrink: 0; }
.dc-xywh-input {
    flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 4px; color: #e2e8f0; font-size: 10px; padding: 3px 5px; outline: none;
}
.dc-xywh-input:focus { border-color: var(--accent, #a78bfa); }
.dc-xywh-unit { font-size: 9px; color: #374151; }

.dc-peer-dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: #374151;
}
.dc-peer-dot--connected  { background: #22c55e; }
.dc-peer-dot--connecting { background: #f59e0b; animation: dcPulse 1.5s ease-in-out infinite; }
.dc-peer-dot--failed     { background: #ef4444; }
</style>
