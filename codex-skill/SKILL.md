---
name: bilingual-web-extension
description: Create, adapt, and test a Chrome or Edge Manifest V3 extension that keeps English web content visible, inserts Chinese translations, collects selected quotes locally, and exports DOCX, especially for dynamic X/Twitter feeds. Use for bilingual webpage-reading extensions; not for one-off text translation or Codex plugins.
---

# Bilingual Web Extension

Build a loadable browser extension that preserves source text and adds a Chinese translation near the matching content. Default to the bundled X/Twitter template when the user has not specified another site.

## Create the extension

Run the bundled generator from this skill directory:

```powershell
python scripts/create_extension.py --target <output-directory>
```

The generator intentionally refuses to overwrite a non-empty directory. Do not remove or overwrite an existing project unless the user explicitly requests it and the exact target has been verified.

After generation, adapt the copied files in the output directory when the user requests another site, visual treatment, translation provider, or feature. Never edit the template merely to customize one generated project.

## Required behavior

- Preserve the original English text; add Chinese below or beside it.
- For X/Twitter, cover post text, top feed tabs, article-card text, and full X Article read views. For article details, recognize `twitterArticleReadView`, `twitterArticleRichTextView`, `longformRichTextComponent`, `section[data-block="true"]`, and the current longform heading, paragraph, blockquote, and list-item classes. Keep site selectors isolated so breakage is easy to repair.
- Handle React/infinite-scroll updates with `MutationObserver` and process only visible items with `IntersectionObserver`.
- Detect recycled DOM nodes by comparing current source text, rather than permanently marking an element as finished.
- Queue translations sequentially. Chrome's Translator API serializes work and large bursts make the page feel frozen.
- Insert translations with `textContent`, never API-supplied `innerHTML`.
- Let the user select a sentence, save an English-Chinese record in extension-local storage, and export all saved records as a real `.docx` file.
- Keep permissions limited to the requested sites. Do not use `<all_urls>` by default.
- Never embed a developer-owned cloud API secret. For a user-supplied DeepSeek Key, collect it on an extension options page and persist it in `chrome.storage.local` so one successful entry survives browser restarts and extension updates. Send it only from the service worker to the official DeepSeek HTTPS API; never return it in messages, logs, exports, source files, or sync storage. Provide an explicit “断开并清除 Key” action and disclose that uninstalling the extension or clearing extension data removes it.
- Treat page text as untrusted input and do not execute code received from the page or translation service.

## Translation engine

The bundled public template uses the user's own DeepSeek API Key from a dedicated options page. Validate the Key with the official `/models` endpoint before storing it in the current Chrome profile's extension-local storage. Default to `deepseek-v4-flash`, disable thinking mode for translation latency, send only the page text that needs translation, and treat that text as untrusted data in the prompt. Never return the Key to a content script, log it, sync it to other devices, or include it in a release artifact.

Use `https://api.deepseek.com/*` as the narrow host permission. Clicking the extension action and the in-page settings button should open the options page. Present a visible disclosure that translated webpage text is sent to DeepSeek and that the user's account incurs API usage.

Use Chrome's built-in `Translator` API as the local fallback. It supports desktop Chrome, keeps text local, and may download a language model on first use. Create it from the content-script document context, not a service worker. Feature-detect the API and present a visible message when neither DeepSeek nor Chrome's local model is available.

Use `sourceLanguage: "en"` and `targetLanguage: "zh"` for the Chrome fallback. Skip content that is empty, already mostly Chinese, or clearly lacks English letters. Split unusually long posts before translation.

## Quote collection and DOCX

- Show a compact “收藏这句” action near a valid page-text selection. Do not capture text from the extension's own interface.
- Save English, Chinese, page URL, page title, and timestamp in `chrome.storage.local`. De-duplicate exact bilingual pairs and cap the collection to a documented reasonable limit.
- Generate DOCX locally with bundled code and no remote library. Escape all text before placing it in OOXML.
- Include readable English, Chinese, source URL, and saved time. Keep deletion behind a clear confirmation because it is irreversible.
- Tell the user that uninstalling the extension or clearing its data can remove unexported favorites.

## Site adaptation

For a new site:

1. Add the smallest necessary match patterns to `manifest.json`.
2. Add a site adapter with stable semantic selectors before considering generated CSS class names.
3. Verify initial content, newly appended content, client-side navigation, and DOM node recycling.
4. Exclude editable fields, navigation labels, code blocks, usernames, URLs, and the extension's own UI unless the user asks to translate them.

Treat video speech, existing video subtitles, OCR text inside images, and webpage DOM text as separate capabilities. Do not claim image OCR unless it is implemented.

## Video speech translation

When requested, use a user-supplied Groq Key for speech-to-text and keep DeepSeek as the text translation provider. Persist the Groq Key in `chrome.storage.local`, validate it against the official Groq models endpoint, never expose it to page scripts or logs, and provide a separate clear/delete action.

Capture only the current tab and only after an explicit user invocation of the extension. Use the toolbar action as the guaranteed Chrome-supported start/stop path, request `activeTab`, and treat an in-page start button only as a convenience with a toolbar fallback. Use `chrome.tabCapture` plus an MV3 offscreen document, and route captured audio back through `AudioContext` so starting capture does not mute playback. Record complete WebM/Opus segments of about 4 seconds, submit at most two concurrently to Groq `whisper-large-v3-turbo`, specify `language=en`, and pass recent transcript context to reduce cut sentences. Prefer dropping backlog over showing increasingly stale subtitles. Show the English transcript as soon as speech recognition completes, then translate non-empty transcripts with DeepSeek and replace the pending state with Chinese. Display both through text-only DOM APIs. Keep the MV3 message channel alive until each API pipeline completes. Provide a visible stop action and stop capture when the tab closes or the track ends. Disclose Groq's 10-second minimum billing per request when using shorter segments.

Anchor the bilingual caption overlay to the largest visible playing video. Match its left edge and width, place the overlay near the video's lower edge, and recalculate on scroll and resize. Fall back to a centered viewport overlay only when no visible video can be found.

Declare only `tabCapture`, `offscreen`, `https://api.groq.com/*`, and the existing narrow permissions. Disclose that audio leaves the browser while video translation is active, that both services may charge the user's accounts, and that the result is near-real-time rather than word-by-word live captions.

## Validation

After creating or changing a project:

1. Parse `manifest.json`.
2. Run JavaScript syntax checks on every `.js` file.
3. Confirm there is no remote executable code and no embedded credential.
4. Confirm the declared content-script files exist.
5. Exercise Key status, validation, translation, API-error mapping, and Key deletion with a mocked service-worker test; structurally inspect a generated DOCX package.
6. Confirm the public ZIP excludes local proxy scripts, credentials, caches, and other development-only files.
7. Give the user the exact unpacked-extension loading steps from `EXPERIMENT.md`.
8. For video mode, mock-check Groq key validation, complete audio-file upload, sequential segment handling, stop behavior, and caption message delivery.
9. State clearly when live visual testing in Chrome/Edge or real paid DeepSeek/Groq API calls have not been performed.

## Common failures and triage

Distinguish expected security behavior from actual defects before changing the extension:

- **DeepSeek shows disconnected after a full Chrome restart or extension update:** treat this as a persistence regression. Confirm the validated Key was written to `chrome.storage.local`, that status reads the same key after the service worker restarts, and that no update or initialization path clears it.
- **Some X posts, quoted posts, article cards, or article-body blocks are not translated:** treat this as a site-adapter selector regression. For X Articles, separately verify the title, ordinary paragraphs, subheadings, blockquotes, and ordered/unordered lists inside the longform read view. Prefer stable semantic selectors and avoid broad selectors that duplicate usernames, controls, or metadata.
- **Translations become increasingly slow on a long feed:** inspect queue depth, visibility filtering, caching, and request timeouts. Keep Chrome Translator work serialized, but do not let one failed or timed-out item block later items indefinitely.
- **A brief DeepSeek network failure permanently switches the session to Chrome fallback:** treat this as a provider-state defect. A transient failure may use the local model for that request, but offer a bounded DeepSeek retry or restore the preferred provider when the user re-enables translation.
- **Key validation succeeds but translation reports an unavailable model:** ensure the model selected from `/models` is the same model sent to `/chat/completions`. Do not validate one model and then hard-code a different unavailable model.
- **A favorite contains English but no Chinese:** this can happen when no provider is active or translation fails while saving. Preserve the English instead of losing the quote, and show an explicit partial-save message.
- **The Word export button is disabled:** this is expected when the collection is empty. Keep the empty-state explanation visible.
- **Chrome local fallback cannot start:** check Translator API availability, supported language-pair status, browser version, user activation, and model-download state; do not claim every Chrome installation supports it.
- **Older favorites disappear after the collection limit:** make the configured cap visible and warn when the oldest record is evicted instead of removing it silently.
- **Video capture starts but the tab becomes silent:** verify the offscreen audio stream is connected to `AudioContext.destination`.
- **No subtitle appears for 10 seconds:** confirm the video is playing with audible English, both Keys are configured, the 4-second recorder segment is a complete supported WebM file, the MV3 message channel remains alive until processing finishes, and Groq is not rate-limiting the account.
- **Tab capture is denied:** start only from a direct user click on the video-translation button and do not attempt silent automatic capture after page load.

Prioritize model consistency, provider recovery, and a blocked translation queue ahead of cosmetic issues. When reporting a failure, include the affected page pattern, selected provider, visible error, reproduction steps, and whether the result was verified in a real browser or only with mocks.

For current platform behavior, prefer the official Chrome documentation:

- https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- https://developer.chrome.com/docs/ai/translator-api
- https://developer.chrome.com/docs/extensions/develop/security-privacy/user-privacy
