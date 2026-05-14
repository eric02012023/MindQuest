/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/js/calls.js
 * Purpose: Front-end logic for real-time audio/video calling using WebRTC and Socket.IO signaling.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

let socket = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let activeCallUserId = null;
let mediaRecorder = null;
let recordedChunks = [];

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// Function: ensureSocket

// Role: Provides helper logic for this file.

function ensureSocket() {
  if (socket || !window.io || !window.mqtcUser) return;
  socket = window.io();
  socket.emit('register-user', window.mqtcUser.id);

  socket.on('call-offer', async ({ fromUserId, offer, callType }) => {
    activeCallUserId = fromUserId;
    await openCallModal(callType === 'video');
    await createPeerConnection(false);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('call-answer', { toUserId: fromUserId, answer });
  });

  socket.on('call-answer', async ({ answer }) => {
    if (peerConnection) await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (peerConnection && candidate) {
      try { await peerConnection.addIceCandidate(candidate); } catch (error) { console.error(error); }
    }
  });

  socket.on('end-call', () => closeCallModal(false));
}

// Function: getCallModalHtml

// Role: Provides helper logic for this file.

function getCallModalHtml() {
  const isTutor = window.mqtcUser?.role === 'tutor';
  return `
    <div class="global-modal-card wide">
      <button type="button" class="modal-close" data-close-modal>&times;</button>
      <h3>Voice / Video Call</h3>
      <div class="call-modal-body">
        <div class="video-grid">
          <video id="local-video" autoplay muted playsinline></video>
          <video id="remote-video" autoplay playsinline></video>
        </div>
        <p class="mq-call-note" id="call-status-note">Connecting media…</p>
        <div class="row-actions call-actions-row">
          ${isTutor ? '<button type="button" class="btn btn-secondary" id="record-call-button">Start recording</button>' : ''}
          <button type="button" class="btn btn-secondary" id="end-call-button">End Call</button>
        </div>
        ${isTutor ? '<p class="mq-call-note">Recording is available for tutor calls only. Saved recordings are sent in the chat so both tutor and student can replay them.</p>' : ''}
      </div>
    </div>`;
}

// Function: setCallStatus

// Role: Provides helper logic for this file.

function setCallStatus(message) {
  const note = document.querySelector('#call-status-note');
  if (note) note.textContent = message;
}

// Function: requestMedia

// Role: Handles a reusable server-side operation used by this module.

async function requestMedia(videoEnabled) {
  const attempts = videoEnabled
    ? [
        { audio: true, video: { facingMode: 'user' } },
        { audio: true, video: true },
        { audio: true, video: false }
      ]
    : [
        { audio: true, video: false },
        { audio: true }
      ];

  let lastError = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Media unavailable');
}

// Function: openCallModal

// Role: Handles a reusable server-side operation used by this module.

async function openCallModal(videoEnabled) {
  let modal = document.querySelector('#call-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'global-modal';
    modal.id = 'call-modal';
    modal.innerHTML = getCallModalHtml();
    document.body.appendChild(modal);
    modal.querySelector('#end-call-button')?.addEventListener('click', () => closeCallModal(true));
    modal.querySelector('#record-call-button')?.addEventListener('click', toggleRecording);
  }
  modal.classList.add('is-open');
  localStream = await requestMedia(videoEnabled);
  const localVideo = modal.querySelector('#local-video');
  const remoteVideo = modal.querySelector('#remote-video');
  if (localVideo) localVideo.srcObject = localStream;
  if (remoteVideo) remoteVideo.srcObject = null;
  const hasVideo = localStream.getVideoTracks().length > 0;
  setCallStatus(hasVideo ? 'Camera and microphone connected.' : 'Microphone connected. Camera unavailable on this device, so the call will continue as audio.');
}

// Function: createPeerConnection

// Role: Handles a reusable server-side operation used by this module.

async function createPeerConnection(initiator) {
  peerConnection = new RTCPeerConnection(rtcConfig);
  remoteStream = new MediaStream();
  const remoteVideo = document.querySelector('#remote-video');
  if (remoteVideo) remoteVideo.srcObject = remoteStream;
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  peerConnection.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
    if (remoteVideo) remoteVideo.srcObject = remoteStream;
    setCallStatus('Call connected.');
  };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket && activeCallUserId) socket.emit('ice-candidate', { toUserId: activeCallUserId, candidate: event.candidate });
  };
  if (initiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('call-offer', { toUserId: activeCallUserId, fromUserId: window.mqtcUser.id, offer, callType: localStream.getVideoTracks().length ? 'video' : 'voice' });
  }
}

// Function: uploadRecording

// Role: Handles a reusable server-side operation used by this module.

async function uploadRecording(blob) {
  if (!blob || window.mqtcUser?.role !== 'tutor' || !activeCallUserId) return;
  const file = new File([blob], `call-recording-${Date.now()}.webm`, { type: blob.type || 'video/webm' });
  const formData = new FormData();
  formData.append('receiver_id', activeCallUserId);
  formData.append('body', 'Call recording');
  formData.append('attachment', file);
  const response = await fetch('/tutor/messages/send', { method: 'POST', body: formData, credentials: 'same-origin' });
  if (!response.ok) throw new Error('Upload failed');
}

// Function: toggleRecording

// Role: Handles a reusable server-side operation used by this module.

async function toggleRecording() {
  const recordButton = document.querySelector('#record-call-button');
  if (!recordButton) return;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    recordButton.disabled = true;
    return;
  }
  if (!localStream) return;
  const mixedStream = new MediaStream();
  localStream.getTracks().forEach((track) => mixedStream.addTrack(track));
  remoteStream?.getTracks().forEach((track) => mixedStream.addTrack(track));
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(mixedStream, { mimeType: 'video/webm' });
  mediaRecorder.ondataavailable = (event) => { if (event.data && event.data.size) recordedChunks.push(event.data); };
  mediaRecorder.onstop = async () => {
    const button = document.querySelector('#record-call-button');
    try {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      if (blob.size) {
        await uploadRecording(blob);
        alert('Call recording saved in the chat.');
      }
    } catch (error) {
      console.error(error);
      alert('Recording was created but could not be saved.');
    } finally {
      if (button) {
        button.textContent = 'Start recording';
        button.disabled = false;
      }
      mediaRecorder = null;
      recordedChunks = [];
    }
  };
  mediaRecorder.start();
  recordButton.textContent = 'Stop recording';
}

// Function: startCall

// Role: Handles a reusable server-side operation used by this module.

async function startCall(userId, mode) {
  ensureSocket();
  activeCallUserId = userId;
  await openCallModal(mode === 'video');
  await createPeerConnection(true);
}

// Function: closeCallModal

// Role: Provides helper logic for this file.

function closeCallModal(notifyPeer = true) {
  const modal = document.querySelector('#call-modal');
  if (modal) modal.classList.remove('is-open');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  remoteStream = null;
  if (notifyPeer && socket && activeCallUserId) socket.emit('end-call', { toUserId: activeCallUserId });
  activeCallUserId = null;
}

document.addEventListener('DOMContentLoaded', () => {
  ensureSocket();
  document.querySelectorAll('[data-start-call]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await startCall(button.getAttribute('data-target-user'), button.getAttribute('data-start-call'));
      } catch (error) {
        console.error(error);
        alert('Voice/video call could not start. Please allow microphone and camera permission, then try again.');
      }
    });
  });
});
