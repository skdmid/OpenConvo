const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

function cleanName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 40) : "";
}

function cleanCode(value) {
  return typeof value === "string" && /^\d{4}$/.test(value) ? value : "";
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

function membersIn(roomCode, exceptId) {
  const room = io.sockets.adapter.rooms.get(roomCode);
  if (!room) return [];
  return [...room]
    .filter((id) => id !== exceptId)
    .map((id) => {
      const peer = io.sockets.sockets.get(id);
      return peer ? { id, name: peer.data.name } : null;
    })
    .filter(Boolean);
}

function leaveCurrentRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  socket.leave(roomCode);
  socket.to(roomCode).emit("peer-left", { id: socket.id, name: socket.data.name });
  socket.data.roomCode = null;

  const remaining = io.sockets.adapter.rooms.get(roomCode);
  if (!remaining || remaining.size === 0) rooms.delete(roomCode);
}

function enterRoom(socket, roomCode, name) {
  socket.data.roomCode = roomCode;
  socket.data.name = name;
  socket.join(roomCode);
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name } = {}, reply = () => {}) => {
    name = cleanName(name);
    if (!name) return reply({ ok: false, error: "Please enter your name." });

    leaveCurrentRoom(socket);
    const roomCode = makeRoomCode();
    if (!roomCode) return reply({ ok: false, error: "Could not create a room. Please try again." });

    rooms.set(roomCode, { createdAt: Date.now() });
    enterRoom(socket, roomCode, name);
    reply({ ok: true, roomCode, peers: [] });
  });

  socket.on("join-room", ({ name, roomCode } = {}, reply = () => {}) => {
    name = cleanName(name);
    roomCode = cleanCode(roomCode);
    if (!name) return reply({ ok: false, error: "Please enter your name." });
    if (!roomCode) return reply({ ok: false, error: "Enter a four-digit meeting code." });
    if (!rooms.has(roomCode)) return reply({ ok: false, error: "That meeting is not active." });

    leaveCurrentRoom(socket);
    const peers = membersIn(roomCode, socket.id);
    enterRoom(socket, roomCode, name);
    reply({ ok: true, roomCode, peers });
    socket.to(roomCode).emit("peer-joined", { id: socket.id, name });
  });

  socket.on("signal", ({ to, signal } = {}) => {
    const recipient = io.sockets.sockets.get(to);
    if (!recipient || !signal || recipient.data.roomCode !== socket.data.roomCode) return;
    recipient.emit("signal", { from: socket.id, name: socket.data.name, signal });
  });

  socket.on("leave-room", () => leaveCurrentRoom(socket));
  socket.on("disconnect", () => leaveCurrentRoom(socket));
});

server.listen(PORT, () => {
  console.log(`OpenConvo is running at http://localhost:${PORT}`);
});
