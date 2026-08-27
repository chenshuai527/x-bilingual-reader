"use strict";

const input = document.getElementById("api-key");
const saveButton = document.getElementById("save-key");
const deleteButton = document.getElementById("delete-key");
const toggleButton = document.getElementById("toggle-visibility");
const message = document.getElementById("message");
const connectionState = document.getElementById("connection-state");
const connectionLabel = document.getElementById("connection-label");
let isConfigured = false;
const hasExtensionRuntime = Boolean(globalThis.chrome?.runtime?.sendMessage);

if (hasExtensionRuntime) {
  refreshStatus();
} else {
  connectionLabel.textContent = "预览模式";
  setMessage("请从 Chrome 扩展的“选项”页面打开并配置。", "idle");
}

toggleButton.addEventListener("click", () => {
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  toggleButton.textContent = showing ? "显示" : "隐藏";
  toggleButton.setAttribute("aria-label", showing ? "显示 Key" : "隐藏 Key");
  input.focus();
});

saveButton.addEventListener("click", async () => {
  if (!hasExtensionRuntime) {
    setMessage("当前是静态预览，请从 Chrome 扩展选项页配置。", "error");
    return;
  }
  const apiKey = sanitizeApiKey(input.value);
  if (!apiKey) {
    setMessage("请先粘贴完整的 DeepSeek API Key。", "error");
    input.focus();
    return;
  }
  if (apiKey.includes("*")) {
    setMessage("不能使用带 ***** 的脱敏 Key，请创建并复制新的完整 Key。", "error");
    input.focus();
    return;
  }

  setBusy(true);
  setMessage("正在连接 DeepSeek 官方 API…", "idle");
  try {
    const response = await chrome.runtime.sendMessage({ type: "DEEPSEEK_SAVE_KEY", apiKey });
    if (!response?.ok) {
      setConnection(Boolean(response?.configured), !response?.configured);
      setMessage(humanizeError(new Error(response?.error || "连接失败。")), "error");
      return;
    }
    input.value = "";
    setConnection(true);
    setMessage(`连接成功，当前模型：${response.model || "deepseek-v4-flash"}。现在可以返回 X 使用。`, "success");
  } catch (error) {
    setConnection(false, true);
    setMessage(humanizeError(error), "error");
  } finally {
    setBusy(false);
  }
});

deleteButton.addEventListener("click", async () => {
  if (!hasExtensionRuntime) return;
  if (!window.confirm("确定断开 DeepSeek 并清除浏览器中保存的 Key 吗？")) return;
  setBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "DEEPSEEK_DELETE_KEY" });
    if (!response?.ok) throw new Error(response?.error || "清除失败。");
    input.value = "";
    setConnection(false);
    setMessage("已断开并从当前 Chrome 中清除 Key。", "success");
  } catch (error) {
    setMessage(error?.message || String(error), "error");
  } finally {
    setBusy(false);
  }
});

async function refreshStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "DEEPSEEK_KEY_STATUS" });
    setConnection(Boolean(response?.configured));
    if (response?.configured) {
      setMessage("Key 已由当前 Chrome 长期保存，重启浏览器后仍可使用。", "success");
    } else {
      setMessage("尚未连接。粘贴 Key 后点击“验证并永久保存”。", "idle");
    }
  } catch (error) {
    setConnection(false, true);
    setMessage(error?.message || String(error), "error");
  }
}

function setConnection(configured, failed = false) {
  isConfigured = configured;
  connectionState.dataset.state = configured ? "success" : failed ? "error" : "idle";
  connectionLabel.textContent = configured ? "已连接" : failed ? "连接失败" : "未连接";
  deleteButton.disabled = !configured;
}

function setBusy(busy) {
  saveButton.disabled = busy;
  deleteButton.disabled = busy || !isConfigured;
  toggleButton.disabled = busy;
}

function setMessage(text, state) {
  message.textContent = text;
  message.dataset.state = state;
}

function sanitizeApiKey(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g, "")
    .trim();
}

function humanizeError(error) {
  const text = String(error?.message || error);
  if (text.includes("DEEPSEEK_AUTH_INVALID")) return "Key 无效或已撤销，请在 DeepSeek 平台创建新的完整 Key。";
  if (text.includes("DEEPSEEK_BALANCE")) return "DeepSeek API 账户余额不足，请充值后重试。";
  if (text.includes("DEEPSEEK_RATE_LIMIT")) return "DeepSeek 请求过于频繁，请稍后重试。";
  return text.replace(/^DEEPSEEK_API_ERROR:\s*/, "");
}
