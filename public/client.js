(() => {
  "use strict";

  const socket = io();
  const peers = new Map();
  let localStream = null;
  let activeRoomCode = null;

  const homePanel = document.getElementById("home-panel");
  const callPanel = document.getElementById("call-panel");
  const nameInput = document.getElementById("name");
  const codeInput = document.getElementById("room-code");
  const formMessage = document.getElementById("form-message");
  const callStatus = document.getElementById("call-status");
  const activeCode = document.getElementById("active-code");
  const participantList = document.getElementById("participant-list");
  const muteButton = document.getElementById("mute-button");
  const joinButton = document.getElementById("join-button");
  const startButton = document.getElementById("start-button");

  const rtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    iceCandidatePoolSize: 10
  };
  const audioConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 }
    },
    video: false
  };

  function setMessage(element, message) { element.textContent = message; }
  function normalName() { return nameInput.value.trim().replace(/\s+/g, " ").slice(0, 40); }
  function normalCode() { return codeInput.value.replace(/\D/g, "").slice(0, 4); }
  function setBusy(busy) { joinButton.disabled = busy; startButton.disabled = busy; }

  function updateParticipants() {
    participantList.textContent = "";
    const self = document.createElement("li");
    self.textContent = `${normalName()} (you)`;
    participantList.appendChild(self);
    peers.forEach((peer, id) => {
      const row = document.createElement("li");
      row.id = `participant-${id}`;
      row.textContent = peer.name || "Guest";
      participantList.appendChild(row);
    });
  }

  async function requestMicrophone() {
    if (localStream) return localStream;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser does not support microphone access for WebRTC.");
    }
    localStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    return localStream;
  }

  function preferOpus(connection) {
    if (!window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
    const capabilities = RTCRtpReceiver.getCapabilities("audio");
    if (!capabilities || !capabilities.codecs) return;
    const codecs = capabilities.codecs.slice().sort((a, b) => {
      const aOpus = /opus/i.test(a.mimeType) ? 0 : 1;
      const bOpus = /opus/i.test(b.mimeType) ? 0 : 1;
      return aOpus - bOpus;
    });
    connection.getTransceivers().forEach((transceiver) => {
      if (transceiver.receiver.track.kind === "audio" && transceiver.setCodecPreferences) {
        try { transceiver.setCodecPreferences(codecs); } catch (_) { /* Browser uses its default codec order. */ }
      }
    });
  }

  function createPeer(peerId, peerName) {
    if (peers.has(peerId)) return peers.get(peerId);
    const connection = new RTCPeerConnection(rtcConfig);
    const peer = { connection, name: peerName || "Guest", pendingCandidates: [] };
    peers.set(peerId, peer);
    localStream.getTracks().forEach((track) => connection.addTrack(track, localStream));
    preferOpus(connection);

    connection.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit("signal", { to: peerId, signal: { type: "candidate", candidate } });
    };
    connection.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;
      let audio = document.getElementById(`audio-${peerId}`);
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = `audio-${peerId}`;
        audio.autoplay = true;
        document.getElementById("remote-audio").appendChild(audio);
      }
      audio.srcObject = stream;
      audio.play().catch(() => setMessage(callStatus, "Audio is ready. Your browser may require a click to play it."));
    };
    connection.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(connection.connectionState)) removePeer(peerId);
    };
    updateParticipants();
    return peer;
  }

  function removePeer(peerId) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.connection.ontrack = null;
    peer.connection.close();
    peers.delete(peerId);
    document.getElementById(`audio-${peerId}`)?.remove();
    updateParticipants();
    setMessage(callStatus, peers.size ? "Connected to meeting." : "Waiting for someone else to join.");
  }

  async function offerTo(peerId, peerName) {
    const peer = createPeer(peerId, peerName);
    const offer = await peer.connection.createOffer({ offerToReceiveAudio: true });
    await peer.connection.setLocalDescription(offer);
    socket.emit("signal", { to: peerId, signal: { type: "offer", sdp: peer.connection.localDescription } });
  }

  async function processSignal(from, name, signal) {
    if (!signal || !localStream) return;
    let peer = peers.get(from);
    if (!peer) peer = createPeer(from, name);
    const connection = peer.connection;
    try {
      if (signal.type === "offer") {
        await connection.setRemoteDescription(signal.sdp);
        while (peer.pendingCandidates.length) await connection.addIceCandidate(peer.pendingCandidates.shift());
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        socket.emit("signal", { to: from, signal: { type: "answer", sdp: connection.localDescription } });
      } else if (signal.type === "answer") {
        await connection.setRemoteDescription(signal.sdp);
        while (peer.pendingCandidates.length) await connection.addIceCandidate(peer.pendingCandidates.shift());
      } else if (signal.type === "candidate" && signal.candidate) {
        if (connection.remoteDescription) await connection.addIceCandidate(signal.candidate);
        else peer.pendingCandidates.push(signal.candidate);
      }
    } catch (error) {
      console.error("WebRTC signaling error:", error);
      setMessage(callStatus, "A connection could not be completed. Please try rejoining.");
    }
  }

  async function enterMeeting(action) {
    const name = normalName();
    const roomCode = normalCode();
    if (!name) return setMessage(formMessage, "Please enter your name.");
    if (action === "join" && !/^\d{4}$/.test(roomCode)) return setMessage(formMessage, "Enter a four-digit meeting code.");
    setBusy(true);
    setMessage(formMessage, "Requesting microphone permission...");
    try {
      await requestMicrophone();
      socket.emit(action === "create" ? "create-room" : "join-room", action === "create" ? { name } : { name, roomCode }, async (result) => {
        setBusy(false);
        if (!result || !result.ok) {
          setMessage(formMessage, result?.error || "Could not reach the meeting server.");
          return;
        }
        activeRoomCode = result.roomCode;
        activeCode.textContent = activeRoomCode;
        homePanel.hidden = true;
        callPanel.hidden = false;
        updateParticipants();
        setMessage(callStatus, result.peers.length ? "Connecting to other people..." : "Waiting for someone else to join.");
        for (const peer of result.peers) {
          try { await offerTo(peer.id, peer.name); } catch (error) { console.error(error); }
        }
      });
    } catch (error) {
      setBusy(false);
      setMessage(formMessage, `Microphone unavailable: ${error.message}`);
    }
  }

  document.getElementById("meeting-form").addEventListener("submit", (event) => { event.preventDefault(); enterMeeting("join"); });
  startButton.addEventListener("click", () => enterMeeting("create"));
  codeInput.addEventListener("input", () => { codeInput.value = normalCode(); });
  muteButton.addEventListener("click", () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    muteButton.textContent = track.enabled ? "Mute Microphone" : "Unmute Microphone";
  });
  document.getElementById("leave-button").addEventListener("click", () => {
    socket.emit("leave-room");
    peers.forEach((_, id) => removePeer(id));
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    activeRoomCode = null;
    callPanel.hidden = true;
    homePanel.hidden = false;
    setMessage(formMessage, "You have left the meeting.");
  });

  socket.on("peer-joined", ({ id, name }) => {
    if (activeRoomCode) {
      createPeer(id, name);
      setMessage(callStatus, `${name || "Someone"} joined. Connecting...`);
    }
  });
  socket.on("peer-left", ({ id, name }) => { removePeer(id); setMessage(callStatus, `${name || "Someone"} left the meeting.`); });
  socket.on("signal", ({ from, name, signal }) => processSignal(from, name, signal));
  socket.on("disconnect", () => { if (activeRoomCode) setMessage(callStatus, "Connection to the meeting server was lost."); });
})();
