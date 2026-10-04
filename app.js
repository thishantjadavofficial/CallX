// ─── CONFIG ────────────────────────────────────────────────────────
const SUPABASE_URL     = 'https://yapdgdarusmfsifeqdwi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhcGRnZGFydXNtZnNpZmVxZHdpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMjQ5OTMsImV4cCI6MjEwNjcwMDk5M30.6x_3hI-3qUrpbAIW36A-MomAMp1peIv0ImGVO-UYWuc';

const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ]
};

// ─── STATE ─────────────────────────────────────────────────────────
const myId    = crypto.randomUUID();
let myName    = '';
let localStream = null;
let micOn     = true;
let camOn     = true;
const peers   = {};   // peerId → { pc, iceBuf }
const names   = {};   // peerId → displayName

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

const btnLobbyMic   = $('btn-lobby-mic');
const btnLobbyCam   = $('btn-lobby-cam');
const btnRoomMic    = $('btn-room-mic');
const btnRoomCam    = $('btn-room-cam');

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
        setStatus('No camera/mic – you can still join and listen.');
    }
}

// ─── LOBBY TOGGLE MIC ──────────────────────────────────────────────
btnLobbyMic.addEventListener('click', () => {
    micOn = !micOn;
    applyMicState();
});
btnRoomMic.addEventListener('click', () => {
    micOn = !micOn;
    applyMicState();
});
function applyMicState() {
    localStream?.getAudioTracks().forEach(t => t.enabled = micOn);
    [btnLobbyMic, btnRoomMic].forEach(b => {
        b.textContent = micOn ? '🎤 Mic On' : '🔇 Mic Off';
        b.className   = 'toggle-btn ' + (micOn ? 'active' : 'off');
    });
}

// ─── LOBBY TOGGLE CAM ──────────────────────────────────────────────
btnLobbyCam.addEventListener('click', () => {
    camOn = !camOn;
    applyCamState();
});
btnRoomCam.addEventListener('click', () => {
    camOn = !camOn;
    applyCamState();
});
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

    // Build local tile
    buildLocalTile();

    // Switch screens
    lobbyEl.style.display = 'none';
    roomEl.style.display  = 'flex';

    // Start signaling
    await startSignaling();
});

function setStatus(msg) {
    joinStatus.textContent = msg;
}

// ─── LOCAL TILE ────────────────────────────────────────────────────
function buildLocalTile() {
    const tile = document.createElement('div');
    tile.className = 'tile local';
    tile.id = 'tile-local';

    const vid = document.createElement('video');
    vid.autoplay   = true;
    vid.playsInline = true;
    vid.muted      = true;
    if (localStream) vid.srcObject = localStream;

    const label = document.createElement('div');
    label.className   = 'tile-label';
    label.textContent = `${myName} (you)`;

    tile.append(vid, label);
    videoGrid.appendChild(tile);
}

// ─── SIGNALING VIA SUPABASE REALTIME BROADCAST ────────────────────
async function startSignaling() {
    channel = sb.channel('callx-room', {
        config: { broadcast: { self: false, ack: false } }
    });

    // Someone new arrived → we (existing peer) send them an offer
    channel.on('broadcast', { event: 'peer-announce' }, async ({ payload }) => {
        if (payload.from === myId) return;
        names[payload.from] = payload.name;
        console.log('📢 peer-announce from', payload.name);
        await initiateOffer(payload.from);
    });

    // We received an SDP (offer or answer)
    channel.on('broadcast', { event: 'sdp' }, async ({ payload }) => {
        if (payload.to !== myId) return;
        const { from, name, sdp } = payload;
        names[from] = name;
        console.log(`📨 SDP ${sdp.type} from ${name}`);
        await handleSDP(from, sdp);
    });

    // We received an ICE candidate
    channel.on('broadcast', { event: 'ice' }, async ({ payload }) => {
        if (payload.to !== myId) return;
        const { from, candidate } = payload;
        const entry = peers[from];
        if (!entry) return;
        try {
            if (entry.pc.remoteDescription) {
                await entry.pc.addIceCandidate(candidate);
            } else {
                entry.iceBuf.push(candidate);
            }
        } catch(e) { console.warn('ICE add error:', e); }
    });

    // Subscribe, then announce ourselves
    channel.subscribe(async (status) => {
        console.log('Channel status:', status);
        if (status === 'SUBSCRIBED') {
            // Announce ourselves — everyone currently subscribed will get this
            await channel.send({
                type: 'broadcast',
                event: 'peer-announce',
                payload: { from: myId, name: myName }
            });
        }
    });
}

// ─── OFFER / ANSWER ────────────────────────────────────────────────
async function initiateOffer(peerId) {
    const { pc } = getOrCreatePC(peerId);

    // onnegotiationneeded fires once we addTrack below
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send('sdp', peerId, { sdp: pc.localDescription });
}

async function handleSDP(peerId, sdp) {
    const { pc, iceBuf } = getOrCreatePC(peerId);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    // Drain buffered ICE
    while (iceBuf.length) {
        try { await pc.addIceCandidate(iceBuf.shift()); } catch(e) {}
    }

    if (sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send('sdp', peerId, { sdp: pc.localDescription });
    }
}

// ─── PEER CONNECTION FACTORY ───────────────────────────────────────
function getOrCreatePC(peerId) {
    if (peers[peerId]) return peers[peerId];

    const pc = new RTCPeerConnection(ICE_CONFIG);
    const entry = { pc, iceBuf: [] };
    peers[peerId] = entry;

    // Add local tracks
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Send ICE candidates as they arrive
    pc.onicecandidate = ({ candidate }) => {
        if (candidate) send('ice', peerId, { candidate });
    };

    // When we get remote media, create a tile
    pc.ontrack = ({ streams }) => {
        if (!streams[0]) return;
        const stream = streams[0];
        let tile = $(`tile-${peerId}`);
        if (!tile) {
            tile = createRemoteTile(peerId);
        }
        const vid = tile.querySelector('video');
        if (vid.srcObject !== stream) vid.srcObject = stream;
    };

    pc.onconnectionstatechange = () => {
        console.log(`[${peerId.slice(0,6)}] state → ${pc.connectionState}`);
        if (['disconnected','failed','closed'].includes(pc.connectionState)) {
            removePeer(peerId);
        }
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
    label.textContent = names[peerId] || peerId.slice(0, 6);
    label.id = `label-${peerId}`;

    tile.append(vid, label);
    videoGrid.appendChild(tile);
    return tile;
}

function removePeer(peerId) {
    peers[peerId]?.pc.close();
    delete peers[peerId];
    $(`tile-${peerId}`)?.remove();
}

// ─── SEND HELPER ───────────────────────────────────────────────────
function send(event, toId, extra = {}) {
    channel.send({
        type: 'broadcast',
        event,
        payload: { from: myId, name: myName, to: toId, ...extra }
    });
}

// ─── BOOT ──────────────────────────────────────────────────────────
startLobby();
