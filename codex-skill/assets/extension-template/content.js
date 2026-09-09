(() => {
  "use strict";

  const UI_HOST_ID = "bilingual-reader-control-host";
  const SELECTION_HOST_ID = "bilingual-reader-selection-host";
  const VIDEO_CAPTION_HOST_ID = "bilingual-reader-video-caption-host";
  const TRANSLATION_CLASS = "bilingual-reader-translation";
  const UI_TRANSLATION_CLASS = "bilingual-reader-ui-translation";
  const FAVORITES_KEY = "bilingualReaderFavorites";
  const MAX_CHUNK_LENGTH = 2400;
  const MAX_FAVORITES = 500;

  const UI_LABEL_TRANSLATIONS = new Map([
    ["For you", "为你"],
    ["Following", "关注"],
    ["Celebs", "名人"],
    ["Politics", "政治"],
    ["Music", "音乐"],
    ["News", "新闻"],
    ["Sports", "体育"],
    ["Entertainment", "娱乐"]
  ]);

  const X_ARTICLE_CONTENT_SELECTORS = [
    '[data-testid="twitterArticleReadView"] [data-testid="twitter-article-title"]',
    '[data-testid="twitterArticleReadView"] .longform-header-one',
    '[data-testid="twitterArticleReadView"] .longform-header-one-narrow',
    '[data-testid="twitterArticleReadView"] .longform-header-two',
    '[data-testid="twitterArticleReadView"] .longform-header-two-narrow',
    '[data-testid="twitterArticleReadView"] .longform-unstyled',
    '[data-testid="twitterArticleReadView"] .longform-unstyled-narrow',
    '[data-testid="twitterArticleReadView"] .longform-blockquote',
    '[data-testid="twitterArticleReadView"] .longform-blockquote-narrow',
    '[data-testid="twitterArticleReadView"] .longform-unordered-list-item',
    '[data-testid="twitterArticleReadView"] .longform-unordered-list-item-narrow',
    '[data-testid="twitterArticleReadView"] .longform-ordered-list-item',
    '[data-testid="twitterArticleReadView"] .longform-ordered-list-item-narrow',
    '[data-testid="twitterArticleReadView"] section[data-block="true"]',
    '[data-testid="twitterArticleRichTextView"] [data-testid="longformRichTextComponent"] p',
    '[data-testid="twitterArticleRichTextView"] [data-testid="longformRichTextComponent"] li',
    '[data-testid="twitterArticleRichTextView"] [data-testid="longformRichTextComponent"] blockquote'
  ];

  const SITE_ADAPTERS = [
    {
      hosts: new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
      selector: [
        '[data-testid="tweetText"]',
        'article a[href*="/i/article/"]',
        'article a[href*="/i/article/"] [dir="auto"]',
        'article [data-testid="card.wrapper"]',
        'article [data-testid="card.wrapper"] [dir="auto"]',
        'article [dir="auto"]',
        'article [dir="ltr"]',
        'article h1',
        'article h2',
        'article h3',
        'article p',
        'article a[role="link"]',
        ...X_ARTICLE_CONTENT_SELECTORS
      ].join(","),
      uiSelector: '[role="tab"], nav a, nav button'
    }
  ];

  const adapter = SITE_ADAPTERS.find((item) => item.hosts.has(location.hostname));
  if (!adapter || document.getElementById(UI_HOST_ID)) return;

  let enabled = false;
  let translator = null;
  let activeProvider = null;
  let queue = Promise.resolve();
  let scanTimer = null;
  let pendingSelection = null;
  let videoTranslationActive = false;
  const sourceByElement = new WeakMap();
  const observed = new WeakSet();
  const cache = new Map();

  const panel = createControlPanel();
  const selectionCapture = createSelectionCapture();
  const videoCaptions = createVideoCaptionOverlay();
  const visibilityObserver = new IntersectionObserver(
    (entries) => {
      if (!enabled) return;
      for (const entry of entries) {
        if (entry.isIntersecting) scheduleTranslation(entry.target);
      }
    },
    { rootMargin: "240px 0px" }
  );

  const mutationObserver = new MutationObserver(() => scheduleScan());
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

  restorePreference();
  refreshFavoriteCount();
  scan();

  document.addEventListener("mouseup", () => setTimeout(updateSelectionCapture, 0), true);
  document.addEventListener("keyup", () => setTimeout(updateSelectionCapture, 0), true);
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!event.composedPath().includes(selectionCapture.host)) hideSelectionCapture();
    },
    true
  );
  window.addEventListener("scroll", hideSelectionCapture, true);
  window.addEventListener("scroll", () => videoCaptions.reposition(), true);
  window.addEventListener("resize", () => videoCaptions.reposition());

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "VIDEO_CAN_START") {
      const hasVisibleVideo = Array.from(document.querySelectorAll("video")).some((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 160 && rect.height > 90 && rect.bottom > 0 && rect.top < innerHeight;
      });
      sendResponse({ hasVisibleVideo });
      return;
    }
    if (message.type === "VIDEO_CAPTION_UPDATE") {
      videoCaptions.show(message.transcript, message.translation, message.translating);
      panel.videoButton.textContent = "停止视频翻译";
      panel.videoButton.dataset.enabled = "true";
      setStatus("视频双语字幕运行中。每约 4 秒更新一次。");
    }
    if (message.type === "VIDEO_CAPTION_STARTED") {
      videoTranslationActive = true;
      panel.videoButton.textContent = "停止视频翻译";
      panel.videoButton.dataset.enabled = "true";
      videoCaptions.showWaiting();
      setStatus("正在听取英语对白，首条字幕约 4–7 秒后出现。");
    }
    if (message.type === "VIDEO_CAPTION_ERROR") {
      videoCaptions.showError(humanizeError(new Error(message.error || "视频翻译失败。")));
      setStatus(`视频翻译失败：${humanizeError(new Error(message.error || "未知错误"))}`);
      if (/tab capture|activeTab|invoked|gesture|调用扩展|用户调用/i.test(message.error || "")) {
        setStatus("请点击 Chrome 工具栏中的“英汉同步阅读”扩展图标启动视频翻译。");
      }
    }
    if (message.type === "VIDEO_CAPTION_STOPPED") {
      resetVideoUi(message.message || "视频翻译已停止。");
    }
  });

  async function restorePreference() {
    const { bilingualReaderEnabled = false } = await chrome.storage.local.get({
      bilingualReaderEnabled: false
    });
    if (!bilingualReaderEnabled) return;

    try {
      await enableTranslation(false);
    } catch (error) {
      setStatus("请点击启用，完成首次模型下载");
      console.debug("Automatic start needs user activation:", error);
    }
  }

  function createControlPanel() {
    const host = document.createElement("div");
    host.id = UI_HOST_ID;
    host.style.position = "fixed";
    host.style.right = "18px";
    host.style.bottom = "18px";
    host.style.zIndex = "2147483647";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .panel { width: 240px; box-sizing: border-box; padding: 12px; border: 1px solid #d0d5dd;
        border-radius: 14px; background: rgba(255,255,255,.96); color: #101828;
        box-shadow: 0 10px 28px rgba(16,24,40,.16); font: 13px/1.45 system-ui,"Microsoft YaHei",sans-serif; }
      .title { margin-bottom: 7px; font-weight: 700; }
      .status { min-height: 36px; margin-bottom: 9px; color: #475467; }
      button { padding: 8px 10px; border: 0; border-radius: 9px; background: #1d9bf0;
        color: white; font: inherit; font-weight: 700; cursor: pointer; }
      .toggle { width: 100%; }
      .toggle[data-enabled="true"] { background: #344054; }
      .settings { width: 100%; margin-top: 7px; padding: 7px 9px; background: #eef6fd; color: #1570b8; }
      .video { width: 100%; margin-top: 7px; background: #6941c6; }
      .video[data-enabled="true"] { background: #344054; }
      button:disabled { opacity: .55; cursor: wait; }
      .favorite-summary { margin: 10px 0 6px; color: #344054; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
      .secondary { padding: 7px 8px; background: #eef6fd; color: #1570b8; }
      .danger { background: #f2f4f7; color: #667085; }
    `;

    const wrapper = document.createElement("section");
    wrapper.className = "panel";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `英汉同步阅读 v${chrome.runtime.getManifest().version}`;
    const status = document.createElement("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.textContent = "保留英文，在帖子下方显示中文。";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toggle";
    button.textContent = "启用英汉同步";
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "settings";
    settingsButton.textContent = "设置 API Keys";
    const videoButton = document.createElement("button");
    videoButton.type = "button";
    videoButton.className = "video";
    videoButton.textContent = "开始视频翻译";
    const favoriteSummary = document.createElement("div");
    favoriteSummary.className = "favorite-summary";
    favoriteSummary.textContent = "已收藏 0 句";
    const favoriteActions = document.createElement("div");
    favoriteActions.className = "actions";
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "secondary";
    exportButton.textContent = "导出 Word";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "secondary danger";
    clearButton.textContent = "清空收藏";
    favoriteActions.append(exportButton, clearButton);
    wrapper.append(title, status, button, videoButton, settingsButton, favoriteSummary, favoriteActions);
    shadow.append(style, wrapper);

    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (enabled) {
          disableTranslation();
        } else {
          await enableTranslation(true);
        }
      } catch (error) {
        if (recoverInvalidatedExtensionContext(error)) return;
        logDetailedError("Translator initialization failed", error);
        setStatus(humanizeError(error));
      } finally {
        button.disabled = false;
      }
    });

    exportButton.addEventListener("click", exportFavorites);
    clearButton.addEventListener("click", clearFavorites);
    settingsButton.addEventListener("click", async () => {
      try {
        const response = await chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
        if (!response?.ok) setStatus(`无法打开设置：${response?.error || "未知错误"}`);
      } catch (error) {
        if (recoverInvalidatedExtensionContext(error)) return;
        setStatus(`无法打开设置：${humanizeError(error)}`);
      }
    });

    videoButton.addEventListener("click", async () => {
      videoButton.disabled = true;
      try {
        if (videoTranslationActive) {
          const response = await chrome.runtime.sendMessage({ type: "VIDEO_STOP" });
          if (!response?.ok) throw new Error(response?.error || "停止视频翻译失败。");
          resetVideoUi("视频翻译已停止。");
          return;
        }

        const visibleVideo = Array.from(document.querySelectorAll("video")).find((video) => {
          const rect = video.getBoundingClientRect();
          return rect.width > 160 && rect.height > 90 && rect.bottom > 0 && rect.top < innerHeight;
        });
        if (!visibleVideo) throw new Error("请先打开并播放一个当前可见的 X 视频。");

        setStatus("正在捕获当前标签页声音…若被 Chrome 拒绝，请点击浏览器工具栏中的扩展图标启动。");
        const response = await chrome.runtime.sendMessage({ type: "VIDEO_START" });
        if (!response?.ok) throw new Error(response?.error || "无法启动视频翻译。");
        videoTranslationActive = true;
        videoButton.dataset.enabled = "true";
        videoButton.textContent = "停止视频翻译";
        videoCaptions.showWaiting();
        setStatus("正在听取英语对白，首条字幕约 4–7 秒后出现。");
      } catch (error) {
        if (recoverInvalidatedExtensionContext(error)) return;
        setStatus(`视频翻译：${humanizeError(error)}`);
        if (String(error?.message || "").includes("KEY_MISSING")) {
          videoCaptions.showError("请先点击“设置 API Keys”，保存 DeepSeek 与 Groq Key。 ");
        }
      } finally {
        videoButton.disabled = false;
      }
    });

    return { host, button, videoButton, settingsButton, status, favoriteSummary, exportButton, clearButton };
  }

  function createVideoCaptionOverlay() {
    const host = document.createElement("div");
    host.id = VIDEO_CAPTION_HOST_ID;
    host.style.position = "fixed";
    host.style.left = "16px";
    host.style.top = "auto";
    host.style.width = "min(760px, calc(100vw - 32px))";
    host.style.zIndex = "2147483646";
    host.style.display = "none";
    host.style.pointerEvents = "none";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .caption { width: 100%; box-sizing: border-box; padding: 11px 15px;
        border-radius: 12px; background: rgba(9,14,24,.88); color: #fff; box-shadow: 0 8px 28px rgba(0,0,0,.32);
        text-align: center; font-family: system-ui,"Microsoft YaHei",sans-serif; backdrop-filter: blur(8px); }
      .en { color: #f2f4f7; font-size: 14px; line-height: 1.45; }
      .zh { margin-top: 4px; color: #fff; font-size: 18px; font-weight: 750; line-height: 1.5; }
      .hint { color: #d0d5dd; font-size: 14px; }
      .error { color: #fda29b; font-size: 14px; }
    `;
    const wrapper = document.createElement("div");
    wrapper.className = "caption";
    const english = document.createElement("div");
    english.className = "en";
    const chinese = document.createElement("div");
    chinese.className = "zh";
    wrapper.append(english, chinese);
    shadow.append(style, wrapper);

    function findAnchorVideo() {
      return Array.from(document.querySelectorAll("video"))
        .map((video) => ({ video, rect: video.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 160 && rect.height > 90 && rect.bottom > 0 && rect.top < innerHeight)
        .sort((left, right) => {
          const playbackScore = Number(!right.video.paused) - Number(!left.video.paused);
          return playbackScore || right.rect.width * right.rect.height - left.rect.width * left.rect.height;
        })[0] || null;
    }

    function findFlowContainer(video, videoRect) {
      const article = video.closest("article");
      let container = video.closest('[data-testid="videoPlayer"]') || video;
      let candidate = container.parentElement;

      while (candidate && candidate !== article && candidate !== document.body && candidate !== document.documentElement) {
        const rect = candidate.getBoundingClientRect();
        const sameMediaBand =
          Math.abs(rect.width - videoRect.width) <= 24 &&
          rect.top >= videoRect.top - 32 &&
          rect.bottom <= videoRect.bottom + 48;
        if (!sameMediaBand) break;
        container = candidate;
        candidate = candidate.parentElement;
      }

      return container;
    }

    function useViewportFallback() {
      if (host.parentElement !== document.documentElement) document.documentElement.appendChild(host);
      host.style.position = "fixed";
      host.style.margin = "0";
      host.style.left = "50%";
      host.style.width = "min(760px, calc(100vw - 32px))";
      host.style.top = `${Math.max(16, innerHeight - host.offsetHeight - 72)}px`;
      host.style.transform = "translateX(-50%)";
    }

    function reposition() {
      if (host.style.display === "none") return;
      const anchor = findAnchorVideo();
      if (!anchor) {
        useViewportFallback();
        return;
      }

      const mediaContainer = findFlowContainer(anchor.video, anchor.rect);
      if (!mediaContainer.parentElement) {
        useViewportFallback();
        return;
      }
      if (host.previousElementSibling !== mediaContainer) mediaContainer.insertAdjacentElement("afterend", host);
      host.style.position = "relative";
      host.style.left = "0";
      host.style.top = "auto";
      host.style.width = "100%";
      host.style.margin = "8px 0 4px";
      host.style.transform = "none";
    }

    function revealAndPosition() {
      host.style.display = "block";
      requestAnimationFrame(reposition);
    }

    return {
      show(transcript, translation, translating = false) {
        revealAndPosition();
        english.className = "en";
        chinese.className = "zh";
        english.textContent = transcript || "";
        chinese.textContent = translation || (translating ? "翻译中…" : "");
      },
      showWaiting() {
        revealAndPosition();
        english.className = "hint";
        chinese.className = "zh";
        english.textContent = "正在听取当前标签页的英语对白…";
        chinese.textContent = "首条字幕约 4–7 秒后出现";
      },
      showError(text) {
        revealAndPosition();
        english.className = "error";
        chinese.className = "zh";
        english.textContent = text;
        chinese.textContent = "";
      },
      hide() {
        host.style.display = "none";
        english.textContent = "";
        chinese.textContent = "";
      },
      reposition
    };
  }

  function resetVideoUi(message) {
    videoTranslationActive = false;
    panel.videoButton.dataset.enabled = "false";
    panel.videoButton.textContent = "开始视频翻译";
    videoCaptions.hide();
    setStatus(message);
  }

  function recoverInvalidatedExtensionContext(error) {
    if (!String(error?.message || error).includes("Extension context invalidated")) return false;
    setStatus("插件刚刚更新，正在自动刷新 X 页面…");
    setTimeout(() => location.reload(), 180);
    return true;
  }

  function createSelectionCapture() {
    const host = document.createElement("div");
    host.id = SELECTION_HOST_ID;
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.display = "none";
    document.documentElement.appendChild(host);

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      button { padding: 7px 11px; border: 0; border-radius: 999px; background: #101828; color: #fff;
        box-shadow: 0 6px 18px rgba(16,24,40,.24); font: 700 13px/1.2 system-ui,"Microsoft YaHei",sans-serif;
        cursor: pointer; white-space: nowrap; }
      button:disabled { opacity: .65; cursor: wait; }
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "收藏这句";
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", async () => {
      if (!pendingSelection) return;
      button.disabled = true;
      button.textContent = "正在收藏…";
      try {
        const result = await savePendingSelection(pendingSelection);
        button.textContent = result.duplicate ? "已经收藏过" : "已收藏到本地";
        setStatus(result.message);
        setTimeout(hideSelectionCapture, 900);
      } catch (error) {
        button.textContent = "收藏失败";
        setStatus(`收藏失败：${error?.message || error}`);
      } finally {
        setTimeout(() => {
          button.disabled = false;
          button.textContent = "收藏这句";
        }, 1000);
      }
    });
    shadow.append(style, button);
    return { host, button };
  }

  function updateSelectionCapture() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideSelectionCapture();
      return;
    }

    const text = normalizeQuote(selection.toString());
    if (text.length < 3 || text.length > 1000) {
      hideSelectionCapture();
      return;
    }

    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!container || container.closest(`#${UI_HOST_ID}, #${SELECTION_HOST_ID}`)) {
      hideSelectionCapture();
      return;
    }

    pendingSelection = buildFavoriteCandidate(container, text);
    const rect = range.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left, 8), innerWidth - 110);
    const top = Math.max(8, rect.top - 42);
    selectionCapture.host.style.left = `${left}px`;
    selectionCapture.host.style.top = `${top}px`;
    selectionCapture.host.style.display = "block";
  }

  function hideSelectionCapture() {
    pendingSelection = null;
    selectionCapture.host.style.display = "none";
  }

  function buildFavoriteCandidate(container, selectedText) {
    const translationElement = container.closest(`.${TRANSLATION_CLASS}`);
    if (translationElement) {
      const sourceElement = translationElement.previousElementSibling;
      return {
        english: sourceElement ? getSourceText(sourceElement) : "",
        chinese: selectedText,
        fallbackChinese: selectedText
      };
    }

    const sourceElement = container.closest(adapter.selector);
    const sourceText = sourceElement ? getSourceText(sourceElement) : selectedText;
    const nearbyTranslation = sourceElement ? getTranslationElement(sourceElement)?.textContent?.trim() : "";
    const selectionCoversSource = normalizeQuote(sourceText) === selectedText;

    if (isMostlyChinese(selectedText)) {
      return { english: "", chinese: selectedText, fallbackChinese: selectedText };
    }

    return {
      english: selectedText,
      chinese: "",
      fallbackChinese: selectionCoversSource ? nearbyTranslation || "" : ""
    };
  }

  async function savePendingSelection(candidate) {
    const english = normalizeQuote(candidate.english);
    let chinese = normalizeQuote(candidate.chinese || candidate.fallbackChinese);
    let translationFailed = false;

    if (english && !chinese && shouldTranslate(english) && activeProvider) {
      try {
        chinese = normalizeQuote(cache.get(english) || (await translateChunk(english)));
        if (chinese) cache.set(english, chinese);
      } catch {
        translationFailed = true;
      }
    }

    if (!english && !chinese) throw new Error("没有可收藏的文字。");
    const favorites = await getFavorites();
    const duplicate = favorites.some(
      (favorite) => favorite.english === english && favorite.chinese === chinese
    );
    if (!duplicate) {
      favorites.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        english,
        chinese,
        url: location.href,
        pageTitle: document.title,
        savedAt: new Date().toISOString()
      });
      if (favorites.length > MAX_FAVORITES) favorites.splice(0, favorites.length - MAX_FAVORITES);
      await chrome.storage.local.set({ [FAVORITES_KEY]: favorites });
      await refreshFavoriteCount();
    }

    return {
      duplicate,
      message: duplicate
        ? "这句话已经收藏过。"
        : translationFailed
          ? "英文已收藏；本次中文翻译失败，仍可导出 Word。"
          : "已收藏到浏览器本地，可随时导出 Word。"
    };
  }

  async function getFavorites() {
    const stored = await chrome.storage.local.get({ [FAVORITES_KEY]: [] });
    return Array.isArray(stored[FAVORITES_KEY]) ? stored[FAVORITES_KEY] : [];
  }

  async function refreshFavoriteCount() {
    const favorites = await getFavorites();
    panel.favoriteSummary.textContent = `已收藏 ${favorites.length} 句`;
    panel.exportButton.disabled = favorites.length === 0;
    panel.clearButton.disabled = favorites.length === 0;
  }

  async function exportFavorites() {
    panel.exportButton.disabled = true;
    try {
      const favorites = await getFavorites();
      if (!favorites.length) {
        setStatus("还没有收藏语句。先划选一句英文，再点“收藏这句”。");
        return;
      }
      if (!globalThis.BilingualDocx?.createFavoritesDocx) {
        throw new Error("DOCX 导出组件没有加载，请重新加载扩展。 ");
      }

      const blob = globalThis.BilingualDocx.createFavoritesDocx(favorites);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `英汉语句收藏-${new Date().toISOString().slice(0, 10)}.docx`;
      link.style.display = "none";
      document.documentElement.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setStatus(`已导出 ${favorites.length} 句到 Word 文档。`);
    } catch (error) {
      setStatus(`导出失败：${error?.message || error}`);
    } finally {
      await refreshFavoriteCount();
    }
  }

  async function clearFavorites() {
    const favorites = await getFavorites();
    if (!favorites.length) return;
    if (!window.confirm(`确定清空本地收藏的 ${favorites.length} 句话吗？此操作无法撤销。`)) return;
    await chrome.storage.local.set({ [FAVORITES_KEY]: [] });
    await refreshFavoriteCount();
    setStatus("本地收藏已清空。");
  }

  function normalizeQuote(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isMostlyChinese(text) {
    const latinCount = (text.match(/[A-Za-z]/g) || []).length;
    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
    return cjkCount > latinCount;
  }

  async function enableTranslation(fromUserClick) {
    setStatus("正在连接 DeepSeek V4 Flash…");
    let deepSeekHealth = null;
    try {
      deepSeekHealth = await chrome.runtime.sendMessage({ type: "DEEPSEEK_HEALTH" });
    } catch (error) {
      deepSeekHealth = { ok: false, error: error?.message || String(error) };
    }

    if (deepSeekHealth?.ok) {
      activeProvider = "deepseek";
    } else {
      setStatus(
        deepSeekHealth?.configured
          ? "DeepSeek 暂时无法连接，正在启用 Chrome 本地备用…"
          : "尚未配置 DeepSeek Key，正在启用 Chrome 本地备用…"
      );
      try {
        await createLocalTranslator(fromUserClick);
        activeProvider = "chrome";
      } catch (localError) {
        const detail = deepSeekHealth?.error || "尚未配置 DeepSeek Key";
        const code = deepSeekHealth?.configured
          ? "DEEPSEEK_API_UNAVAILABLE"
          : "DEEPSEEK_KEY_MISSING";
        const combined = new Error(`${code}: ${detail}`);
        combined.name = localError?.name || "DeepSeekUnavailableError";
        throw combined;
      }
    }

    enabled = true;
    panel.button.dataset.enabled = "true";
    panel.button.textContent = "关闭英汉同步";
    setStatus(
      activeProvider === "deepseek"
        ? "已开启：DeepSeek V4 Flash 主翻译。"
        : deepSeekHealth?.configured
          ? "DeepSeek 暂不可用，当前使用 Chrome 本地备用。"
          : "尚未配置 DeepSeek Key，当前使用 Chrome 本地备用。"
    );
    await chrome.storage.local.set({ bilingualReaderEnabled: true });
    scan();
  }

  function disableTranslation() {
    enabled = false;
    translator?.destroy?.();
    translator = null;
    activeProvider = null;
    document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((node) => node.remove());
    document.querySelectorAll(`.${UI_TRANSLATION_CLASS}`).forEach((node) => node.remove());
    panel.button.dataset.enabled = "false";
    panel.button.textContent = "启用英汉同步";
    setStatus("已关闭，英文原文保持不变。");
    chrome.storage.local.set({ bilingualReaderEnabled: false });
  }

  function setStatus(message) {
    panel.status.textContent = message;
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 120);
  }

  function scan() {
    if (enabled) syncUiLabels();

    for (const element of getTranslationTargets()) {
      if (!observed.has(element)) {
        observed.add(element);
        visibilityObserver.observe(element);
      }

      const source = getSourceText(element);
      const outputMissing = !getTranslationElement(element);
      if (enabled && source && (sourceByElement.get(element) !== source || outputMissing) && isNearViewport(element)) {
        if (outputMissing) sourceByElement.delete(element);
        scheduleTranslation(element);
      }
    }
  }

  function scheduleTranslation(element) {
    if (!enabled || !activeProvider || !element.isConnected) return;
    const source = getSourceText(element);
    if (!shouldTranslate(source)) return;
    if (sourceByElement.get(element) === source && getTranslationElement(element)) return;

    sourceByElement.set(element, source);
    queue = queue
      .then(() => translateElement(element, source))
      .catch((error) => {
        logDetailedError("Translation queue failed", error);
      });
  }

  async function translateElement(element, source) {
    if (!enabled || !element.isConnected || getSourceText(element) !== source) return;

    const output = ensureTranslationElement(element);
    output.dataset.state = "loading";
    output.textContent = "翻译中…";

    try {
      let translated = cache.get(source);
      if (!translated) {
        const chunks = splitText(source, MAX_CHUNK_LENGTH);
        const results = [];
        for (const chunk of chunks) results.push(await translateChunk(chunk));
        translated = results.join("\n");
        cache.set(source, translated);
      }

      if (!enabled || !element.isConnected || getSourceText(element) !== source) return;
      output.dataset.state = "ready";
      output.textContent = translated;
    } catch (error) {
      sourceByElement.delete(element);
      output.dataset.state = "error";
      output.textContent = `翻译失败：${humanizeError(error)}`;
    }
  }

  async function translateChunk(text) {
    if (activeProvider === "deepseek") {
      let response;
      try {
        response = await chrome.runtime.sendMessage({ type: "DEEPSEEK_TRANSLATE", text });
      } catch (error) {
        response = { ok: false, error: error?.message || String(error) };
      }

      if (response?.ok && response.translation) return response.translation;

      try {
        await createLocalTranslator(false);
        activeProvider = "chrome";
        setStatus("DeepSeek 暂时不可用，已切换到 Chrome 本地备用。");
        return translator.translate(text);
      } catch {
        throw new Error(`DEEPSEEK_TRANSLATE_FAILED: ${response?.error || "未知错误"}`);
      }
    }

    if (activeProvider === "chrome" && translator) return translator.translate(text);
    throw new Error("NO_TRANSLATION_PROVIDER");
  }

  async function createLocalTranslator(fromUserClick) {
    if (translator) return translator;
    if (!("Translator" in self)) throw new Error("UNSUPPORTED_TRANSLATOR");

    if (!fromUserClick) {
      const availability = await Translator.availability({
        sourceLanguage: "en",
        targetLanguage: "zh"
      });
      if (availability === "unavailable") throw new Error("UNAVAILABLE_LANGUAGE_PAIR");
      if (availability !== "available") throw new Error("USER_ACTIVATION_REQUIRED");
    }

    translator = await Translator.create({
      sourceLanguage: "en",
      targetLanguage: "zh",
      monitor(monitor) {
        monitor.addEventListener("downloadprogress", (event) => {
          setStatus(`首次下载 Chrome 备用模型：${Math.round(event.loaded * 100)}%`);
        });
      }
    });
    return translator;
  }

  function ensureTranslationElement(sourceElement) {
    const existing = getTranslationElement(sourceElement);
    if (existing) return existing;

    const output = document.createElement("div");
    output.className = TRANSLATION_CLASS;
    output.setAttribute("lang", "zh-CN");
    sourceElement.insertAdjacentElement("afterend", output);
    return output;
  }

  function getTranslationElement(sourceElement) {
    const next = sourceElement.nextElementSibling;
    return next?.classList.contains(TRANSLATION_CLASS) ? next : null;
  }

  function getTranslationTargets() {
    const candidates = Array.from(document.querySelectorAll(adapter.selector)).filter((element) => {
      if (element.closest(`#${UI_HOST_ID}`) || element.classList.contains(TRANSLATION_CLASS)) return false;

      const tweetText = element.closest('[data-testid="tweetText"]');
      if (tweetText) return element === tweetText;

      if (
        element.closest(
          '[data-testid="User-Name"], [data-testid="socialContext"], [role="group"], button, time'
        )
      ) {
        return false;
      }

      const source = getSourceText(element);
      const insideArticleReadView = Boolean(
        element.closest('[data-testid="twitterArticleReadView"]')
      );
      const minimumLength = insideArticleReadView ? 3 : 20;
      return source.length >= minimumLength && shouldTranslate(source);
    });

    // X cards can expose nested dir="auto" containers. Translate the deepest
    // meaningful blocks to avoid duplicating the same title or summary.
    return candidates.filter(
      (element) => !candidates.some((other) => other !== element && element.contains(other))
    );
  }

  function syncUiLabels() {
    for (const root of document.querySelectorAll(adapter.uiSelector)) {
      const oldMarkers = Array.from(root.querySelectorAll(`.${UI_TRANSLATION_CLASS}`));
      const candidates = [root, ...root.querySelectorAll("*")].reverse();
      let textElement = null;
      let translated = null;

      for (const candidate of candidates) {
        if (candidate.getClientRects().length === 0) continue;
        const source = Array.from(candidate.childNodes)
          .filter(
            (node) =>
              !(node.nodeType === Node.ELEMENT_NODE && node.classList.contains(UI_TRANSLATION_CLASS))
          )
          .map((node) => (node.nodeType === Node.TEXT_NODE ? node.textContent : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const match = UI_LABEL_TRANSLATIONS.get(source);
        if (match) {
          textElement = candidate;
          translated = match;
          break;
        }
      }

      if (!textElement || !translated) {
        oldMarkers.forEach((marker) => marker.remove());
        continue;
      }

      const markerAtTarget = oldMarkers.find((marker) => marker.parentElement === textElement);
      oldMarkers.filter((marker) => marker !== markerAtTarget).forEach((marker) => marker.remove());
      if (markerAtTarget) {
        if (markerAtTarget.textContent !== translated) markerAtTarget.textContent = translated;
        continue;
      }

      const marker = document.createElement("span");
      marker.className = UI_TRANSLATION_CLASS;
      marker.setAttribute("lang", "zh-CN");
      marker.textContent = translated;
      textElement.appendChild(marker);
    }
  }

  function getSourceText(element) {
    return element.innerText.replace(/\s+\n/g, "\n").trim();
  }

  function shouldTranslate(text) {
    if (!text || text.length < 2) return false;
    const latinCount = (text.match(/[A-Za-z]/g) || []).length;
    const cjkCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
    return latinCount >= 3 && latinCount > cjkCount;
  }

  function isNearViewport(element) {
    const rect = element.getBoundingClientRect();
    return rect.bottom >= -240 && rect.top <= innerHeight + 240;
  }

  function splitText(text, limit) {
    if (text.length <= limit) return [text];
    const chunks = [];
    let rest = text;
    while (rest.length > limit) {
      let cut = Math.max(rest.lastIndexOf("\n", limit), rest.lastIndexOf(". ", limit));
      if (cut < limit * 0.55) cut = limit;
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
  }

  function humanizeError(error) {
    const message = String(error?.message || error);
    if (message.includes("DEEPSEEK_KEY_MISSING")) return "尚未配置 DeepSeek Key，请点击“设置 DeepSeek Key”。";
    if (message.includes("DEEPSEEK_AUTH_INVALID")) return "DeepSeek Key 无效或已撤销，请在设置页重新连接。";
    if (message.includes("DEEPSEEK_BALANCE")) return "DeepSeek API 余额不足，请充值后重试。";
    if (message.includes("DEEPSEEK_RATE_LIMIT")) return "DeepSeek 请求过于频繁，请稍后重试。";
    if (message.includes("DEEPSEEK_API_UNAVAILABLE")) return "DeepSeek API 暂时无法连接，请检查网络或设置。";
    if (message.includes("DEEPSEEK_TRANSLATE_FAILED")) return "DeepSeek 翻译失败，请检查 Key、账户余额或网络。";
    if (message.includes("GROQ_KEY_MISSING")) return "尚未配置 Groq Key，请点击“设置 API Keys”。";
    if (message.includes("GROQ_AUTH_INVALID")) return "Groq Key 无效或已撤销，请在设置页重新连接。";
    if (message.includes("GROQ_RATE_LIMIT")) return "Groq 语音识别请求过于频繁或额度不足，请稍后重试。";
    if (message.includes("GROQ_AUDIO_TOO_LARGE")) return "视频音频片段过大，请停止后重试。";
    if (message.includes("GROQ_API_ERROR")) return "Groq 语音识别失败，请检查 Key、额度或网络。";
    if (/tab capture|activeTab|invoked|gesture|调用扩展|用户调用/i.test(message)) {
      return "Chrome 要求从工具栏启动：请点击浏览器右上角的“英汉同步阅读”扩展图标。";
    }
    if (message.includes("NO_TRANSLATION_PROVIDER")) return "当前没有可用翻译模型。";
    if (message.includes("UNSUPPORTED_TRANSLATOR")) return "请使用支持 Translator API 的桌面版 Chrome 138 或更高版本。";
    if (message.includes("UNAVAILABLE_LANGUAGE_PAIR")) return "当前浏览器无法使用英译中语言包。";
    if (message.includes("USER_ACTIVATION_REQUIRED")) {
      return "请点击启用按钮，授权首次模型下载。";
    }
    if (error?.name === "NotAllowedError") {
      return "Chrome 拒绝创建翻译模型。请刷新 X 后直接点击启用；若仍失败，请检查 chrome://on-device-internals 的 Model Status。";
    }
    if (error?.name === "NetworkError") return "语言模型下载失败或被取消，请检查网络后重试。";
    if (error?.name === "InvalidStateError") return "当前页面状态无效，请刷新 X 后重试。";
    if (error?.name === "NotSupportedError") return "当前 Chrome 不支持这个英中语言组合。";
    if (error?.name === "OperationError") return "Chrome 本地翻译模型暂时无法创建，请重启浏览器后重试。";
    return `${error?.name ? `${error.name}: ` : ""}${message}`;
  }

  function logDetailedError(context, error) {
    const name = error?.name || "Error";
    const message = error?.message || String(error);
    console.error(`${context}: ${name}: ${message}`, error?.stack || "");
  }
})();
