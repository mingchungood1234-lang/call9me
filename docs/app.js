// Show username
const rawStoredName = sessionStorage.getItem("username");
const username = (rawStoredName && rawStoredName.trim().length > 0 && rawStoredName !== "null")
    ? rawStoredName.trim()
    : "Anonymous";

const statusElem = document.getElementById("status");
if (statusElem) {
    statusElem.textContent = "Welcome " + username;
}

const socket = io();

const roomInput = document.getElementById("roomInput");
const roomPassword = document.getElementById("roomPassword");
const joinButton = document.getElementById("joinButton");
const roomsList = document.getElementById("roomsList");
const refreshRoomsBtn = document.getElementById("refreshRoomsBtn");

const muteButton = document.getElementById("muteButton");
const screenShareButton = document.getElementById("screenShareButton");
const hangupButton = document.getElementById("hangupButton");

// Detect if client is running iOS (iPhone / iPad / iPod / iOS Safari)
function isIOSDevice() {
    const ua = window.navigator.userAgent;
    const isStandardIOS = /iPhone|iPad|iPod/i.test(ua);
    const isIPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return isStandardIOS || isIPadOS;
}

// Automatically remove screen share button on iOS Safari devices
if (isIOSDevice() && screenShareButton) {
    screenShareButton.remove();
    console.log("iOS device detected: Screen share button removed from controls.");
}

const status = document.getElementById("status");
const callStatus = document.getElementById("callStatus");
const callStatusPill = document.querySelector(".call-status-pill");
const callName = document.getElementById("callName");
const participantCount = document.getElementById("participantCount");

const remoteAudio = document.getElementById("remoteAudio");
const videoGrid = document.getElementById("videoGrid");
const avatarWrapper = document.getElementById("avatarWrapper");
const audioContainer = document.getElementById("audioContainer");

let roomId = null;

// Multi-Peer Mesh State: peers[peerId] = { connection, candidateQueue, audioElem, username, isScreenSharing }
let peers = {};
let localStream = null;
let screenStream = null;
let isScreenSharing = false;
let muted = false;

// Active Screen Sharing Streams Map: key ("local" | peerId) -> { stream, labelText, isHost, cardElem, videoElem }
const activeScreens = new Map();

function toggleCardFullscreen(card, video) {
    const target = card || video;
    if (!target) return;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (target.requestFullscreen) {
            target.requestFullscreen().catch(err => {
                if (video && video.webkitEnterFullscreen) {
                    video.webkitEnterFullscreen();
                }
            });
        } else if (target.webkitRequestFullscreen) {
            target.webkitRequestFullscreen();
        } else if (video && video.webkitEnterFullscreen) {
            video.webkitEnterFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
}

function updateVideoGridLayout() {
    if (!videoGrid) return;
    const count = activeScreens.size;
    if (count > 0) {
        videoGrid.classList.add("active");
        if (count >= 2) {
            videoGrid.classList.add("multi-screens");
        } else {
            videoGrid.classList.remove("multi-screens");
        }
        if (avatarWrapper) avatarWrapper.classList.add("hidden");
    } else {
        videoGrid.classList.remove("active");
        videoGrid.classList.remove("multi-screens");
        if (avatarWrapper) avatarWrapper.classList.remove("hidden");
    }
}

function addOrUpdateScreenCard(key, stream, labelText = "Screen Stream", isHost = false) {
    if (!videoGrid) return;

    let entry = activeScreens.get(key);
    if (!entry) {
        const card = document.createElement("div");
        card.className = "screen-card";
        card.id = `screen-card-${key}`;

        const video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute("webkit-playsinline", "true");
        video.muted = true;
        video.srcObject = stream;

        const badge = document.createElement("div");
        badge.className = "video-badge";
        badge.textContent = labelText;

        card.appendChild(video);
        card.appendChild(badge);

        // Fullscreen button for viewers
        if (!isHost) {
            const fsBtn = document.createElement("button");
            fsBtn.type = "button";
            fsBtn.className = "fullscreen-btn";
            fsBtn.title = "Full Screen View";
            fsBtn.innerHTML = `
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
                </svg>
            `;
            fsBtn.addEventListener("click", () => toggleCardFullscreen(card, video));
            card.appendChild(fsBtn);
        }

        // Double click shortcut to toggle fullscreen
        card.addEventListener("dblclick", () => toggleCardFullscreen(card, video));

        videoGrid.appendChild(card);
        video.play().catch(e => console.warn("Video play note:", e));

        entry = { stream, labelText, isHost, cardElem: card, videoElem: video };
        activeScreens.set(key, entry);
    } else {
        entry.stream = stream;
        entry.labelText = labelText;
        if (entry.videoElem && entry.videoElem.srcObject !== stream) {
            entry.videoElem.srcObject = stream;
            entry.videoElem.play().catch(e => console.warn(e));
        }
        const badge = entry.cardElem.querySelector(".video-badge");
        if (badge) badge.textContent = labelText;
    }

    updateVideoGridLayout();
}

function removeScreenCard(key) {
    const entry = activeScreens.get(key);
    if (entry) {
        if (entry.videoElem) {
            entry.videoElem.srcObject = null;
        }
        if (entry.cardElem) {
            entry.cardElem.remove();
        }
        activeScreens.delete(key);
    }
    updateVideoGridLayout();
}

let configuration = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};

let iceServersPromise = null;

async function fetchIceServers() {
    if (!iceServersPromise) {
        iceServersPromise = (async () => {
            try {
                const response = await fetch("/api/ice-servers");
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                if (data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
                    configuration = {
                        iceServers: data.iceServers
                    };
                    console.log("Loaded ICE servers configuration from API:", configuration.iceServers);
                }
            } catch (error) {
                console.warn("Could not fetch ICE servers from API, using STUN fallback:", error);
            }
            return configuration;
        })();
    }
    return iceServersPromise;
}

// Prefetch ICE configuration immediately
fetchIceServers();

// Experiment Mode Toggle (Google STUN vs CoTURN)
let selectedIceMode = localStorage.getItem("call9me_ice_mode") || "turn"; // "stun" | "turn"
const modeStunBtn = document.getElementById("modeStun");
const modeTurnBtn = document.getElementById("modeTurn");
const currentModeLabel = document.getElementById("currentModeLabel");

function updateModeUI() {
    if (selectedIceMode === "stun") {
        if (modeStunBtn) modeStunBtn.classList.add("active");
        if (modeTurnBtn) modeTurnBtn.classList.remove("active");
        if (currentModeLabel) currentModeLabel.textContent = "Google STUN Only";
    } else {
        if (modeTurnBtn) modeTurnBtn.classList.add("active");
        if (modeStunBtn) modeStunBtn.classList.remove("active");
        if (currentModeLabel) currentModeLabel.textContent = "STUN + CoTURN";
    }
}

if (modeStunBtn) {
    modeStunBtn.addEventListener("click", () => {
        selectedIceMode = "stun";
        localStorage.setItem("call9me_ice_mode", "stun");
        updateModeUI();
        console.log("[ICE Experiment] Active mode switched to STUN Only");
    });
}

if (modeTurnBtn) {
    modeTurnBtn.addEventListener("click", () => {
        selectedIceMode = "turn";
        localStorage.setItem("call9me_ice_mode", "turn");
        updateModeUI();
        console.log("[ICE Experiment] Active mode switched to STUN + CoTURN");
    });
}

updateModeUI();

async function startMicrophone() {
    if (localStream) {
        return localStream;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn("getUserMedia is not supported or not on HTTPS/localhost");
        return null;
    }
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        });
        return localStream;
    } catch (err) {
        console.warn("Could not capture microphone (proceeding in listen/watch mode):", err);
        return null;
    }
}

function updateParticipantCount() {
    const peerCount = Object.keys(peers).length;
    const totalCount = peerCount + 1;

    if (roomId) {
        if (participantCount) {
            participantCount.style.display = "inline-flex";
            participantCount.textContent = `👥 ${totalCount} in call`;
        }
        if (callName) {
            callName.textContent = `Room: ${roomId}`;
        }
        if (callStatus) {
            if (totalCount >= 2) {
                callStatus.textContent = "Connected";
                if (callStatusPill) callStatusPill.classList.add("connected");
            } else {
                callStatus.textContent = "Waiting for others to join...";
                if (callStatusPill) callStatusPill.classList.remove("connected");
            }
        }
    } else {
        if (participantCount) {
            participantCount.style.display = "none";
        }
        if (callStatus) {
            callStatus.textContent = "Not connected";
            if (callStatusPill) callStatusPill.classList.remove("connected");
        }
        if (callName) {
            callName.textContent = "Waiting for call";
        }
    }
}

async function addCandidateForPeer(peerId, candidate) {
    const peer = peers[peerId];
    if (!peer || !peer.connection || !peer.connection.remoteDescription || !peer.connection.remoteDescription.type) {
        if (peer) {
            peer.candidateQueue.push(candidate);
        }
        return;
    }
    try {
        await peer.connection.addIceCandidate(candidate);
    } catch (e) {
        console.warn(`Error adding ICE candidate for ${peerId}:`, e);
    }
}

async function processCandidateQueueFor(peerId) {
    const peer = peers[peerId];
    if (!peer || !peer.connection || !peer.connection.remoteDescription) return;
    while (peer.candidateQueue.length > 0) {
        const candidate = peer.candidateQueue.shift();
        try {
            await peer.connection.addIceCandidate(candidate);
        } catch (e) {
            console.warn(`Error processing queued candidate for ${peerId}:`, e);
        }
    }
}

async function getOrCreatePeer(peerId, peerUsername = "User", isInitiator = false) {
    if (peers[peerId]) {
        return peers[peerId];
    }

    console.log(`[Mesh] Initializing peer connection with ${peerUsername} (${peerId}), isInitiator: ${isInitiator}`);

    let activeConfig;
    if (selectedIceMode === "stun") {
        activeConfig = {
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        };
    } else {
        await fetchIceServers();
        activeConfig = configuration;
    }

    const pc = new RTCPeerConnection(activeConfig);

    // Dedicated audio element for this peer
    let audio = document.getElementById(`audio-${peerId}`);
    if (!audio) {
        audio = document.createElement("audio");
        audio.id = `audio-${peerId}`;
        audio.autoplay = true;
        if (audioContainer) {
            audioContainer.appendChild(audio);
        }
    }

    peers[peerId] = {
        connection: pc,
        candidateQueue: [],
        audioElem: audio,
        username: peerUsername,
        isScreenSharing: false,
        remoteVideoStream: null,
        senders: {}
    };

    // Add local microphone audio track if available, else add transceiver
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peers[peerId].senders[track.kind] = pc.addTrack(track, localStream);
        });
    } else {
        try {
            pc.addTransceiver("audio", { direction: "recvonly" });
            pc.addTransceiver("video", { direction: "recvonly" });
        } catch (e) {
            console.warn("Could not add transceivers:", e);
        }
    }

    // Add local screen video track if currently sharing
    if (isScreenSharing && screenStream) {
        const screenTrack = screenStream.getVideoTracks()[0];
        if (screenTrack) {
            peers[peerId].senders["video"] = pc.addTrack(screenTrack, screenStream);
        }
    }

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit("ice-candidate", {
                target: peerId,
                candidate: event.candidate
            });
        }
    };

    pc.ontrack = event => {
        console.log(`[Mesh Track Received from ${peerUsername} (${peerId})]:`, event.track.kind);

        const stream = (event.streams && event.streams.length > 0)
            ? event.streams[0]
            : new MediaStream([event.track]);

        if (event.track.kind === "audio") {
            audio.srcObject = stream;
            audio.play().catch(e => console.warn(`Audio playback error for ${peerId}:`, e));
        }

        if (event.track.kind === "video") {
            peers[peerId].isScreenSharing = true;
            peers[peerId].remoteVideoStream = stream;
            addOrUpdateScreenCard(peerId, stream, `${peerUsername}'s Screen`, false);

            event.track.onended = () => {
                peers[peerId].isScreenSharing = false;
                peers[peerId].remoteVideoStream = null;
                removeScreenCard(peerId);
            };
        }

        updateParticipantCount();
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${peerUsername} (${peerId}):`, pc.connectionState);
        if (pc.connectionState === "connected") {
            updateParticipantCount();
        } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            removePeer(peerId);
        } else if (pc.connectionState === "disconnected") {
            setTimeout(() => {
                if (peers[peerId] && (peers[peerId].connection.connectionState === "disconnected" || peers[peerId].connection.connectionState === "failed")) {
                    console.log(`Peer ${peerUsername} (${peerId}) disconnected permanently. Removing.`);
                    removePeer(peerId);
                }
            }, 3000);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with ${peerUsername} (${peerId}):`, pc.iceConnectionState);
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            updateParticipantCount();
        }
    };

    updateParticipantCount();

    if (isInitiator) {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("offer", {
                target: peerId,
                offer
            });
        } catch (err) {
            console.error(`Error sending offer to ${peerId}:`, err);
        }
    }

    return peers[peerId];
}

async function removePeer(peerId) {
    if (peers[peerId]) {
        console.log(`[Mesh] Removing peer ${peerId}`);
        try {
            peers[peerId].connection.close();
        } catch (e) {
            console.warn(e);
        }

        const audio = document.getElementById(`audio-${peerId}`);
        if (audio) {
            audio.srcObject = null;
            audio.remove();
        }

        removeScreenCard(peerId);
        delete peers[peerId];
        updateParticipantCount();
    }
}

// Screen Sharing for Multi-Peer Mesh
async function startScreenShare() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("Screen sharing requires a secure HTTPS connection and iOS 15.1+ if on iPhone.");
        return;
    }

    if (!roomId) {
        alert("Please join a call room first before sharing your screen.");
        return;
    }

    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: true
        });

        const screenTrack = screenStream.getVideoTracks()[0];
        if (!screenTrack) {
            throw new Error("No screen video track returned by device.");
        }

        isScreenSharing = true;
        if (screenShareButton) {
            screenShareButton.classList.add("active");
            screenShareButton.title = "Stop Sharing Screen";
        }

        // Show local preview card in dynamic grid
        addOrUpdateScreenCard("local", screenStream, "Your Screen (Live)", true);

        // Add track to all connected peers and renegotiate
        for (const peerId in peers) {
            const pc = peers[peerId].connection;
            const senders = pc.getSenders();
            const existingVideoSender = senders.find(s => s.track && s.track.kind === "video");

            if (existingVideoSender) {
                await existingVideoSender.replaceTrack(screenTrack);
                peers[peerId].senders["video"] = existingVideoSender;
            } else {
                peers[peerId].senders["video"] = pc.addTrack(screenTrack, screenStream);
            }

            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit("offer", {
                    target: peerId,
                    offer
                });
            } catch (err) {
                console.error(`Renegotiation error for ${peerId}:`, err);
            }
        }

        screenTrack.onended = () => {
            stopScreenShare();
        };

    } catch (error) {
        console.error("Error starting screen share:", error);
        if (error.name !== "NotAllowedError" && error.name !== "AbortError") {
            alert("Could not start screen share: " + error.message);
        }
    }
}

async function stopScreenShare() {
    if (!isScreenSharing && !screenStream) return;

    isScreenSharing = false;

    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }

    removeScreenCard("local");

    for (const peerId in peers) {
        const pc = peers[peerId].connection;
        const videoSender = peers[peerId].senders["video"];
        if (videoSender && pc) {
            try {
                pc.removeTrack(videoSender);
            } catch (e) {
                console.warn(e);
            }
            delete peers[peerId].senders["video"];
        }

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit("offer", {
                target: peerId,
                offer
            });
        } catch (err) {
            console.error(`Renegotiation error for ${peerId}:`, err);
        }
    }

    if (screenShareButton) {
        screenShareButton.classList.remove("active");
        screenShareButton.title = "Share Screen";
    }

    socket.emit("screen-share-stopped");
}

async function toggleScreenShare() {
    if (isScreenSharing) {
        await stopScreenShare();
    } else {
        await startScreenShare();
    }
}

if (screenShareButton) {
    screenShareButton.addEventListener("click", toggleScreenShare);
}

// Public Rooms Directory Rendering
function renderRoomsList(rooms) {
    if (!roomsList) return;
    if (!rooms || rooms.length === 0) {
        roomsList.innerHTML = '<div class="no-rooms-msg">No active rooms right now. Create one above!</div>';
        return;
    }

    roomsList.innerHTML = "";
    rooms.forEach(r => {
        const card = document.createElement("div");
        card.className = "room-card";

        const info = document.createElement("div");
        info.className = "room-card-info";

        const headerRow = document.createElement("div");
        headerRow.className = "room-card-header-row";

        const lockIcon = document.createElement("span");
        lockIcon.className = "room-lock-tag";
        lockIcon.textContent = r.isLocked ? "🔒" : "🔓";
        lockIcon.title = r.isLocked ? "Password Protected" : "Public";

        const idTag = document.createElement("span");
        idTag.className = "room-id-tag";
        idTag.textContent = r.roomId;

        const countTag = document.createElement("span");
        countTag.className = "room-count-tag";
        countTag.textContent = `👥 ${r.count}`;

        headerRow.appendChild(lockIcon);
        headerRow.appendChild(idTag);
        headerRow.appendChild(countTag);
        info.appendChild(headerRow);

        // Display usernames in the room
        if (r.members && r.members.length > 0) {
            const membersRow = document.createElement("div");
            membersRow.className = "room-members-row";
            membersRow.textContent = `Users: ${r.members.join(", ")}`;
            membersRow.title = `In room: ${r.members.join(", ")}`;
            info.appendChild(membersRow);
        }

        const joinBtn = document.createElement("button");
        joinBtn.type = "button";
        joinBtn.className = "room-join-action-btn";
        joinBtn.textContent = "Join";
        joinBtn.addEventListener("click", async () => {
            roomInput.value = r.roomId;
            await handleJoinRoom();
        });

        card.appendChild(info);
        card.appendChild(joinBtn);
        roomsList.appendChild(card);
    });
}

if (refreshRoomsBtn) {
    refreshRoomsBtn.addEventListener("click", () => {
        socket.emit("get-rooms");
    });
}

// Join Room Button
const handleJoinRoom = async () => {
    const targetRoomId = roomInput.value.trim();
    const password = roomPassword ? roomPassword.value.trim() : "";

    if (!targetRoomId) {
        alert("Enter a call ID");
        return;
    }

    callStatus.textContent = "Connecting...";

    // Attempt to start microphone (proceeds in listen mode if unavailable/denied)
    await startMicrophone();

    socket.emit("join-room", {
        roomId: targetRoomId,
        username,
        password
    });
};

joinButton.addEventListener("click", handleJoinRoom);

if (roomInput) {
    roomInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            handleJoinRoom();
        }
    });
}

if (roomPassword) {
    roomPassword.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            handleJoinRoom();
        }
    });
}

// Initial fetch and real-time room sync
async function fetchPublicRooms() {
    try {
        const res = await fetch("/api/rooms");
        if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.rooms)) {
                renderRoomsList(data.rooms);
            }
        }
    } catch (err) {
        console.warn("Could not fetch /api/rooms:", err);
    }
    if (socket && socket.connected) {
        socket.emit("get-rooms");
    }
}

socket.on("connect", () => {
    socket.emit("get-rooms");
});

fetchPublicRooms();

// Socket Room Directory & Security Events
socket.on("rooms-update", (rooms) => {
    renderRoomsList(rooms);
});

socket.on("password-required", async ({ roomId: reqRoomId, host }) => {
    roomId = null;
    updateParticipantCount();

    const promptMsg = host
        ? `🔒 Room "${reqRoomId}" is password-protected by host "${host}".\nPlease enter the password to join:`
        : `🔒 Room "${reqRoomId}" is password-protected.\nPlease enter the room password to join:`;

    const pass = prompt(promptMsg);
    if (pass !== null && pass.trim().length > 0) {
        if (roomPassword) roomPassword.value = pass.trim();
        callStatus.textContent = "Authenticating...";
        await startMicrophone();
        socket.emit("join-room", {
            roomId: reqRoomId,
            username,
            password: pass.trim()
        });
    } else {
        callStatus.textContent = "Not connected";
    }
});

socket.on("join-error", async (data) => {
    roomId = null;
    updateParticipantCount();

    const msg = typeof data === "object" ? data.message : data;
    const code = typeof data === "object" ? data.code : null;
    const errRoomId = typeof data === "object" ? data.roomId : null;

    if (code === "INVALID_PASSWORD" && errRoomId) {
        const retryPass = prompt(`❌ ${msg}\nPlease try entering the password again:`);
        if (retryPass !== null && retryPass.trim().length > 0) {
            if (roomPassword) roomPassword.value = retryPass.trim();
            callStatus.textContent = "Authenticating...";
            await startMicrophone();
            socket.emit("join-room", {
                roomId: errRoomId,
                username,
                password: retryPass.trim()
            });
            return;
        }
    } else {
        alert(msg);
    }
    callStatus.textContent = "Not connected";
});

socket.on("join-success", ({ roomId: joinedRoomId }) => {
    roomId = joinedRoomId;
    status.textContent = `Room: ${joinedRoomId}`;
    updateParticipantCount();
});

// Socket Mesh Signaling Events

// Receive list of existing users when joining a room
socket.on("all-users", async (users) => {
    console.log("[Mesh] Existing users in room:", users);
    for (const u of users) {
        // We are the newcomer, so we initiate connection & send offer to each existing member
        await getOrCreatePeer(u.id, u.username, true);
    }
    updateParticipantCount();
});

// Another user joined the room
socket.on("user-joined", async ({ id, username: peerUsername }) => {
    console.log(`[Mesh] New user joined: ${peerUsername} (${id})`);
    // Existing users wait for newcomer's offer
    await getOrCreatePeer(id, peerUsername, false);
    updateParticipantCount();
});

// Receive SDP Offer
socket.on("offer", async ({ caller, offer, username: callerUsername }) => {
    console.log(`[Mesh] Received offer from ${callerUsername} (${caller})`);
    const peer = await getOrCreatePeer(caller, callerUsername, false);

    await peer.connection.setRemoteDescription(offer);
    await processCandidateQueueFor(caller);

    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);

    socket.emit("answer", {
        target: caller,
        answer
    });
});

// Receive SDP Answer
socket.on("answer", async ({ caller, answer }) => {
    console.log(`[Mesh] Received answer from ${caller}`);
    const peer = peers[caller];
    if (peer && peer.connection) {
        await peer.connection.setRemoteDescription(answer);
        await processCandidateQueueFor(caller);
    }
});

// Receive ICE Candidate
socket.on("ice-candidate", async ({ caller, candidate }) => {
    await addCandidateForPeer(caller, candidate);
});

// A participant left
socket.on("user-left", ({ id, username: leftUsername }) => {
    console.log(`[Mesh] User left: ${leftUsername} (${id})`);
    removePeer(id);
});

// Screen share stopped by remote participant
socket.on("screen-share-stopped", ({ id }) => {
    console.log(`[Mesh] Peer ${id} stopped screen sharing`);
    if (peers[id]) {
        peers[id].isScreenSharing = false;
        peers[id].remoteVideoStream = null;
    }
    removeScreenCard(id);
});

// Microphone Mute Toggle
muteButton.addEventListener(
    "click",
    () => {
        if (!localStream) {
            return;
        }

        muted = !muted;

        localStream
            .getAudioTracks()
            .forEach(track => {
                track.enabled = !muted;
            });

        muteButton.textContent = muted ? "🔇" : "🎤";
    }
);

// End / Leave Call
function endCall() {
    if (isScreenSharing) {
        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
        }
        isScreenSharing = false;
        if (screenShareButton) {
            screenShareButton.classList.remove("active");
            screenShareButton.title = "Share Screen";
        }
    }

    // Clear all active screens
    const screenKeys = Array.from(activeScreens.keys());
    screenKeys.forEach(key => removeScreenCard(key));
    activeScreens.clear();
    updateVideoGridLayout();

    // Close all mesh connections
    for (const peerId in peers) {
        try {
            peers[peerId].connection.close();
        } catch (e) {
            console.warn(e);
        }
    }
    peers = {};

    // Clear dynamic audio elements
    if (audioContainer) {
        audioContainer.innerHTML = "";
    }

    if (remoteAudio) {
        remoteAudio.srcObject = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    roomId = null;
    updateParticipantCount();

    callStatus.textContent = "Call ended";
    if (callName) {
        callName.textContent = "Waiting for call";
    }
}

hangupButton.addEventListener(
    "click",
    () => {
        if (socket && roomId) {
            socket.emit("hangup");
        }
        endCall();
    }
);