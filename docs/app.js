//show username
const username = sessionStorage.getItem("username");
document.getElementById("status").textContent = "Welcome "+ username;
//show username
const socket = io();

const roomInput = document.getElementById("roomInput");
const joinButton = document.getElementById("joinButton");

const muteButton = document.getElementById("muteButton");
const hangupButton = document.getElementById("hangupButton");

const status = document.getElementById("status");
const callStatus = document.getElementById("callStatus");

const remoteAudio = document.getElementById("remoteAudio");

let roomId;

let peerConnection;
let localStream;

let muted = false;

const configuration = {

    iceServers: [

        {
            urls: "stun:stun.l.google.com:19302"
        }

    ]

};


async function startMicrophone() {

    if (localStream) {
        return;
    }

    localStream =
        await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
        });

}

function createPeerConnection() {

    peerConnection =
        new RTCPeerConnection(configuration);

    localStream
        .getTracks()
        .forEach(track => {

            peerConnection.addTrack(
                track,
                localStream
            );

        });

    peerConnection.ontrack = event => {

        remoteAudio.srcObject =
            event.streams[0];

        callStatus.textContent =
            "Connected";

    };

    peerConnection.onicecandidate = event => {

        if (event.candidate) {

            socket.emit(
                "ice-candidate",
                {
                    roomId,
                    candidate: event.candidate
                }
            );

        }

    };

    peerConnection.onconnectionstatechange = () => {

        const state =
            peerConnection.connectionState;

        console.log(
            "Connection state:",
            state
        );

        callStatus.textContent =
            state;

    };

}

joinButton.addEventListener(
    "click",
    async () => {

        roomId =
            roomInput.value.trim();

        if (!roomId) {

            alert(
                "Enter a call ID"
            );

            return;

        }

        try {

            await startMicrophone();

            socket.emit(
                "join-room",
                roomId
            );

            status.textContent =
                `Room: ${roomId}`;

            callStatus.textContent =
                "Waiting for another user...";

        }

        catch (error) {

            console.error(error);

            alert(
                "Microphone permission is required."
            );

        }

    }
);

socket.on(
    "user-ready",
    async () => {

        createPeerConnection();

        const offer =
            await peerConnection.createOffer();

        await peerConnection.setLocalDescription(
            offer
        );

        socket.emit(
            "offer",
            {
                roomId,
                offer
            }
        );

        callStatus.textContent =
            "Calling...";

    }
);

socket.on(
    "offer",
    async offer => {

        createPeerConnection();

        await peerConnection.setRemoteDescription(
            offer
        );

        const answer =
            await peerConnection.createAnswer();

        await peerConnection.setLocalDescription(
            answer
        );

        socket.emit(
            "answer",
            {
                roomId,
                answer
            }
        );

    }
);

socket.on(
    "answer",
    async answer => {

        await peerConnection.setRemoteDescription(
            answer
        );

    }
);

socket.on(
    "ice-candidate",
    async candidate => {

        if (peerConnection) {

            try {

                await peerConnection.addIceCandidate(
                    candidate
                );

            }

            catch (error) {

                console.error(
                    "ICE error:",
                    error
                );

            }

        }

    }
);

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

        muteButton.textContent =
            muted
                ? "🔇"
                : "🎤";

    }
);

hangupButton.addEventListener(
    "click",
    () => {

        endCall();

        socket.emit(
            "hangup",
            {
                roomId
            }
        );

    }
);

socket.on(
    "hangup",
    () => {

        endCall();

    }
);

function endCall() {

    if (peerConnection) {

        peerConnection.close();

        peerConnection = null;

    }

    remoteAudio.srcObject = null;

    callStatus.textContent =
        "Call ended";

}