/**
 * Gemini Conversation Timestamps - Network Interceptor
 * Runs in MAIN world at document_start to intercept API responses safely.
 */
(function () {
  'use strict';

  // Prevent double-injection
  if (window.__gct_interceptor_loaded) return;
  window.__gct_interceptor_loaded = true;

  const SOURCE_TAG = 'gemini-timestamp-interceptor';

  /**
   * Helper to normalize conversation IDs (strip 'c_' prefix if present)
   */
  function normalizeId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.startsWith('c_') ? id.slice(2) : id;
  }

  /**
   * Helper to get active conversation ID from the current page URL
   */
  function getActiveConversationId() {
    try {
      const match = window.location.pathname.match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        const id = normalizeId(match[1]);
        if (id && id !== 'new') return id;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Safely posts extracted data to content script (isolated world)
   */
  function broadcast(type, payload) {
    try {
      window.postMessage(
        {
          source: SOURCE_TAG,
          type: type,
          payload: payload,
        },
        window.location.origin
      );
    } catch (_) {}
  }

  /**
   * Extract conversation IDs and their created/edited timestamps from text
   */
  function parseTimestamps(text) {
    if (!text || typeof text !== 'string') return;

    try {
      const results = [];
      const seen = new Map();

      // Gemini conversation blocks typically split by '"c_'
      const blocks = text.split('"c_');
      if (blocks.length > 1) {
        for (let i = 1; i < blocks.length; i++) {
          const block = blocks[i];
          const idMatch = block.match(/^([a-zA-Z0-9_-]{4,128})/);
          if (!idMatch) continue;

          const normId = normalizeId(idMatch[1]);
          const tsList = [];

          // 1. Match Google Proto Timestamp [seconds, nanos] or [seconds]
          // Valid epoch range: 2023 (~1672531200) to 2035 (~2051222400)
          const protoRegex = /\[\s*(1[6-9]\d{8}|2\d{9})(?:\s*,\s*\d+)?\s*\]/g;
          let m;
          while ((m = protoRegex.exec(block)) !== null) {
            tsList.push(parseInt(m[1], 10) * 1000);
          }

          // 2. Fallback to bare epoch timestamps in the same valid range
          if (tsList.length === 0) {
            const bareRegex = /\b(1[6-9]\d{8}|2\d{9})\b/g;
            while ((m = bareRegex.exec(block)) !== null) {
              tsList.push(parseInt(m[1], 10) * 1000);
            }
          }

          if (tsList.length > 0) {
            tsList.sort((a, b) => a - b);
            const created = tsList[0];
            const edited = tsList[tsList.length - 1];

            if (!seen.has(normId)) {
              seen.set(normId, { id: normId, created: created, edited: edited });
            } else {
              const prev = seen.get(normId);
              prev.created = Math.min(prev.created, created);
              prev.edited = Math.max(prev.edited, edited);
            }
          }
        }
      }

      // Also check active conversation turns (e.g. single chat view RPCs like hNvQHb)
      const activeId = getActiveConversationId();
      if (activeId) {
        const tsList = [];
        const protoRegex = /\[\s*(1[6-9]\d{8}|2\d{9})(?:\s*,\s*\d+)?\s*\]/g;
        let m;
        // Limit search to prevent overhead on enormous payloads
        const searchSample = text.length > 300000 ? text.slice(0, 300000) : text;
        while ((m = protoRegex.exec(searchSample)) !== null) {
          tsList.push(parseInt(m[1], 10) * 1000);
        }

        if (tsList.length > 0) {
          tsList.sort((a, b) => a - b);
          const created = tsList[0];
          const edited = tsList[tsList.length - 1];

          if (!seen.has(activeId)) {
            seen.set(activeId, { id: activeId, created: created, edited: edited });
          } else {
            const prev = seen.get(activeId);
            prev.created = Math.min(prev.created, created);
            prev.edited = Math.max(prev.edited, edited);
          }
        }
      }

      if (seen.size > 0) {
        const items = Array.from(seen.values());
        broadcast('TIMESTAMPS_FOUND', items);
      }
    } catch (_) {}
  }

  /**
   * Check if a URL belongs to batchexecute or Gemini data APIs
   */
  function isTargetUrl(url) {
    if (!url) return false;
    const str = url.toString();
    return (
      str.includes('batchexecute') ||
      str.includes('BardChatUi') ||
      str.includes('assistant.vertical.stream') ||
      str.includes('streamGenerateContent')
    );
  }

  // --- 1. Intercept XMLHttpRequest ---
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._gct_url = url;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const xhr = this;
      const url = xhr._gct_url;

      if (isTargetUrl(url)) {
        xhr.addEventListener(
          'load',
          function () {
            if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
              parseTimestamps(xhr.responseText);
            }
          },
          { passive: true }
        );

        // Also track that an interaction occurred in current conversation
        const activeId = getActiveConversationId();
        if (activeId) {
          broadcast('ACTIVE_INTERACTION', { id: activeId, timestamp: Date.now() });
        }
      }

      return origSend.apply(this, arguments);
    };
  } catch (_) {}

  // --- 2. Intercept window.fetch ---
  try {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';

      if (isTargetUrl(url)) {
        const activeId = getActiveConversationId();
        if (activeId) {
          broadcast('ACTIVE_INTERACTION', { id: activeId, timestamp: Date.now() });
        }

        return origFetch.apply(this, arguments).then(function (response) {
          try {
            const clone = response.clone();
            clone
              .text()
              .then(function (text) {
                parseTimestamps(text);
              })
              .catch(function () {});
          } catch (_) {}
          return response;
        });
      }

      return origFetch.apply(this, arguments);
    };
  } catch (_) {}

  // --- 3. Hook Navigation History (SPA Routing) ---
  try {
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function () {
      const res = origPushState.apply(this, arguments);
      setTimeout(function () {
        const id = getActiveConversationId();
        if (id) {
          broadcast('NAVIGATED', { id: id, timestamp: Date.now() });
        }
      }, 50);
      return res;
    };

    history.replaceState = function () {
      const res = origReplaceState.apply(this, arguments);
      setTimeout(function () {
        const id = getActiveConversationId();
        if (id) {
          broadcast('NAVIGATED', { id: id, timestamp: Date.now() });
        }
      }, 50);
      return res;
    };

    window.addEventListener('popstate', function () {
      const id = getActiveConversationId();
      if (id) {
        broadcast('NAVIGATED', { id: id, timestamp: Date.now() });
      }
    });
  } catch (_) {}
})();
