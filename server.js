const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("docs"));

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomId) => {
        socket.join(roomId);

        const room = io.sockets.adapter.rooms.get(roomId);
        const numberOfUsers = room ? room.size : 0;

        console.log(`${socket.id} joined ${roomId}`);

        if (numberOfUsers === 2) {
            socket.to(roomId).emit("user-ready");
        }

        if (numberOfUsers > 2) {
            socket.leave(roomId);
            socket.emit("room-full");
        }
    });

    socket.on("offer", ({ roomId, offer }) => {
        socket.to(roomId).emit("offer", offer);
    });

    socket.on("answer", ({ roomId, answer }) => {
        socket.to(roomId).emit("answer", answer);
    });

    socket.on("ice-candidate", ({ roomId, candidate }) => {
        socket.to(roomId).emit("ice-candidate", candidate);
    });

    socket.on("hangup", ({ roomId }) => {
        socket.to(roomId).emit("hangup");
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

const PORT = 3000;

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});