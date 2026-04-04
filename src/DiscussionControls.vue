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

const props = defineProps({
    channelId: { type: String, required: true },
})

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

const SETTINGS_KEY = `discussion-settings-${props.channelId}`

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

// ── BroadcastChannels ──────────────────────────────────────────────────────────
let syncBc       = null
let compositorBc = null

function setupChannels() {
    syncBc = new BroadcastChannel('eluth-discussion-sync')
    syncBc.onmessage = (e) => handleSyncMessage(e.data)

    compositorBc = new BroadcastChannel(`eluth-stream-${props.channelId}`)
    compositorBc.onmessage = (e) => {
        if (e.data?.type === 'state') compositorState.value = e.data
    }
}

function handleSyncMessage(msg) {
    if (!msg?.type) return
    switch (msg.type) {
        case 'state':
        case 'peers-update':
            if (msg.channelId !== props.channelId) return
            session.value = { active: msg.active, pluginRoomId: msg.pluginRoomId ?? null, ourRoomId: msg.ourRoomId ?? null }
            peers.value   = msg.peers ?? []
            break
        case 'room-created':
            if (msg.channelId !== props.channelId) return
            starting.value = false
            error.value    = ''
            session.value  = { active: true, pluginRoomId: msg.pluginRoomId, ourRoomId: msg.ourRoomId }
            fetchMembers()
            break
        case 'room-error':
            starting.value = false
            error.value    = 'Could not start: ' + (msg.error ?? 'Unknown error')
            break
        case 'room-closed':
            if (msg.channelId !== props.channelId) return
            session.value = { active: false, pluginRoomId: null, ourRoomId: null }
            peers.value   = []
            break
        case 'invite-sent':
            inviteState.value = { ...inviteState.value, [msg.memberId]: 'sent' }
            break
        case 'invite-error':
            inviteState.value = { ...inviteState.value, [msg.memberId]: 'error' }
            break
        case 'members-data':
            if (msg.channelId !== props.channelId) return
            loadingMembers.value = false
            membersLoaded.value  = true
            members.value        = msg.members ?? []
            break
        case 'members-error':
            loadingMembers.value = false
            break
    }
}

// ── Session actions ────────────────────────────────────────────────────────────
function startSession() {
    starting.value = true
    error.value    = ''
    syncBc.postMessage({ type: 'create-room', channelId: props.channelId })
}

function endSession() {
    syncBc.postMessage({
        type: 'close-room', channelId: props.channelId,
        pluginRoomId: session.value.pluginRoomId,
        ourRoomId:    session.value.ourRoomId,
    })
}

function fetchMembers() {
    if (membersLoaded.value || loadingMembers.value) return
    loadingMembers.value = true
    syncBc.postMessage({ type: 'fetch-members', channelId: props.channelId })
}

function inviteMember(member) {
    const memberId = member.id ?? member.member_id
    if (!memberId || !session.value.ourRoomId) return
    inviteState.value = { ...inviteState.value, [memberId]: 'sending' }
    syncBc.postMessage({
        type: 'invite-member', ourRoomId: session.value.ourRoomId,
        memberId, username: member.username ?? '',
    })
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
    // Wait for state update then set a sensible default size
    waitForCompositorState().then(() => {
        const layer = layerForPeer(peer)
        if (layer && layer.w === 1 && layer.h === 1) {
            // Default: small camera in top-right
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
onMounted(() => {
    setupChannels()
    syncBc.postMessage({ type: 'request-state', channelId: props.channelId })
})

onUnmounted(() => {
    syncBc?.close()
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
