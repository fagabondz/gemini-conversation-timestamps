/**
 * Gemini Conversation Timestamps - Network Interceptor (v2)
 * Runs in MAIN world at document_start to intercept API responses safely.
 *
 * CHANGES v2:
 *  - Split routing: sidebar (MaZiqc) only extracts `edited`; individual conversation
 *    (hNvQHb / stream) extracts both `created` (first msg) and `edited` (last msg).
 *  - Stricter proto timestamp regex: requires [epoch10, nanos1-9] bracket format.
 *  - `source` field appended to TIMESTAMPS_FOUND payload so content.js can apply
 *    correct merge priority rules.
 *  - ACTIVE_INTERACTION broadcast only for conversation-specific API calls.
 */
(function () {
  'use strict';

  if (window.__gct_interceptor_loaded) return;
  window.__gct_interceptor_loaded = true;

  const SOURCE_TAG = 'gemini-timestamp-interceptor';

  /* ─────────────────────────────── helpers ─────────────────────────────── */

  function normalizeId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.startsWith('c_') ? id.slice(2) : id;
  }

  function getActiveConversationId() {
    try {
      const m = window.location.pathname.match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (m && m[1]) {
        const id = normalizeId(m[1]);
        if (id && id !== 'new') return id;
      }
    } catch (_) {}
    return null;
  }

  function broadcast(type, payload) {
    try {
      window.postMessage({ source: SOURCE_TAG, type, payload }, window.location.origin);
    } catch (_) {}
  }

  /* ───────────────────────────── timestamp parsing ─────────────────────── */

  /**
   * STRICTER proto timestamp regex: matches ONLY `[10-digit-epoch, 1-9-digit-nanos]`
   * bracket pairs. This eliminates false positives from bare numbers.
   *
   * Valid epoch range covered: Jan 2023 (1672531200) → Dec 2036 (2113401600)
   */
  function makeProtoRe() {
    return /\[\s*(1[6-9]\d{8}|20\d{8})\s*,\s*\d{1,9}\s*\]/g;
  }

  /**
   * Returns the FIRST proto timestamp found in `text` as milliseconds, or null.
   * Searches at most `limit` characters from the start.
   */
  function firstTimestamp(text, limit) {
    const sample = limit && text.length > limit ? text.slice(0, limit) : text;
    const re = makeProtoRe();
    const m = re.exec(sample);
    return m ? parseInt(m[1], 10) * 1000 : null;
  }

  /**
   * Returns ALL proto timestamps found in `text` as an ordered array of milliseconds.
   * Searches at most `limit` characters.
   */
  function allTimestamps(text, limit) {
    const sample = limit && text.length > limit ? text.slice(0, limit) : text;
    const re = makeProtoRe();
    const out = [];
    let m;
    let guard = 0;
    while ((m = re.exec(sample)) !== null && guard++ < 2000) {
      out.push(parseInt(m[1], 10) * 1000);
    }
    return out;
  }

  /* ──────────────────────────── URL classifiers ────────────────────────── */

  /**
   * Sidebar conversation list response (batchexecute?rpcids=MaZiqc).
   * Contains ONE timestamp per conversation = LAST ACTIVITY (edited) time.
   * Creation time is NOT reliably present here.
   */
  function isSidebarUrl(url) {
    return url.includes('MaZiqc');
  }

  /**
   * Individual conversation load (hNvQHb) or streaming generation.
   * Contains per-message timestamps in chronological order:
   *   first = created, last = edited.
   */
  function isConversationUrl(url) {
    return (
      url.includes('hNvQHb') ||
      url.includes('streamGenerateContent') ||
      url.includes('assistant.vertical.stream')
    );
  }

  /** Any Gemini data/RPC endpoint worth intercepting. */
  function isTargetUrl(url) {
    if (!url) return false;
    const s = url.toString();
    return (
      s.includes('batchexecute') ||
      s.includes('BardChatUi') ||
      s.includes('assistant.vertical.stream') ||
      s.includes('streamGenerateContent')
    );
  }

  /* ─────────────────────────── response parsers ────────────────────────── */

  /**
   * Parse SIDEBAR LIST response (MaZiqc).
   *
   * Design decision: sidebar only provides last-activity timestamps, so we
   * extract ONLY `edited`. `created` is intentionally omitted to prevent
   * stale/wrong server metadata from being stored as creation time.
   *
   * content.js will handle `created` via:
   *   a) Local tracking when user sends first message (lvc=true, highest priority).
   *   b) Individual conversation response (hNvQHb), which has per-message timestamps.
   */
  function parseSidebarResponse(text) {
    const seen = new Map();
    const blocks = text.split('"c_');

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      const idMatch = block.match(/^([a-zA-Z0-9_-]{4,128})/);
      if (!idMatch) continue;

      const normId = normalizeId(idMatch[1]);
      if (!normId || seen.has(normId)) continue;

      // Take FIRST proto timestamp in the first 2 KB of this block.
      // In the Gemini sidebar response, this position corresponds to the
      // conversation's last-modified time (= edited).
      const ts = firstTimestamp(block, 2048);
      if (ts && ts > 1672531200000) {
        seen.set(normId, {
          id: normId,
          created: null,  // explicitly null → content.js must not overwrite lvc-created
          edited: ts,
          source: 'sidebar',
        });
      }
    }

    if (seen.size > 0) {
      broadcast('TIMESTAMPS_FOUND', Array.from(seen.values()));
    }
  }

  /**
   * Parse INDIVIDUAL CONVERSATION response (hNvQHb / stream).
   *
   * Messages appear in chronological order in the protobuf response, so:
   *   • FIRST proto timestamp  = timestamp of first user message  (→ created)
   *   • LAST  proto timestamp  = timestamp of last  user message  (→ edited)
   *
   * This is Approach 2: "Parsing First/Last Message Timestamps".
   * Server data here is reasonably accurate for message-level timing.
   * content.js will still respect any existing lvc=true created value.
   */
  function parseConversationResponse(text, conversationId) {
    if (!conversationId) return;

    // Limit payload scan to 500 KB for performance safety
    const tsList = allTimestamps(text, 500000);
    if (tsList.length === 0) return;

    // tsList is in order-of-appearance = chronological for message payloads
    const created = tsList[0];
    const edited = tsList[tsList.length - 1];

    if (created > 1672531200000 && edited >= created) {
      broadcast('TIMESTAMPS_FOUND', [{
        id: conversationId,
        created,
        edited,
        source: 'conversation',
      }]);
    }
  }

  /**
   * Route a completed response to the appropriate parser.
   */
  function routeResponse(urlStr, text) {
    if (isSidebarUrl(urlStr)) {
      parseSidebarResponse(text);
    } else if (isConversationUrl(urlStr)) {
      parseConversationResponse(text, getActiveConversationId());
    }
    // Other endpoints are ignored to minimise false positives.
  }

  /* ───────────────────────────── XHR intercept ────────────────────────── */

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._gct_url = url;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const urlStr = (xhr._gct_url || '').toString();

      if (isTargetUrl(urlStr)) {
        xhr.addEventListener('load', function () {
          if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
            routeResponse(urlStr, xhr.responseText);
          }
        }, { passive: true });

        // Signal active interaction only for conversation-specific calls
        if (isConversationUrl(urlStr)) {
          const activeId = getActiveConversationId();
          if (activeId) {
            broadcast('ACTIVE_INTERACTION', { id: activeId, timestamp: Date.now() });
          }
        }
      }

      return origSend.apply(this, arguments);
    };
  } catch (_) {}

  /* ─────────────────────────── fetch intercept ────────────────────────── */

  try {
    const origFetch = window.fetch;

    window.fetch = function (input, init) {
      const urlStr = (typeof input === 'string' ? input : (input && input.url) || '').toString();

      if (isTargetUrl(urlStr)) {
        if (isConversationUrl(urlStr)) {
          const activeId = getActiveConversationId();
          if (activeId) {
            broadcast('ACTIVE_INTERACTION', { id: activeId, timestamp: Date.now() });
          }
        }

        return origFetch.apply(this, arguments).then(function (response) {
          try {
            response.clone().text().then(function (text) {
              routeResponse(urlStr, text);
            }).catch(function () {});
          } catch (_) {}
          return response;
        });
      }

      return origFetch.apply(this, arguments);
    };
  } catch (_) {}

  /* ──────────────────────── SPA navigation hooks ─────────────────────── */

  try {
    const origPush    = history.pushState;
    const origReplace = history.replaceState;

    function onNavigate() {
      const id = getActiveConversationId();
      if (id) broadcast('NAVIGATED', { id, timestamp: Date.now() });
    }

    history.pushState = function () {
      const res = origPush.apply(this, arguments);
      setTimeout(onNavigate, 50);
      return res;
    };

    history.replaceState = function () {
      const res = origReplace.apply(this, arguments);
      setTimeout(onNavigate, 50);
      return res;
    };

    window.addEventListener('popstate', onNavigate);
  } catch (_) {}
})();
