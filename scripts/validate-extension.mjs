import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.7.4");
for (const permission of ["storage", "activeTab", "tabCapture", "offscreen"]) {
  assert(manifest.permissions.includes(permission), `missing permission: ${permission}`);
}
for (const host of ["https://api.deepseek.com/*", "https://api.groq.com/*"]) {
  assert(manifest.host_permissions.includes(host), `missing host permission: ${host}`);
}
for (const file of ["background.js", "content.js", "content.css", "docx.js", "options.html", "offscreen.html", "offscreen.js"]) {
  assert(fs.existsSync(path.join(root, file)), `missing extension file: ${file}`);
}
assert.match(fs.readFileSync(path.join(root, "offscreen.js"), "utf8"), /const SEGMENT_MS = 4000;/);

const stored = new Map();
const tabMessages = [];
let runtimeListener;
let actionListener;
let streamRequestedFor = null;

const chrome = {
  runtime: {
    id: "test-extension-id",
    onInstalled: { addListener() {} },
    onMessage: { addListener(listener) { runtimeListener = listener; } },
    openOptionsPage: async () => {},
    sendMessage: async (message) => {
      if (message.type === "OFFSCREEN_VIDEO_START" || message.type === "OFFSCREEN_VIDEO_STOP") {
        return { ok: true };
      }
      return undefined;
    }
  },
  action: { onClicked: { addListener(listener) { actionListener = listener; } } },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: stored.get(key) };
        return {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) stored.set(key, value);
      },
      async remove(key) { stored.delete(key); }
    }
  },
  tabs: {
    onRemoved: { addListener() {} },
    async sendMessage(tabId, message) {
      if (message.type === "VIDEO_CAN_START") return { hasVisibleVideo: true };
      tabMessages.push({ tabId, message });
      return undefined;
    }
  },
  offscreen: {
    async hasDocument() { return true; },
    async createDocument() {}
  },
  tabCapture: {
    async getMediaStreamId({ targetTabId }) {
      streamRequestedFor = targetTabId;
      return "mock-stream-id";
    }
  }
};

async function fetchMock(url, options = {}) {
  if (url === "https://api.deepseek.com/models") {
    return jsonResponse(200, { data: [{ id: "deepseek-v4-flash" }] });
  }
  if (url === "https://api.groq.com/openai/v1/models") {
    return jsonResponse(200, { data: [{ id: "whisper-large-v3-turbo" }] });
  }
  if (url === "https://api.groq.com/openai/v1/audio/transcriptions") {
    assert(options.body instanceof FormData);
    assert(options.body.get("file") instanceof Blob);
    assert.equal(options.body.get("model"), "whisper-large-v3-turbo");
    assert.equal(options.body.get("language"), "en");
    return jsonResponse(200, { text: "Learning happens through practice." });
  }
  if (url === "https://api.deepseek.com/chat/completions") {
    return jsonResponse(200, {
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "学习来自实践。" } }]
    });
  }
  throw new Error(`unexpected fetch: ${url}`);
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

const context = vm.createContext({
  chrome,
  fetch: fetchMock,
  crypto: webcrypto,
  AbortController,
  Blob,
  FormData,
  Uint8Array,
  atob,
  setTimeout,
  clearTimeout,
  console
});
new vm.Script(fs.readFileSync(path.join(root, "background.js"), "utf8"), {
  filename: "background.js"
}).runInContext(context);
assert.equal(typeof runtimeListener, "function");

async function send(message, sender = { id: chrome.runtime.id }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`message timeout: ${message.type}`)), 1000);
    const sendResponse = (response) => {
      clearTimeout(timer);
      resolve(response);
    };
    const keepAlive = runtimeListener(message, sender, sendResponse);
    if (keepAlive !== true && message.type !== "VIDEO_AUDIO_SEGMENT") {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

assert.equal((await send({ type: "DEEPSEEK_SAVE_KEY", apiKey: "sk-test-only" })).ok, true);
assert.equal((await send({ type: "GROQ_SAVE_KEY", apiKey: "gsk_test_only" })).ok, true);
assert.equal((await send({ type: "DEEPSEEK_KEY_STATUS" })).configured, true);
assert.equal((await send({ type: "GROQ_KEY_STATUS" })).configured, true);

const pageSender = {
  id: chrome.runtime.id,
  tab: { id: 42, url: "https://x.com/home" }
};
assert.equal(typeof actionListener, "function");
await actionListener(pageSender.tab);
const startedMessage = tabMessages.find(({ message }) => message.type === "VIDEO_CAPTION_STARTED");
assert(startedMessage, "toolbar action did not start video capture");
const started = startedMessage.message;
assert.equal(streamRequestedFor, 42);

await send(
  {
    type: "VIDEO_AUDIO_SEGMENT",
    tabId: 42,
    sessionId: started.sessionId,
    sequence: 0,
    mimeType: "audio/webm",
    audioBase64: btoa("mock webm audio")
  },
  { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/offscreen.html` }
);

for (let attempts = 0; attempts < 20 && tabMessages.filter(({ message }) => message.type === "VIDEO_CAPTION_UPDATE").length < 2; attempts += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const captions = tabMessages.filter(({ message }) => message.type === "VIDEO_CAPTION_UPDATE");
assert(captions.length >= 2, "partial and translated captions were not delivered");
assert.equal(captions[0].message.transcript, "Learning happens through practice.");
assert.equal(captions[0].message.translating, true);
assert.equal(captions.at(-1).message.translation, "学习来自实践。");
assert.equal(captions.at(-1).message.translating, false);

await actionListener(pageSender.tab);
assert(tabMessages.some(({ message }) => message.type === "VIDEO_CAPTION_STOPPED"));
assert.equal((await send({ type: "GROQ_DELETE_KEY" })).configured, false);
assert.equal((await send({ type: "GROQ_KEY_STATUS" })).configured, false);

console.log("VALIDATION_OK: manifest, key persistence, capture start/stop, Groq upload, and bilingual caption delivery");
