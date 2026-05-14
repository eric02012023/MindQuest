/**
 * ANNOTATED COPY FOR DEFENSE REVIEW
 * File: public/js/messages.js
 * Purpose: Front-end messaging UI logic for previews, editing, camera capture, and compose behavior.
 * Notes: Comments were added to help explain the system during code defense without changing the original logic.
 */

(() => {
  const conversationBox = document.querySelector('[data-conversation-box]');
  if (conversationBox) conversationBox.scrollTop = conversationBox.scrollHeight;

  const resize = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(window.getComputedStyle(el).lineHeight || '22', 10);
    const maxHeight = lineHeight * 10;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  const textarea = document.querySelector('[data-chat-textarea]');
  resize(textarea);
  textarea?.addEventListener('input', () => resize(textarea));

  const menuButton = document.querySelector('[data-chat-menu-toggle]');
  const menu = document.querySelector('[data-chat-menu]');
  menuButton?.addEventListener('click', () => menu?.classList.toggle('open'));
  document.addEventListener('click', (event) => {
    if (!menu || !menuButton) return;
    if (!menu.contains(event.target) && !menuButton.contains(event.target)) menu.classList.remove('open');
  });
  document.querySelector('[data-groupchat-disabled]')?.addEventListener('click', () => window.alert('Group chat creation is planned for the next pass.'));

  const attachmentInput = document.querySelector('[data-attachment-input]');
  const previewWrap = document.querySelector('[data-compose-preview]');
  const previewMedia = document.querySelector('[data-preview-media]');
  const uploadName = document.querySelector('[data-upload-name]');
  let previewUrl = null;

  const clearPreview = () => {
    if (!attachmentInput) return;
    attachmentInput.value = '';
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (previewMedia) previewMedia.innerHTML = '';
    if (uploadName) uploadName.textContent = '';
    if (previewWrap) previewWrap.hidden = true;
  };

  const attachFileObject = (file) => {
    if (!attachmentInput || !file) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    attachmentInput.files = dt.files;
    return true;
  };

  const renderPreview = (file) => {
    if (!file || !previewMedia || !uploadName || !previewWrap) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    uploadName.textContent = file.name || 'Attachment';
    if (file.type.startsWith('image/')) {
      previewMedia.innerHTML = `<img src="${previewUrl}" alt="Preview" class="mq-compose-thumb">`;
    } else if (file.type.startsWith('video/')) {
      previewMedia.innerHTML = `<video src="${previewUrl}" controls class="mq-compose-video"></video>`;
    } else {
      previewMedia.innerHTML = `<div class="mq-file-chip">📎 ${file.name || 'Attachment'}</div>`;
    }
    previewWrap.hidden = false;
  };

  const setInputMode = (acceptValue, captureValue = null) => {
    if (!attachmentInput) return;
    attachmentInput.value = '';
    attachmentInput.accept = acceptValue || '';
    if (captureValue) attachmentInput.setAttribute('capture', captureValue);
    else attachmentInput.removeAttribute('capture');
    attachmentInput.click();
  };
  document.querySelector('[data-open-file]')?.addEventListener('click', () => setInputMode(''));
  document.querySelector('[data-open-gallery]')?.addEventListener('click', () => setInputMode('image/*,video/*'));
  attachmentInput?.addEventListener('change', () => {
    const file = attachmentInput.files?.[0];
    if (file) renderPreview(file);
    else clearPreview();
  });
  document.querySelector('[data-clear-attachment]')?.addEventListener('click', clearPreview);

  const composeForm = document.querySelector('[data-compose-form]');
  composeForm?.addEventListener('submit', () => {
    setTimeout(clearPreview, 100);
  });

  const editDialog = document.querySelector('[data-edit-dialog]');
  const editForm = document.querySelector('[data-edit-form]');
  const editTextarea = document.querySelector('[data-edit-textarea]');
  const openEdit = (messageId, bodyText) => {
    if (!editDialog || !editForm || !editTextarea) return;
    editForm.action = `${window.location.pathname.replace(/\/$/, '')}/${messageId}/edit`;
    editTextarea.value = bodyText;
    if (typeof editDialog.showModal === 'function') editDialog.showModal();
    resize(editTextarea);
    setTimeout(() => editTextarea.focus(), 20);
  };
  document.querySelectorAll('[data-edit-message]').forEach((button) => {
    button.addEventListener('click', () => {
      let bodyText = '';
      try { bodyText = JSON.parse(button.dataset.messageBody || '""'); } catch (_) {}
      openEdit(button.dataset.messageId, bodyText);
    });
  });
  document.querySelectorAll('[data-edit-close]').forEach((button) => button.addEventListener('click', () => editDialog?.close()));
  editTextarea?.addEventListener('input', () => resize(editTextarea));

  const hookDialog = (triggerSelector, dialogSelector) => {
    const dialog = document.querySelector(dialogSelector);
    document.querySelectorAll(triggerSelector).forEach((button) => {
      button.addEventListener('click', () => dialog?.showModal());
    });
    dialog?.querySelectorAll('[data-close-info]').forEach((button) => button.addEventListener('click', () => dialog.close()));
  };
  hookDialog('[data-open-shared]', '[data-shared-dialog]');
  hookDialog('[data-open-profile]', '[data-profile-dialog]');

  const cameraDialog = document.querySelector('[data-camera-dialog]');
  const cameraVideo = document.querySelector('[data-camera-video]');
  const cameraCanvas = document.querySelector('[data-camera-canvas]');
  const cameraCloseButtons = document.querySelectorAll('[data-camera-close]');
  const takePhotoButton = document.querySelector('[data-take-photo]');
  const startVideoButton = document.querySelector('[data-start-video-recording]');
  const stopVideoButton = document.querySelector('[data-stop-video-recording]');
  let cameraStream = null;
  let cameraRecorder = null;
  let cameraChunks = [];

  const stopCameraStream = () => {
    if (cameraRecorder && cameraRecorder.state === 'recording') {
      try { cameraRecorder.stop(); } catch (_) {}
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    if (cameraVideo) cameraVideo.srcObject = null;
    if (startVideoButton) startVideoButton.hidden = false;
    if (stopVideoButton) stopVideoButton.hidden = true;
  };

  const closeCameraDialog = () => {
    stopCameraStream();
    cameraDialog?.close();
  };

  const ensureCamera = async () => {
    if (cameraStream) return cameraStream;
    const baseAttempts = [
      { audio: true, video: { facingMode: 'environment' } },
      { audio: true, video: { facingMode: 'user' } },
      { audio: true, video: true }
    ];
    let lastError = null;
    for (const constraints of baseAttempts) {
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cameraVideo) cameraVideo.srcObject = cameraStream;
        return cameraStream;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('Camera unavailable');
  };

  document.querySelector('[data-open-camera]')?.addEventListener('click', async () => {
    if (!cameraDialog || !navigator.mediaDevices?.getUserMedia) {
      window.alert('This device or browser does not support direct camera capture.');
      return;
    }
    try {
      await ensureCamera();
      cameraDialog.showModal();
      await cameraVideo?.play?.();
    } catch (error) {
      console.error(error);
      window.alert('Camera could not open. Please allow camera permission on this device and try again.');
    }
  });

  takePhotoButton?.addEventListener('click', () => {
    if (!cameraVideo || !cameraCanvas) return;
    const width = cameraVideo.videoWidth || 1280;
    const height = cameraVideo.videoHeight || 720;
    cameraCanvas.width = width;
    cameraCanvas.height = height;
    const ctx = cameraCanvas.getContext('2d');
    ctx.drawImage(cameraVideo, 0, 0, width, height);
    cameraCanvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `camera-photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
      attachFileObject(file);
      renderPreview(file);
      closeCameraDialog();
    }, 'image/jpeg', 0.92);
  });

  startVideoButton?.addEventListener('click', async () => {
    try {
      const stream = await ensureCamera();
      cameraChunks = [];
      cameraRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      cameraRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size) cameraChunks.push(event.data);
      };
      cameraRecorder.onstop = () => {
        const blob = new Blob(cameraChunks, { type: 'video/webm' });
        if (!blob.size) return;
        const file = new File([blob], `camera-video-${Date.now()}.webm`, { type: 'video/webm' });
        attachFileObject(file);
        renderPreview(file);
        closeCameraDialog();
      };
      cameraRecorder.start();
      startVideoButton.hidden = true;
      stopVideoButton.hidden = false;
    } catch (error) {
      console.error(error);
      window.alert('Video recording could not start.');
    }
  });

  stopVideoButton?.addEventListener('click', () => {
    if (cameraRecorder && cameraRecorder.state === 'recording') cameraRecorder.stop();
  });

  cameraCloseButtons.forEach((button) => button.addEventListener('click', closeCameraDialog));
  cameraDialog?.addEventListener('close', stopCameraStream);
})();
