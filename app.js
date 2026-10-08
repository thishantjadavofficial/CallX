// ─── CONFIG ────────────────────────────────────────────────────────
const SUPABASE_URL      = 'https://yapdgdarusmfsifeqdwi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhcGRnZGFydXNtZnNpZmVxZHdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMjQ5OTMsImV4cCI6MjEwNjcwMDk5M30.6x_3hI-3qUrpbAIW36A-MomAMp1peIv0ImGVO-UYWuc';

// ─── ICE CONFIG: STUN + TURN ───────────────────────────────────────
// ICE_CONFIG is built dynamically at join time by fetching live TURN
// credentials from Metered's API. See getIceConfig() below.
// Hardcoded fallback STUN servers always apply.
const STUN_ONLY = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
    ],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 10,
};

// Fetches fresh TURN credentials from Metered's Open Relay API.
// Falls back to STUN-only if the fetch fails (e.g. offline).
// IMPORTANT: Replace YOUR_APP_NAME below with the app name shown in your
// Metered dashboard → Developers tab (e.g. "callx" → "callx.metered.live")
const METERED_APP_NAME = 'YOUR_APP_NAME'; // ← replace this
const METERED_API_KEY  = 'pk_live_301dc8572f8d7d94d6ec0a4de0763e054d5fa566';

async function getIceConfig() {
    try {
        const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const iceServers = await resp.json();
        console.log('✅ TURN credentials fetched:', iceServers.length, 'servers');
        return { iceServers, iceTransportPolicy: 'all', iceCandidatePoolSize: 10 };
    } catch (e) {
        console.warn('⚠️ TURN fetch failed, using STUN-only fallback:', e.message);
        return STUN_ONLY;
    }
}

// Will be populated just before startSignaling() is called
let ICE_CONFIG = STUN_ONLY;

// ─── STATE ─────────────────────────────────────────────────────────
const myId      = crypto.randomUUID();
let myName      = '';
let localStream = null;
let micOn       = true;
let camOn       = true;
const peers     = {};   // peerId → { pc, iceBuf, restartTimer }
const names     = {};   // peerId → displayName

// ─── DOM ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const lobbyEl       = $('lobby');
const roomEl        = $('room');
const previewVideo  = $('preview-video');
const previewOffMsg = $('preview-off-msg');
const permError     = $('perm-error');
const nameInput     = $('name-input');
const joinBtn       = $('btn-join');
const joinStatus    = $('join-status');
const videoGrid     = $('video-grid');

const btnLobbyMic = $('btn-lobby-mic');
const btnLobbyCam = $('btn-lobby-cam');
const btnRoomMic  = $('btn-room-mic');
const btnRoomCam  = $('btn-room-cam');

// ─── SUPABASE ──────────────────────────────────────────────────────
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let channel = null;

// ─── LOBBY INIT ────────────────────────────────────────────────────
async function startLobby() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        previewVideo.srcObject = localStream;
        previewOffMsg.style.display = 'none';
        setStatus('');
    } catch (err) {
        console.warn('Camera/mic error:', err);
        permError.style.display = 'block';
        previewOffMsg.style.display = 'flex';
        setStatus('No camera/mic — you can still join and listen.');
    }
}

// ─── MIC TOGGLE ────────────────────────────────────────────────────
btnLobbyMic.addEventListener('click', () => { micOn = !micOn; applyMicState(); });
btnRoomMic.addEventListener('click',  () => { micOn = !micOn; applyMicState(); });
function applyMicState() {
    localStream?.getAudioTracks().forEach(t => t.enabled = micOn);
    [btnLobbyMic, btnRoomMic].forEach(b => {
        b.textContent = micOn ? '🎤 Mic On' : '🔇 Mic Off';
        b.className   = 'toggle-btn ' + (micOn ? 'active' : 'off');
    });
}

// ─── CAM TOGGLE ────────────────────────────────────────────────────
btnLobbyCam.addEventListener('click', () => { camOn = !camOn; applyCamState(); });
btnRoomCam.addEventListener('click',  () => { camOn = !camOn; applyCamState(); });
function applyCamState() {
    localStream?.getVideoTracks().forEach(t => t.enabled = camOn);
    previewOffMsg.style.display = camOn ? 'none' : 'flex';
    [btnLobbyCam, btnRoomCam].forEach(b => {
        b.textContent = camOn ? '📷 Cam On' : '📷 Cam Off';
        b.className   = 'toggle-btn ' + (camOn ? 'active' : 'off');
    });
}

// ─── JOIN ──────────────────────────────────────────────────────────
joinBtn.addEventListener('click', async () => {
    myName = nameInput.value.trim();
    if (!myName) { nameInput.focus(); return; }

    joinBtn.disabled = true;
    setStatus('Connecting…');
    buildLocalTile();

    lobbyEl.style.display = 'none';
    roomEl.style.display  = 'flex';

    // Fetch live TURN credentials before connecting — critical for international relay
    ICE_CONFIG = await getIceConfig();

    await startSignaling();
});

function setStatus(msg) { joinStatus.textContent = msg; }

// ─── LOCAL TILE ────────────────────────────────────────────────────
function buildLocalTile() {
    const tile = document.createElement('div');
    tile.className = 'tile local';
    tile.id = 'tile-local';

    const vid = document.createElement('video');
    vid.autoplay    = true;
    vid.playsInline = true;
    vid.muted       = true;
    if (localStream) vid.srcObject = localStream;

    const label = document.createElement('div');
    label.className   = 'tile-label';
    label.textContent = `${myName} (you)`;

    tile.append(vid, label);
    videoGrid.appendChild(tile);
}

// ─── SIGNALING ─────────────────────────────────────────────────────
// Flow:
//   1. New user subscribes → sends `peer-hello` (broadcast to room)
//   2. Existing users receive `peer-hello` → reply directly with `peer-hello-ack` (unicast)
//   3. New user receives `peer-hello-ack` from each existing peer → creates PC + sends offer
//   4. Existing peers also create PC + send offer to new user on seeing `peer-hello`
//      (both sides try → perfect negotiation handles the collision)
// This two-way handshake ensures no peer is missed regardless of join timing.

async function startSignaling() {
    channel = sb.channel('callx-room-v2', {
        config: { broadcast: { self: false, ack: false } }
    });

    // ── A new peer announced themselves ────────────────────────────
    channel.on('broadcast', { event: 'peer-hello' }, async ({ payload }) => {
        if (payload.from === myId) return;
        names[payload.from] = payload.name;
        console.log('👋 peer-hello from', payload.name);

        // Reply so they know we exist too (unicast back)
        send('peer-hello-ack', payload.from, {});

        // Start connection from our side (we're the existing peer)
        await startOffer(payload.from);
    });

    // ── An existing peer acknowledged us ───────────────────────────
    channel.on('broadcast', { event: 'peer-hello-ack' }, async ({ payload }) => {
        if (payload.to !== myId) return;
        names[payload.from] = payload.name;
        console.log('✅ peer-hello-ack from', payload.name);

        // Now we (the new joiner) initiate connection to this existing peer
        await startOffer(payload.from);
    });

    // ── SDP offer / answer ─────────────────────────────────────────
    channel.on('broadcast', { event: 'sdp' }, async ({ payload }) => {
        if (payload.to !== myId) return;
        const { from, name, sdp } = payload;
        names[from] = name;
        console.log(`📨 SDP ${sdp.type} from ${name}`);
        await handleSDP(from, sdp);
    });

    // ── ICE candidates ─────────────────────────────────────────────
    channel.on('broadcast', { event: 'ice' }, async ({ payload }) => {
        if (payload.to !== myId) return;
        const { from, candidate } = payload;
        if (!candidate) return;

        const entry = peers[from];
        if (!entry) return;

        try {
            if (entry.pc.remoteDescription && entry.pc.remoteDescription.type) {
                await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
            } else {
                entry.iceBuf.push(candidate);
            }
        } catch (e) { console.warn('ICE add error:', e); }
    });

    // ── Subscribe → announce ourselves ─────────────────────────────
    channel.subscribe(async (status) => {
        console.log('📡 Channel:', status);
        if (status === 'SUBSCRIBED') {
            // Broadcast our presence to everyone in the room
            await channel.send({
                type: 'broadcast',
                event: 'peer-hello',
                payload: { from: myId, name: myName }
            });
        }
    });
}

// ─── OFFER ─────────────────────────────────────────────────────────
async function startOffer(peerId) {
    // Guard: don't make a duplicate offer if PC already exists and is progressing
    if (peers[peerId]) {
        const state = peers[peerId].pc.signalingState;
        if (state !== 'stable' && state !== 'closed') return;
    }

    const { pc } = getOrCreatePC(peerId);
    try {
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        send('sdp', peerId, { sdp: pc.localDescription });
    } catch (e) {
        console.error('Offer error:', e);
    }
}

// ─── SDP HANDLER (Perfect Negotiation) ────────────────────────────
async function handleSDP(peerId, sdp) {
    const { pc, iceBuf } = getOrCreatePC(peerId);

    // Perfect negotiation: the peer with the lexicographically smaller ID is "polite"
    const polite = myId < peerId;
    const collision = sdp.type === 'offer' && pc.signalingState !== 'stable';

    if (!polite && collision) {
        // Impolite peer: ignore colliding offer
        console.log('⚠️ Collision — ignoring offer (impolite)');
        return;
    }

    try {
        if (polite && collision) {
            // Polite peer: rollback own offer, accept theirs
            await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));

        // Drain buffered ICE candidates
        while (iceBuf.length) {
            try { await pc.addIceCandidate(new RTCIceCandidate(iceBuf.shift())); } catch(e) {}
        }

        if (sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            send('sdp', peerId, { sdp: pc.localDescription });
        }
    } catch (e) {
        console.error('SDP handle error:', e);
    }
}

// ─── PEER CONNECTION FACTORY ───────────────────────────────────────
function getOrCreatePC(peerId) {
    if (peers[peerId]) return peers[peerId];

    const pc = new RTCPeerConnection(ICE_CONFIG);
    const entry = { pc, iceBuf: [], restartTimer: null };
    peers[peerId] = entry;

    // Add all local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Trickle ICE — send each candidate as it arrives for low latency
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) send('ice', peerId, { candidate: candidate.toJSON() });
    };

    pc.onicegatheringstatechange = () => {
        console.log(`[${peerId.slice(0,6)}] ICE gathering: ${pc.iceGatheringState}`);
    };

    // When remote media tracks arrive → render video tile
    pc.ontrack = ({ streams }) => {
        if (!streams || !streams[0]) return;
        const stream = streams[0];
        let tile = $(`tile-${peerId}`);
        if (!tile) tile = createRemoteTile(peerId);
        const vid = tile.querySelector('video');
        if (vid.srcObject !== stream) vid.srcObject = stream;
    };

    // Monitor connection health; attempt ICE restart on failure
    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[${peerId.slice(0,6)}] connection: ${state}`);

        if (state === 'failed') {
            // Try ICE restart before giving up
            console.log(`🔄 ICE restart for ${peerId.slice(0,6)}`);
            pc.restartIce();
            // If still failing after 8s, fully close and remove
            entry.restartTimer = setTimeout(() => {
                if (pc.connectionState !== 'connected') removePeer(peerId);
            }, 8000);
        }

        if (state === 'disconnected') {
            // Short grace period — mobile can bounce between states briefly
            entry.restartTimer = setTimeout(() => {
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                    pc.restartIce();
                }
            }, 3000);
        }

        if (state === 'closed') removePeer(peerId);

        if (state === 'connected') {
            // Clear any pending restart timers
            clearTimeout(entry.restartTimer);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[${peerId.slice(0,6)}] ICE: ${pc.iceConnectionState}`);
    };

    return entry;
}

// ─── TILE HELPERS ──────────────────────────────────────────────────
function createRemoteTile(peerId) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = `tile-${peerId}`;

    const vid = document.createElement('video');
    vid.autoplay    = true;
    vid.playsInline = true;

    const label = document.createElement('div');
    label.className   = 'tile-label';
    label.id          = `label-${peerId}`;
    label.textContent = names[peerId] || `User ${peerId.slice(0, 5)}`;

    tile.append(vid, label);
    videoGrid.appendChild(tile);
    return tile;
}

function removePeer(peerId) {
    const entry = peers[peerId];
    if (entry) {
        clearTimeout(entry.restartTimer);
        entry.pc.close();
        delete peers[peerId];
    }
    $(`tile-${peerId}`)?.remove();
}

// ─── SEND HELPER ───────────────────────────────────────────────────
function send(event, toId, extra = {}) {
    if (!channel) return;
    channel.send({
        type: 'broadcast',
        event,
        payload: { from: myId, name: myName, to: toId, ...extra }
    });
}

// ─── LEAVE CALL ────────────────────────────────────────────────────
$('btn-leave').addEventListener('click', leaveCall);

async function leaveCall() {
    Object.keys(peers).forEach(removePeer);

    localStream?.getTracks().forEach(t => t.stop());
    localStream = null;

    if (channel) {
        await sb.removeChannel(channel);
        channel = null;
    }

    videoGrid.innerHTML = '';
    micOn = true;
    camOn = true;
    joinBtn.disabled  = false;
    nameInput.value   = '';

    roomEl.style.display  = 'none';
    lobbyEl.style.display = 'flex';
    startLobby();
}

// ─── BOOT ──────────────────────────────────────────────────────────
startLobby();
