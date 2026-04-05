<template>
    <div class="pw-root">
        <div class="pw-card">
            <div class="pw-logo">👥</div>
            <div class="pw-title">Live Discussion</div>
            <div class="pw-subtitle">Your webcam will be shared with the host and broadcast live.</div>

            <!-- Camera/mic setup -->
            <div v-if="phase === 'setup'" class="pw-setup">
                <div class="pw-preview-wrap">
                    <video ref="previewEl" class="pw-preview" autoplay muted playsinline />
                    <div v-if="!localStream" class="pw-preview-placeholder">
                        <span>📷</span><span>Camera preview</span>
                    </div>
                </div>

                <div class="pw-device-row">
                    <select class="pw-select" v-model="selectedVideo" @change="applyDevices" :disabled="!videoDevices.length">
                        <option value="">— No camera —</option>
                        <option v-for="d in videoDevices" :key="d.deviceId" :value="d.deviceId">{{ d.label || 'Camera ' + (videoDevices.indexOf(d)+1) }}</option>
                    </select>
                </div>
                <div class="pw-device-row">
                    <select class="pw-select" v-model="selectedAudio" @change="applyDevices" :disabled="!audioDevices.length">
                        <option value="">— No microphone —</option>
                        <option v-for="d in audioDevices" :key="d.deviceId" :value="d.deviceId">{{ d.label || 'Mic ' + (audioDevices.indexOf(d)+1) }}</option>
                    </select>
                </div>

                <div v-if="deviceError" class="pw-error">{{ deviceError }}</div>

                <button class="pw-btn-join" :disabled="!localStream || joining" @click="joinSession">
                    {{ joining ? 'Connecting…' : 'Join Discussion' }}
                </button>
                <button class="pw-btn-cancel" @click="window.close()">Cancel</button>
            </div>

            <!-- Connected -->
            <div v-else-if="phase === 'connected'" class="pw-connected">
                <div class="pw-status-dot pw-status-dot--live" />
                <div class="pw-status-text">You are live in the discussion</div>
                <div class="pw-preview-wrap pw-preview-wrap--sm">
                    <video ref="livePreviewEl" class="pw-preview" autoplay muted playsinline />
                </div>
                <button class="pw-btn-leave" @click="leaveSession">Leave Discussion</button>
            </div>

            <!-- Failed -->
            <div v-else-if="phase === 'failed'" class="pw-failed">
                <div class="pw-error">{{ joinError }}</div>
                <button class="pw-btn-cancel" @click="window.close()">Close</button>
            </div>
        </div>
    </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, nextTick } from 'vue'

const props = defineProps({
    roomId:    { type: String, required: true },
    authToken: { type: String, required: true },
    apiBase:   { type: String, required: true },
})

const phase       = ref('setup')   // 'setup' | 'connected' | 'failed'
const joining     = ref(false)
const joinError   = ref('')
const deviceError = ref('')

const videoDevices = ref([])
const audioDevices = ref([])
const selectedVideo = ref('')
const selectedAudio = ref('')

const localStream   = ref(null)
const previewEl     = ref(null)
const livePreviewEl = ref(null)

let pc = null

const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

function base() { return props.apiBase.replace(/\/$/, '') }
function getMemberId() {
    try { return JSON.parse(atob(props.authToken.split('.')[1])).sub ?? null } catch { return null }
}
function getUsername() {
    try { return JSON.parse(atob(props.authToken.split('.')[1])).username ?? 'Participant' } catch { return 'Participant' }
}

async function api(method, path, body) {
    const res = await fetch(`${base()}${path}`, {
        method,
        headers: { Authorization: `Bearer ${props.authToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
        const err = new Error(`${method} ${path} → ${res.status}`)
        err.status = res.status
        throw err
    }
    return res.json()
}

async function requestDevices() {
    try {
        // Request permission first with generous constraints so device labels are populated
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        stream.getTracks().forEach(t => t.stop())
    } catch (e) {
        deviceError.value = 'Camera/mic access denied: ' + e.message
        return
    }
    const devices = await navigator.mediaDevices.enumerateDevices()
    videoDevices.value = devices.filter(d => d.kind === 'videoinput')
    audioDevices.value = devices.filter(d => d.kind === 'audioinput')
    if (videoDevices.value.length) selectedVideo.value = videoDevices.value[0].deviceId
    if (audioDevices.value.length) selectedAudio.value = audioDevices.value[0].deviceId
    await applyDevices()
}

async function applyDevices() {
    if (localStream.value) { localStream.value.getTracks().forEach(t => t.stop()) }
    deviceError.value = ''
    try {
        const constraints = {
            video: selectedVideo.value
                ? { deviceId: { exact: selectedVideo.value }, width: { ideal: 640 }, height: { ideal: 360 } }
                : false,
            audio: selectedAudio.value ? { deviceId: { exact: selectedAudio.value } } : false,
        }
        if (!constraints.video && !constraints.audio) { localStream.value = null; return }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        localStream.value = stream
        await nextTick()
        if (previewEl.value) { previewEl.value.srcObject = stream; previewEl.value.play().catch(() => {}) }
    } catch (e) {
        deviceError.value = 'Could not open devices: ' + e.message
        localStream.value = null
    }
}

async function joinSession() {
    if (!localStream.value) return
    joining.value = true
    joinError.value = ''

    const memberId = getMemberId()
    const username = getUsername()

    try {
        pc = new RTCPeerConnection(RTC_CONFIG)

        // Add local tracks
        for (const track of localStream.value.getTracks()) {
            pc.addTrack(track, localStream.value)
        }

        // Create offer
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)

        // Wait for ICE gathering
        await waitForIce(pc)

        // Write offer to room
        await api('PUT', `/api/plugin-rooms/participants/${props.roomId}/data`, {
            data: {
                [`${memberId}_offer`]:    pc.localDescription.sdp,
                [`${memberId}_username`]: username,
                [`${memberId}_status`]:   'connecting',
            },
        })

        // Poll for host answer
        const answerSdp = await pollForAnswer(memberId)

        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })

        // Wait for connection
        await waitForConnection(pc)

        // Mark connected
        await api('PUT', `/api/plugin-rooms/participants/${props.roomId}/data`, {
            data: { [`${memberId}_status`]: 'connected' },
        })

        phase.value = 'connected'
        await nextTick()
        if (livePreviewEl.value) {
            livePreviewEl.value.srcObject = localStream.value
            livePreviewEl.value.play().catch(() => {})
        }

    } catch (e) {
        console.error('[Discussion] join failed', e)
        joinError.value = e.status === 404
            ? 'This session is no longer active — ask the host to re-invite you.'
            : 'Failed to connect: ' + e.message
        phase.value = 'failed'
        pc?.close()
        pc = null
    } finally {
        joining.value = false
    }
}

async function pollForAnswer(memberId, timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        try {
            const res  = await api('GET', `/api/plugin-rooms/participants/${props.roomId}`)
            const data = res.room?.data ?? {}
            const sdp  = data[`${memberId}_answer`]
            if (sdp) return sdp
        } catch { /* ignore poll error */ }
        await new Promise(r => setTimeout(r, 1500))
    }
    throw new Error('Timed out waiting for host answer')
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

function waitForConnection(pc) {
    return new Promise((resolve, reject) => {
        if (pc.connectionState === 'connected') { resolve(); return }
        const check = () => {
            if (pc.connectionState === 'connected') { resolve() }
            else if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
                reject(new Error('Connection ' + pc.connectionState))
            }
        }
        pc.addEventListener('connectionstatechange', check)
        setTimeout(() => reject(new Error('Connection timed out')), 20000)
    })
}

async function leaveSession() {
    const memberId = getMemberId()
    try {
        await api('PUT', `/api/plugin-rooms/participants/${props.roomId}/data`, {
            data: { [`${memberId}_status`]: 'disconnected' },
        })
    } catch { /* ignore */ }
    pc?.close()
    pc = null
    localStream.value?.getTracks().forEach(t => t.stop())
    window.close()
}

onMounted(requestDevices)

onUnmounted(() => {
    pc?.close()
    localStream.value?.getTracks().forEach(t => t.stop())
})
</script>

<style scoped>
.pw-root {
    min-height: 100vh; background: #0f1117;
    display: flex; align-items: center; justify-content: center;
    padding: 20px; box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #e2e8f0;
}
.pw-card {
    background: #1e2130; border: 1px solid rgba(255,255,255,0.1);
    border-radius: 16px; padding: 28px 24px;
    width: 100%; max-width: 400px; display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.pw-logo     { font-size: 40px; }
.pw-title    { font-size: 20px; font-weight: 700; color: #e2e8f0; }
.pw-subtitle { font-size: 12px; color: #64748b; text-align: center; line-height: 1.5; max-width: 300px; }

.pw-setup { display: flex; flex-direction: column; gap: 10px; width: 100%; }

.pw-preview-wrap {
    width: 100%; aspect-ratio: 16/9; background: #0f1117;
    border-radius: 8px; overflow: hidden; position: relative;
    display: flex; align-items: center; justify-content: center;
}
.pw-preview-wrap--sm { aspect-ratio: 16/9; max-width: 260px; }
.pw-preview { width: 100%; height: 100%; object-fit: cover; display: block; }
.pw-preview-placeholder {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 8px;
    font-size: 13px; color: #374151;
}
.pw-preview-placeholder span:first-child { font-size: 28px; }

.pw-device-row { width: 100%; }
.pw-select {
    width: 100%; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);
    color: #e2e8f0; border-radius: 6px; padding: 7px 10px; font-size: 12px;
    outline: none; cursor: pointer;
}
.pw-select:focus { border-color: var(--accent, #a78bfa); }

.pw-error { font-size: 12px; color: #f87171; text-align: center; }

.pw-btn-join {
    width: 100%; background: var(--accent, #a78bfa); color: #fff; border: none;
    border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 700; cursor: pointer;
    transition: opacity 0.15s;
}
.pw-btn-join:hover:not(:disabled) { opacity: 0.85; }
.pw-btn-join:disabled { opacity: 0.4; cursor: not-allowed; }

.pw-btn-cancel {
    width: 100%; background: transparent; border: 1px solid rgba(255,255,255,0.12);
    color: #64748b; border-radius: 8px; padding: 8px; font-size: 13px; cursor: pointer;
    transition: all 0.15s;
}
.pw-btn-cancel:hover { color: #e2e8f0; border-color: rgba(255,255,255,0.25); }

/* Connected state */
.pw-connected { display: flex; flex-direction: column; align-items: center; gap: 14px; width: 100%; }
.pw-status-dot { width: 12px; height: 12px; border-radius: 50%; background: #374151; }
.pw-status-dot--live { background: #22c55e; box-shadow: 0 0 8px #22c55e80; animation: pdPulse 2s ease-in-out infinite; }
@keyframes pdPulse { 0%,100% { opacity:1 } 50% { opacity:0.6 } }
.pw-status-text { font-size: 14px; font-weight: 600; color: #e2e8f0; }

.pw-btn-leave {
    background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3);
    color: #fca5a5; border-radius: 8px; padding: 8px 20px; font-size: 13px;
    font-weight: 600; cursor: pointer; transition: all 0.15s;
}
.pw-btn-leave:hover { background: rgba(239,68,68,0.25); }

/* Failed state */
.pw-failed { display: flex; flex-direction: column; align-items: center; gap: 12px; width: 100%; }
</style>
