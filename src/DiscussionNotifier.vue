<template>
    <div class="dn-root">
        <!-- Invite toast — teleported to body so it floats above the UI -->
        <Teleport to="body">
            <div v-if="pendingInvite" class="dn-toast">
                <div class="dn-toast__icon">👥</div>
                <div class="dn-toast__body">
                    <div class="dn-toast__title">Discussion Invite</div>
                    <div class="dn-toast__msg">
                        <strong>{{ pendingInvite.host_username }}</strong>
                        has invited you to join their live discussion
                    </div>
                </div>
                <div class="dn-toast__actions">
                    <button class="dn-btn dn-btn--accept" :disabled="accepting" @click="acceptInvite">
                        {{ accepting ? '…' : 'Join' }}
                    </button>
                    <button class="dn-btn dn-btn--decline" @click="declineInvite">Decline</button>
                </div>
            </div>
        </Teleport>
    </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
    apiBase:       { type: String, default: '/api' },
    authToken:     { type: String, default: '' },
    channelId:     { type: String, default: '' },
    currentMember: { type: Object, default: null },
})

const pendingInvite = ref(null)
const accepting     = ref(false)
let pollTimer       = null

function base() { return props.apiBase.replace(/\/$/, '') }

async function api(method, path, body = null) {
    try {
        const res = await fetch(base() + path, {
            method,
            headers: {
                Authorization:  'Bearer ' + props.authToken,
                'Content-Type': 'application/json',
                Accept:         'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        })
        if (!res.ok) return null
        return res.json()
    } catch {
        return null
    }
}

async function checkPendingInvites() {
    const data = await api('GET', '/plugins/participants/invites/pending')
    const invites = data?.invites ?? []
    // Show the first pending invite; dismiss if none
    pendingInvite.value = invites[0] ?? null
}

async function acceptInvite() {
    if (!pendingInvite.value || accepting.value) return
    accepting.value = true
    const invite = pendingInvite.value

    const data = await api('POST', `/plugins/participants/invites/${invite.id}/accept`)
    accepting.value = false
    pendingInvite.value = null

    if (data?.plugin_room_id) {
        const origin = window._eluthCommunityUrl ?? window.location.origin
        window.open(
            `${origin.replace(/\/$/, '')}/?participants_join=${data.plugin_room_id}`,
            `pd-join-${data.plugin_room_id}`,
            'width=480,height=540,resizable=yes'
        )
    }
}

async function declineInvite() {
    if (!pendingInvite.value) return
    const inviteId = pendingInvite.value.id
    pendingInvite.value = null
    await api('POST', `/plugins/participants/invites/${inviteId}/decline`)
}

onMounted(() => {
    checkPendingInvites()
    pollTimer = setInterval(checkPendingInvites, 5000)
})

onBeforeUnmount(() => {
    clearInterval(pollTimer)
})
</script>

<style scoped>
/* The root element takes no visible space — toast is teleported */
.dn-root { display: contents; }

.dn-toast {
    position: fixed;
    bottom: 80px;
    right: 20px;
    z-index: 9999;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    background: #1e2130;
    border: 1px solid rgba(167,139,250,0.35);
    border-radius: 12px;
    padding: 14px 16px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    max-width: 340px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    animation: dnSlideIn 0.25s ease;
}

@keyframes dnSlideIn {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
}

.dn-toast__icon { font-size: 26px; flex-shrink: 0; margin-top: 2px; }

.dn-toast__body { flex: 1; min-width: 0; }
.dn-toast__title {
    font-size: 13px; font-weight: 700; color: #e2e8f0; margin-bottom: 3px;
}
.dn-toast__msg {
    font-size: 12px; color: #94a3b8; line-height: 1.4;
}
.dn-toast__msg strong { color: #c4b5fd; font-weight: 600; }

.dn-toast__actions {
    display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
}

.dn-btn {
    border: none; border-radius: 6px; cursor: pointer;
    font-size: 12px; font-weight: 700; padding: 6px 14px;
    transition: opacity 0.15s; white-space: nowrap;
}
.dn-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.dn-btn:hover:not(:disabled) { opacity: 0.85; }

.dn-btn--accept  { background: var(--accent, #a78bfa); color: #fff; }
.dn-btn--decline {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    color: #64748b;
}
.dn-btn--decline:hover { color: #e2e8f0; }
</style>
