const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CoTURN Configuration (supports environment variables or defaults)
const TURN_IP = process.env.TURN_IP || "";
const TURN_PORT = process.env.TURN_PORT || "3478";
const TURN_USERNAME = process.env.TURN_USERNAME || "";
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || "";
const TURN_SECRET = process.env.TURN_SECRET || "";

// API endpoint for frontend to retrieve ICE servers and TURN credentials
app.get("/api/ice-servers", (req, res) => {
    const iceServers = [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ];

    if (TURN_SECRET) {
        // Ephemeral time-based credentials (CoTURN use-auth-secret)
        const expiryTime = Math.floor(Date.now() / 1000) + 24 * 3600; // 24 hours validity
        const ephemeralUsername = `${expiryTime}:call9me_user`;
        const hmac = crypto.createHmac("sha1", TURN_SECRET);
        hmac.setEncoding("base64");
        hmac.write(ephemeralUsername);
        hmac.end();
        const ephemeralCredential = hmac.read();

        iceServers.push(
            {
                urls: `turn:${TURN_IP}:${TURN_PORT}?transport=udp`,
                username: ephemeralUsername,
                credential: ephemeralCredential
            },
            {
                urls: `turn:${TURN_IP}:${TURN_PORT}?transport=tcp`,
                username: ephemeralUsername,
                credential: ephemeralCredential
            }
        );
    } else if (TURN_IP && TURN_USERNAME && TURN_CREDENTIAL) {
        // Static credentials
        iceServers.push(
            {
                urls: `turn:${TURN_IP}:${TURN_PORT}?transport=udp`,
                username: TURN_USERNAME,
                credential: TURN_CREDENTIAL
            },
            {
                urls: `turn:${TURN_IP}:${TURN_PORT}?transport=tcp`,
                username: TURN_USERNAME,
                credential: TURN_CREDENTIAL
            }
        );
    }

    res.json({ iceServers });
});

const activeRooms = new Map(); // roomId -> { password: string|null, host: string, createdAt: number }

function getPublicRoomList() {
    const list = [];
    const emptyRooms = [];

    for (const [roomId, data] of activeRooms.entries()) {
        const room = io.sockets.adapter.rooms.get(roomId);
        const count = room ? room.size : 0;
        if (count > 0) {
            // Retrieve usernames of all connected members in this room
            const memberNames = [];
            for (const socketId of room) {
                const s = (io.sockets.sockets && io.sockets.sockets.get)
                    ? io.sockets.sockets.get(socketId)
                    : (io.of && io.of("/").sockets.get(socketId));
                const name = (s && s.username && s.username.trim().length > 0)
                    ? s.username.trim()
                    : "Anonymous";
                memberNames.push(name);
            }

            list.push({
                roomId,
                isLocked: Boolean(data.password && data.password.length > 0),
                host: (data.host && data.host.trim().length > 0) ? data.host.trim() : "Anonymous",
                count,
                members: memberNames
            });
        } else {
            emptyRooms.push(roomId);
        }
    }

    // Terminate and delete empty rooms
    for (const emptyRoomId of emptyRooms) {
        activeRooms.delete(emptyRoomId);
        console.log(`[Server] Room "${emptyRoomId}" is empty and has been terminated.`);
    }

    return list;
}

function broadcastRoomsUpdate() {
    const rooms = getPublicRoomList();
    io.emit("rooms-update", rooms);
}

// API endpoint for public active rooms list
app.get("/api/rooms", (req, res) => {
    res.json({ rooms: getPublicRoomList() });
});

app.use(express.static("docs"));

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Send initial room list on connection
    socket.emit("rooms-update", getPublicRoomList());

    socket.on("get-rooms", () => {
        socket.emit("rooms-update", getPublicRoomList());
    });

    socket.on("join-room", async (data) => {
        const roomId = typeof data === "object" ? String(data.roomId || "").trim() : String(data || "").trim();
        const rawUsername = typeof data === "object" ? String(data.username || "").trim() : "";
        const username = rawUsername.length > 0 ? rawUsername : "Anonymous";
        const password = (typeof data === "object" && data.password) ? String(data.password).trim() : "";

        if (!roomId) {
            socket.emit("join-error", "Please provide a valid Room ID.");
            return;
        }

        // If user is currently in a different room, leave that room first
        if (socket.roomId && socket.roomId !== roomId) {
            const oldRoomId = socket.roomId;
            socket.to(oldRoomId).emit("user-left", {
                id: socket.id,
                username: socket.username || "Anonymous"
            });
            await socket.leave(oldRoomId);
            const oldRoom = io.sockets.adapter.rooms.get(oldRoomId);
            if (!oldRoom || oldRoom.size === 0) {
                activeRooms.delete(oldRoomId);
                console.log(`[Server] Room "${oldRoomId}" is empty and has been terminated.`);
            }
        }

        // Room password validation
        if (activeRooms.has(roomId)) {
            const roomData = activeRooms.get(roomId);
            if (roomData.password && roomData.password.length > 0) {
                if (!password) {
                    socket.emit("password-required", {
                        roomId,
                        host: roomData.host || "Anonymous"
                    });
                    return;
                }
                if (roomData.password !== password) {
                    socket.emit("join-error", {
                        message: `Incorrect password for room "${roomId}".`,
                        code: "INVALID_PASSWORD",
                        roomId
                    });
                    return;
                }
            }
        } else {
            // Create new room with optional password set by host
            activeRooms.set(roomId, {
                password: password.length > 0 ? password : null,
                host: username,
                createdAt: Date.now()
            });
        }

        await socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;

        const room = io.sockets.adapter.rooms.get(roomId);
        const otherUsers = Array.from(room || []).filter(id => id !== socket.id);

        console.log(`${socket.username} (${socket.id}) joined room: ${roomId}. Total in room: ${room ? room.size : 1}`);

        // Confirm successful join
        socket.emit("join-success", {
            roomId,
            isLocked: Boolean(activeRooms.get(roomId)?.password)
        });

        // Send existing room members to the newcomer
        socket.emit("all-users", otherUsers.map(id => {
            const peerSocket = (io.sockets.sockets && io.sockets.sockets.get)
                ? io.sockets.sockets.get(id)
                : (io.of && io.of("/").sockets.get(id));
            return {
                id,
                username: (peerSocket && peerSocket.username && peerSocket.username.trim().length > 0) ? peerSocket.username : "Anonymous"
            };
        }));

        // Notify existing members about the new participant
        socket.to(roomId).emit("user-joined", {
            id: socket.id,
            username: socket.username
        });

        // Update public rooms directory
        broadcastRoomsUpdate();
    });

    // Targeted Relay Signaling for Full Mesh
    socket.on("offer", ({ target, offer }) => {
        io.to(target).emit("offer", {
            caller: socket.id,
            offer,
            username: socket.username
        });
    });

    socket.on("answer", ({ target, answer }) => {
        io.to(target).emit("answer", {
            caller: socket.id,
            answer
        });
    });

    socket.on("ice-candidate", ({ target, candidate }) => {
        io.to(target).emit("ice-candidate", {
            caller: socket.id,
            candidate
        });
    });

    socket.on("screen-share-stopped", () => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit("screen-share-stopped", {
                id: socket.id
            });
        }
    });

    const handleLeave = async () => {
        if (socket.roomId) {
            const leavingRoomId = socket.roomId;
            console.log(`${socket.username} (${socket.id}) left room ${leavingRoomId}`);
            socket.to(leavingRoomId).emit("user-left", {
                id: socket.id,
                username: socket.username
            });
            await socket.leave(leavingRoomId);
            socket.roomId = null;

            const room = io.sockets.adapter.rooms.get(leavingRoomId);
            if (!room || room.size === 0) {
                activeRooms.delete(leavingRoomId);
                console.log(`[Server] Room "${leavingRoomId}" has 0 participants and has been terminated.`);
            }
            broadcastRoomsUpdate();
        }
    };

    socket.on("hangup", handleLeave);
    socket.on("disconnect", handleLeave);
});

const PORT = 3000;

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
