"use strict";

const SEGMENT_MS = 4000;
let mediaStream = null;
let audioContext = null;
let recorder = null;
let segmentTimer = null;
let captureTabId = null;
let captureSessionId = null;
let running = false;
let segmentSequence = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return;

  if (message.type === "OFFSCREEN_VIDEO_START") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: safeErrorMessage(error) }));
    return true;
  }

  if (message.type === "OFFSCREEN_VIDEO_STOP") {
    stopCapture();
    sendResponse({ ok: true });
  }
});

async function startCapture({ streamId, tabId, sessionId }) {
  stopCapture();
  if (!streamId || !Number.isInteger(tabId) || !sessionId) throw new Error("视频捕获参数不完整。");

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  captureTabId = tabId;
  captureSessionId = sessionId;
  running = true;
  segmentSequence = 0;

  // Capturing a tab mutes its normal playback unless the captured audio is routed back.
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(mediaStream);
  source.connect(audioContext.destination);
  await audioContext.resume();

  mediaStream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (!running) return;
    const endedTabId = captureTabId;
    const endedSessionId = captureSessionId;
    stopCapture();
    chrome.runtime.sendMessage({
      type: "VIDEO_CAPTURE_ENDED",
      tabId: endedTabId,
      sessionId: endedSessionId
    });
  });

  recordNextSegment();
}

function recordNextSegment() {
  if (!running || !mediaStream?.active) return;

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const chunks = [];
  const currentRecorder = new MediaRecorder(mediaStream, { mimeType, audioBitsPerSecond: 64000 });
  recorder = currentRecorder;

  currentRecorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) chunks.push(event.data);
  });

  currentRecorder.addEventListener("stop", () => {
    clearTimeout(segmentTimer);
    const blob = new Blob(chunks, { type: mimeType });
    const tabId = captureTabId;
    const sessionId = captureSessionId;

    if (running) recordNextSegment();
    if (blob.size > 256 && Number.isInteger(tabId) && sessionId) {
      sendAudioSegment(blob, tabId, sessionId, segmentSequence++).catch(() => {});
    }
  });

  currentRecorder.start();
  segmentTimer = setTimeout(() => {
    if (currentRecorder.state === "recording") currentRecorder.stop();
  }, SEGMENT_MS);
}

async function sendAudioSegment(blob, tabId, sessionId, sequence) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }

  await chrome.runtime.sendMessage({
    type: "VIDEO_AUDIO_SEGMENT",
    tabId,
    sessionId,
    sequence,
    mimeType: blob.type || "audio/webm",
    audioBase64: btoa(binary)
  });
}

function stopCapture() {
  running = false;
  clearTimeout(segmentTimer);
  if (recorder?.state === "recording") recorder.stop();
  recorder = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  audioContext?.close?.().catch(() => {});
  audioContext = null;
  captureTabId = null;
  captureSessionId = null;
}

function safeErrorMessage(error) {
  return String(error?.message || "无法捕获标签页音频。").slice(0, 300);
}
