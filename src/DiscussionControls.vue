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

        <!-- ── Connected participants ─────────────────────────────────────── -->
        <div v-if="session.active && peers.length" class="dc-section">
            <div class="dc-section-title">Participants</div>
            <div v-for="p in peers" :key="p.memberId" class="dc-peer-row">
                <span class="dc-peer-dot" :class="`dc-peer-dot--${p.state}`" />
                <span class="dc-peer-name">{{ p.username }}</span>
                <span class="dc-peer-slot">Seat {{ p.slotKey?.split('-')[1] }}</span>
            </div>
        </div>

        <!-- ── Layout controls ────────────────────────────────────────────── -->
        <div v-if="session.active" class="dc-section">
            <div class="dc-section-title">Auto-Layout</div>
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

// ── State ──────────────────────────────────────────────────────────────────────
const session        = ref({ active: false, pluginRoomId: null, ourRoomId: null })
const peers          = ref([])
const members        = ref([])
const memberSearch   = ref('')
const loadingMembers = ref(false)
const membersLoaded  = ref(false)
const inviteState    = ref({})   // memberId → 'sending' | 'sent' | 'error'
const starting       = ref(false)
const error          = ref('')
const applyingLayout = ref(false)
const layoutError    = ref('')

const SETTINGS_KEY = `discussion-settings-${props.channelId}`

const layout = ref(loadSettings())

// Tracks the compositor's current scene/layer state for layout commands
const compositorState = ref(null)

function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
        return { align: s.align ?? 'right', maxPer: s.maxPer ?? 3 }
    } catch {
        return { align: 'right', maxPer: 3 }
    }
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

const activePeers = computed(() =>
    peers.value.filter(p => p.state !== 'failed')
)

const filteredMembers = computed(() => {
    const q      = memberSearch.value.trim().toLowerCase()
    const peerIds = new Set(peers.value.map(p => p.memberId))
    return members.value
        .filter(m => !peerIds.has(m.id ?? m.member_id))
        .filter(m => !q || m.username?.toLowerCase().includes(q))
})

// ── BroadcastChannels ──────────────────────────────────────────────────────────
let syncBc       = null   // eluth-discussion-sync  (main window relay)
let compositorBc = null   // eluth-stream-{channelId} (compositor)

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
            session.value = {
                active:       msg.active,
                pluginRoomId: msg.pluginRoomId ?? null,
                ourRoomId:    msg.ourRoomId    ?? null,
            }
            peers.value = msg.peers ?? []
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
        type:         'close-room',
        channelId:    props.channelId,
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
        type:      'invite-member',
        ourRoomId: session.value.ourRoomId,
        memberId,
        username:  member.username ?? '',
    })
}

// ── Auto-layout ────────────────────────────────────────────────────────────────
function calculatePositions(peerList) {
    const { align, maxPer }   = layout.value
    const MARGIN               = 0.015
    const positions            = []
    const isVert               = align === 'right' || align === 'left'

    if (isVert) {
        const maxPerCol = Math.max(1, maxPer)
        const camH      = (1 - MARGIN * (maxPerCol + 1)) / maxPerCol
        const camW      = camH   // 16:9 cam on 16:9 canvas: normalized w == h

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
        const camW      = (1 - MARGIN * (maxPerRow + 1)) / maxPerRow
        const camH      = camW

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
        const activeScene = compositorState.value?.scenes?.find(
            s => s.id === compositorState.value?.activeSceneId
        )
        const existingKeys = new Set((activeScene?.layers ?? []).map(l => l.sourceKey))

        // Add any slots not yet in the current scene
        const toAdd = toPosition.filter(p => !existingKeys.has(p.slotKey))
        for (const peer of toAdd) {
            compositorBc.postMessage({ type: 'add-layer', sourceKey: peer.slotKey })
        }
        if (toAdd.length) await waitForCompositorState()

        // Fresh layer list after adds
        const freshScene  = compositorState.value?.scenes?.find(
            s => s.id === compositorState.value?.activeSceneId
        )
        const freshLayers = freshScene?.layers ?? []
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
    display: flex; flex-direction: column; gap: 0;
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
.dc-row--gap { gap: 8px; }

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
.dc-btn--danger  {
    background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3);
    color: #fca5a5;
}
.dc-btn--sm {
    background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
    color: #e2e8f0; padding: 3px 8px;
}
.dc-btn--layout {
    background: rgba(167,139,250,0.15); border: 1px solid rgba(167,139,250,0.3);
    color: #c4b5fd; width: 100%; padding: 7px; margin-top: 8px;
}

.dc-error { font-size: 11px; color: #f87171; margin-top: 6px; }
.dc-hint  { font-size: 11px; color: #475569; padding: 4px 0; }

.dc-input {
    width: 100%; box-sizing: border-box;
    background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; color: #e2e8f0; font-size: 11px;
    padding: 5px 8px; outline: none;
}
.dc-input:focus { border-color: var(--accent, #a78bfa); }
.dc-input--num  { width: 56px; }

.dc-select {
    background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px; color: #e2e8f0; font-size: 11px;
    padding: 5px 8px; outline: none; cursor: pointer; flex: 1;
}
.dc-select:focus { border-color: var(--accent, #a78bfa); }

.dc-form-row {
    display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.dc-form-label {
    font-size: 11px; color: #94a3b8; white-space: nowrap; min-width: 80px;
}

.dc-member-list {
    display: flex; flex-direction: column; gap: 4px;
    max-height: 160px; overflow-y: auto; margin-top: 6px;
}
.dc-member-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 3px 0;
}
.dc-member-name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.dc-badge {
    font-size: 10px; font-weight: 600; border-radius: 4px;
    padding: 2px 6px; flex-shrink: 0;
}
.dc-badge--sending { background: rgba(255,255,255,0.08); color: #94a3b8; }
.dc-badge--sent    { background: rgba(34,197,94,0.15);   color: #86efac; }
.dc-badge--error   { background: rgba(239,68,68,0.15);   color: #fca5a5; }

.dc-peer-row {
    display: flex; align-items: center; gap: 7px; padding: 2px 0;
}
.dc-peer-dot {
    width: 7px; height: 7px; border-radius: 50%;
    flex-shrink: 0; background: #374151;
}
.dc-peer-dot--connected  { background: #22c55e; }
.dc-peer-dot--connecting { background: #f59e0b; animation: dcPulse 1.5s ease-in-out infinite; }
.dc-peer-dot--failed     { background: #ef4444; }

.dc-peer-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-peer-slot { font-size: 10px; color: #475569; flex-shrink: 0; }
</style>
