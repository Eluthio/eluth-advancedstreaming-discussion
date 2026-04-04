<template>
    <div class="dc-root">
        <div class="dc-header" @click="expanded = !expanded">
            <span class="dc-icon">👥</span>
            <span class="dc-label">Discussion</span>
            <span v-if="active" class="dc-live-dot">●</span>
            <span v-if="active" class="dc-count">{{ peers.length }} participant{{ peers.length !== 1 ? 's' : '' }}</span>
            <span class="dc-chevron">{{ expanded ? '▲' : '▼' }}</span>
        </div>

        <div v-if="expanded" class="dc-body">

            <!-- Not in streaming popup context -->
            <div v-if="!channelId" class="dc-warn">
                Open via the streaming control panel to manage participants.
            </div>

            <!-- Idle: no active session -->
            <template v-else-if="!active">
                <div class="dc-hint">
                    Start a discussion to pull in other users' webcams as a source you can add to your scene.
                </div>
                <button class="dc-btn-start" :disabled="starting" @click="startSession">
                    {{ starting ? 'Starting…' : 'Start Discussion' }}
                </button>
                <div v-if="error" class="dc-error">{{ error }}</div>
            </template>

            <!-- Active session -->
            <template v-else>
                <!-- Invite controls -->
                <div class="dc-invite-row">
                    <input class="dc-link-input" :value="joinUrl" readonly @click="$event.target.select()" />
                    <button class="dc-btn-copy" @click="copyLink" :title="copied ? 'Copied!' : 'Copy join link'">
                        {{ copied ? '✓' : '📋' }}
                    </button>
                    <button class="dc-btn-share" @click="shareToChat" :disabled="!canShare" title="Post invite to chat">
                        💬
                    </button>
                </div>

                <!-- Participant list -->
                <div class="dc-peer-list">
                    <div v-if="!peers.length" class="dc-empty">Waiting for participants…</div>
                    <div v-for="p in peers" :key="p.memberId" class="dc-peer" :class="`dc-peer--${p.state}`">
                        <span class="dc-peer-dot" />
                        <span class="dc-peer-name">{{ p.username }}</span>
                        <span class="dc-peer-state">{{ p.state }}</span>
                    </div>
                </div>

                <button class="dc-btn-end" @click="endSession">End Discussion</button>
            </template>

        </div>
    </div>
</template>

<script>
// DiscussionControls runs inside the advanced streaming control popup.
// It reads channelId from the popup URL (?channel=UUID) and communicates
// with the source in the main window via BroadcastChannel('eluth-discussion-sync').

const SYNC_CHANNEL = 'eluth-discussion-sync'

export default {
    props: {
        // Passed by the advanced streaming popup (mirrors PlexControls props)
        state:       { type: Object,   default: null },
        sendCommand: { type: Function, default: () => {} },
    },

    data() {
        const params    = new URLSearchParams(window.location.search)
        const channelId = params.get('channel') ?? null

        // Server origin for constructing join URLs (popup URL = same origin as community server)
        const serverOrigin = window.location.origin

        return {
            channelId,
            serverOrigin,
            expanded: true,
            active:   false,
            roomId:   null,
            peers:    [],
            starting: false,
            error:    '',
            copied:   false,
            bc:       null,
        }
    },

    computed: {
        joinUrl() {
            if (!this.roomId) return ''
            return `${this.serverOrigin}/?participants_join=${this.roomId}`
        },
        canShare() {
            return !!this.channelId && !!this.joinUrl
        },
    },

    mounted() {
        this.bc = new BroadcastChannel(SYNC_CHANNEL)
        this.bc.onmessage = (e) => {
            const msg = e.data
            if (!msg?.type) return
            if (msg.type === 'state') {
                this.active = msg.active
                this.roomId = msg.roomId
                this.peers  = msg.peers ?? []
            }
            if (msg.type === 'peers-update') {
                this.peers = msg.peers ?? []
            }
        }

        // Tell main window our channelId and request current state
        if (this.channelId) {
            this.bc.postMessage({ type: 'channel-context', channelId: this.channelId })
            // Expose server origin on the source object for the messageRenderer's inline onclick
            if (window.__EluthStreamSources?.['participants']) {
                window.__EluthStreamSources['participants']._origin = this.serverOrigin
            }
        }
        this.bc.postMessage({ type: 'request-state' })
    },

    beforeUnmount() {
        this.bc?.close()
    },

    methods: {
        async api(method, path, body) {
            const { authToken, apiBase } = window.__EluthDiscussionApi ?? {}
            if (!authToken) throw new Error('Not authenticated')
            const b = apiBase.replace(/\/$/, '')
            const res = await fetch(`${b}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${authToken}`,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            })
            if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`)
            return res.json()
        },

        async startSession() {
            this.starting = true
            this.error    = ''
            try {
                const data = await this.api('POST', '/api/plugin-rooms/participants', {
                    channel_id:  this.channelId,
                    max_players: 8,
                })
                const roomId = data.room?.id
                if (!roomId) throw new Error('No room ID returned')
                this.active = true
                this.roomId = roomId

                // Tell main window to start WebRTC session
                this.bc.postMessage({ type: 'session-started', roomId, channelId: this.channelId })
            } catch (e) {
                this.error = e.message.includes('409')
                    ? 'A discussion is already active in this channel.'
                    : 'Could not start session: ' + e.message
            } finally {
                this.starting = false
            }
        },

        async endSession() {
            if (!this.roomId) return
            try {
                await this.api('POST', `/api/plugin-rooms/participants/${this.roomId}/close`)
            } catch { /* ignore */ }
            this.bc.postMessage({ type: 'session-ended' })
            this.active = false
            this.roomId = null
            this.peers  = []
        },

        copyLink() {
            if (!this.joinUrl) return
            navigator.clipboard.writeText(this.joinUrl).catch(() => {})
            this.copied = true
            setTimeout(() => { this.copied = false }, 2000)
        },

        async shareToChat() {
            if (!this.canShare) return
            const { authToken, apiBase } = window.__EluthDiscussionApi ?? {}
            if (!authToken) return
            const b = apiBase.replace(/\/$/, '')
            try {
                await fetch(`${b}/api/channels/${this.channelId}/messages`, {
                    method:  'POST',
                    headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ content: this.joinUrl }),
                })
            } catch { /* fallback: copy */ this.copyLink() }
        },
    },
}
</script>

<style>
/* Unscoped so styles apply when this component is injected into the streaming popup */
.dc-root { border-top: 1px solid rgba(255,255,255,0.08); flex-shrink: 0; }

.dc-header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; cursor: pointer; user-select: none;
    transition: background 0.15s;
}
.dc-header:hover { background: rgba(255,255,255,0.04); }
.dc-icon          { font-size: 14px; }
.dc-label         { font-size: 12px; font-weight: 700; color: #94a3b8; flex-shrink: 0; }
.dc-live-dot      { font-size: 10px; color: #22c55e; }
.dc-count         { font-size: 11px; color: #64748b; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dc-chevron       { font-size: 9px; color: #475569; margin-left: auto; flex-shrink: 0; }

.dc-body {
    padding: 10px 14px 14px;
    display: flex; flex-direction: column; gap: 8px;
    max-height: 280px; overflow-y: auto;
}

.dc-warn { font-size: 12px; color: #475569; }
.dc-hint { font-size: 12px; color: #64748b; line-height: 1.5; }
.dc-error { font-size: 12px; color: #f87171; }

.dc-btn-start {
    background: transparent; border: 1px solid rgba(255,255,255,0.15);
    color: #64748b; border-radius: 6px; padding: 6px 12px; cursor: pointer;
    font-size: 12px; width: 100%; transition: all 0.15s;
}
.dc-btn-start:hover:not(:disabled) { color: #e2e8f0; background: rgba(255,255,255,0.06); }
.dc-btn-start:disabled { opacity: 0.4; cursor: not-allowed; }

.dc-invite-row { display: flex; gap: 4px; align-items: center; }
.dc-link-input {
    flex: 1; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
    color: #94a3b8; border-radius: 4px; padding: 4px 8px; font-size: 11px;
    font-family: monospace; min-width: 0; cursor: text;
}
.dc-btn-copy, .dc-btn-share {
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
    color: #94a3b8; border-radius: 4px; padding: 4px 8px; cursor: pointer;
    font-size: 13px; flex-shrink: 0; transition: all 0.15s;
}
.dc-btn-copy:hover, .dc-btn-share:hover:not(:disabled) { background: rgba(255,255,255,0.12); color: #e2e8f0; }
.dc-btn-share:disabled { opacity: 0.3; cursor: not-allowed; }

.dc-peer-list { display: flex; flex-direction: column; gap: 3px; }
.dc-empty     { font-size: 12px; color: #374151; font-style: italic; }
.dc-peer {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; padding: 3px 0;
}
.dc-peer-dot { width: 7px; height: 7px; border-radius: 50%; background: #374151; flex-shrink: 0; }
.dc-peer--connected .dc-peer-dot { background: #22c55e; }
.dc-peer--failed    .dc-peer-dot { background: #ef4444; }
.dc-peer-name  { flex: 1; color: #e2e8f0; }
.dc-peer-state { font-size: 10px; color: #475569; text-transform: capitalize; }

.dc-btn-end {
    background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.25);
    color: #f87171; border-radius: 6px; padding: 5px 10px; cursor: pointer;
    font-size: 12px; font-weight: 600; transition: all 0.15s; width: 100%;
}
.dc-btn-end:hover { background: rgba(239,68,68,0.2); }
</style>
