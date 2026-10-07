/**
 * Gemini Conversation Timestamps - Content Script (v2)
 * Manages hybrid storage, multi-device sync, and hover tooltip.
 *
 * KEY CHANGES v2  ─────────────────────────────────────────────────────────
 *
 * 1. LOCAL OVERRIDE (Approach 1 – highest priority):
 *    Each cache entry gains a `lvc` flag (locally-verified created).
 *      lvc = true  → `created` was recorded via a local user action
 *                    (Enter key / Send button in a new conversation).
 *                    Server data can NEVER overwrite this value.
 *      lvc = false → `created` is a server-side estimate; can still be
 *                    refined by a later, more-accurate server value.
 *
 *    When the user sends the very first message in a brand-new conversation,
 *    `pendingNewConvTime = Date.now()` is captured immediately.  When the
 *    SPA navigation fires and the new conversation URL appears, that time
 *    is stored as `created` with `lvc = true`.
 *
 * 2. SOURCE-AWARE MERGE (Approach 2 side-effect):
 *    Items arriving from the interceptor carry a `source` field:
 *      'sidebar'      → only has `edited`; never touches `created`.
 *      'conversation' → has both; treated as server estimate (lvc = false),
 *                       so existing lvc=true entries are protected.
 *
 * 3. STORAGE FORMAT v2:
 *    Local:  { c, e, f }   where f = flags bitmask, bit-0 = lvc
 *    Sync:   [c_s, e_s, f]  (backward-compatible – old [c, e] entries read as f=0)
 *
 * HOW STALE DATA IS OVERWRITTEN
 *    Old entries (imported from v1 storage) load with lvc = 0 (false).
 *    The first time the user sends a message in such a conversation,
 *    `recordInteraction()` sets lvc = true and updates `edited = now`.
 *    From that point, the entry is locally-verified and server data can no
 *    longer corrupt `created`.  Cross-device sync propagates the lvc flag,
 *    so the correction automatically applies to all other devices too.
 */
(function () {
  'use strict';

  if (window.__gct_content_loaded) return;
  window.__gct_content_loaded = true;

  /**
   * In-memory cache.
   * Shape: { [normId]: { created: ms, edited: ms, lvc: boolean } }
   */
  const cache = Object.create(null);

  /* ─────────────── constants ─────────────── */
  const SYNC_CHUNK_SIZE  = 120;   // items per sync chunk  (~4 KB each, quota = 8 KB)
  const MAX_SYNC_CHUNKS  = 10;    // max 1,200 conversations in sync storage
  const WRITE_DEBOUNCE   = 1000;  // ms to wait before flushing to storage
  const MIN_EPOCH_MS     = 1672531200000; // Jan 1 2023 – reject anything older

  /* ─────────────── DOM / state refs ──────── */
  let tooltipEl       = null;
  let rowCreatedEl    = null;
  let rowEditedEl     = null;
  let currentTargetEl = null;
  let activeHoverId   = null;
  let hoverTimer      = null;
  let saveTimer       = null;

  /**
   * Time captured the instant the user presses Enter / Send in a conversation
   * that has no URL-based ID yet (/app/new or blank).
   * Used as `created` (with lvc=true) when the new conversation URL appears.
   */
  let pendingNewConvTime = null;

  /* ═══════════════════════════════════════════════════════════════════════
     UTILITY
  ═══════════════════════════════════════════════════════════════════════ */

  function normalizeId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.startsWith('c_') ? id.slice(2) : id;
  }

  /** Format epoch ms → "HH:mm DD/MM/YY"  (e.g. "02:30 07/10/26") */
  function formatDateTime(ts) {
    if (!ts || typeof ts !== 'number') return '-';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '-';
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const YY = String(d.getFullYear() % 100).padStart(2, '0');
    return `${HH}:${mm} ${DD}/${MM}/${YY}`;
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

  /* ═══════════════════════════════════════════════════════════════════════
     CACHE MERGE  ─  the core of the accuracy fix
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Merge one timestamp record into the in-memory cache.
   *
   * Priority rules for `created`:
   *   • incoming lvc=true  AND existing lvc=false  → incoming wins (local > server)
   *   • existing lvc=true  AND incoming lvc=false  → existing protected, ignore incoming created
   *   • both lvc=false                             → take Math.min (earlier server estimate wins)
   *   • both lvc=true                              → take Math.min (shouldn't normally occur)
   *   • incoming created === null                  → never touch existing created (sidebar path)
   *
   * Priority rule for `edited`:
   *   Always Math.max (most recent activity wins, regardless of source).
   *
   * @param {string}       rawId   – conversation ID (may have 'c_' prefix)
   * @param {number|null}  created – ms timestamp or null (= "don't update created")
   * @param {number}       edited  – ms timestamp
   * @param {boolean}      lvc     – true if `created` is locally-verified
   * @returns {boolean} true if the cache entry was modified
   */
  function mergeSingle(rawId, created, edited, lvc) {
    const id = normalizeId(rawId);
    if (!id || typeof edited !== 'number' || edited < MIN_EPOCH_MS) return false;

    // Reject implausible created values
    if (created !== null && (typeof created !== 'number' || created < MIN_EPOCH_MS)) {
      created = null;
    }

    const ex = cache[id];

    /* ── Brand-new entry ── */
    if (!ex) {
      cache[id] = {
        created : created !== null ? created : edited, // fallback created = edited
        edited,
        lvc     : Boolean(lvc),
      };
      return true;
    }

    let changed = false;

    /* ── Merge created ── */
    if (created !== null) {
      if (lvc && !ex.lvc) {
        // Local beats server: unconditionally set new created + upgrade flag
        if (created !== ex.created) { ex.created = created; changed = true; }
        ex.lvc = true; changed = true;
      } else if (!ex.lvc) {
        // Both are server estimates: take the earlier one
        if (created < ex.created) { ex.created = created; changed = true; }
      }
      // else: ex.lvc = true → existing lvc-created is protected from any server data
    } else if (lvc && !ex.lvc) {
      // null created but caller is marking this entry as locally-verified
      // (e.g., user sent a follow-up in an existing conversation)
      ex.lvc = true; changed = true;
    }

    /* ── Merge edited (always max) ── */
    if (edited > ex.edited) { ex.edited = edited; changed = true; }

    return changed;
  }

  /**
   * Merge an array of items received from the network interceptor.
   * Applies source-specific rules before calling mergeSingle.
   */
  function mergeItems(items) {
    if (!Array.isArray(items)) return;
    let changed = false;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.id) continue;

      const source = it.source || 'general';

      if (source === 'sidebar') {
        /*
         * Sidebar only reliably carries last-activity time (edited).
         * Pass created=null so mergeSingle never overwrites `created`.
         */
        if (typeof it.edited === 'number') {
          if (mergeSingle(it.id, null, it.edited, false)) changed = true;
        }

      } else if (source === 'conversation') {
        /*
         * Individual conversation response: first-message ts = created,
         * last-message ts = edited.  Server data → lvc=false.
         * Existing lvc=true entries are protected by mergeSingle.
         */
        const c = typeof it.created === 'number' ? it.created : null;
        const e = typeof it.edited  === 'number' ? it.edited  : c;
        if (e !== null) {
          if (mergeSingle(it.id, c, e, false)) changed = true;
        }

      } else {
        // 'general' or unknown: normal server-estimate merge
        const c = typeof it.created === 'number' ? it.created : null;
        const e = typeof it.edited  === 'number' ? it.edited  : c;
        if (e !== null) {
          if (mergeSingle(it.id, c, e, false)) changed = true;
        }
      }
    }

    if (changed) {
      scheduleSave();
      if (activeHoverId && cache[activeHoverId]) {
        updateTooltipContent(cache[activeHoverId]);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     LOCAL INTERACTION RECORDING
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Record that the local user has interacted with a conversation.
   *
   * Called from:
   *   • keydown Enter  (local user action – sets lvc)
   *   • click Send btn (local user action – sets lvc)
   *   NEVER called from network/ACTIVE_INTERACTION (that path only updates edited).
   *
   * Behavior:
   *   • New entry  → created = pendingNewConvTime || now,  lvc = true
   *   • Existing   → edited = max(existing, now),           lvc = true
   *                  (created is NOT changed – we don't know if this is the first msg)
   */
  function recordLocalInteraction(id) {
    if (!id) return;
    const now = Date.now();
    const ex  = cache[id];

    if (!ex) {
      const created = pendingNewConvTime && pendingNewConvTime <= now
        ? pendingNewConvTime
        : now;
      cache[id] = { created, edited: now, lvc: true };
      pendingNewConvTime = null;
    } else {
      if (now > ex.edited) ex.edited = now;
      ex.lvc = true; // Upgrade: local interaction verifies the entry
    }

    scheduleSave();
  }

  /**
   * A network call happened for the current conversation (not user-initiated).
   * Only updates `edited` if the network timestamp is more recent.
   * Does NOT set lvc – only local keydown/click can do that.
   */
  function recordNetworkActivity(id, ts) {
    if (!id || typeof ts !== 'number') return;
    const ex = cache[id];
    if (ex) {
      if (ts > ex.edited) { ex.edited = ts; scheduleSave(); }
    } else {
      // First sight of this conversation – create a tentative entry (lvc=false)
      cache[id] = { created: ts, edited: ts, lvc: false };
      scheduleSave();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     STORAGE  (hybrid: local + sync)
  ═══════════════════════════════════════════════════════════════════════ */

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToStorage, WRITE_DEBOUNCE);
  }

  async function saveToStorage() {
    const ids = Object.keys(cache);
    if (ids.length === 0) return;

    /* 1 ── chrome.storage.local  (unlimited, offline-safe) ── */
    const localData = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const en = cache[id];
      localData[id] = {
        c: Math.floor(en.created / 1000),
        e: Math.floor(en.edited  / 1000),
        f: en.lvc ? 1 : 0, // flags bitmask: bit-0 = lvc
      };
    }
    try {
      if (chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ gct_conversations: localData });
      }
    } catch (_) {}

    /* 2 ── chrome.storage.sync  (auto-synced via Google account) ── */
    if (!chrome.storage || !chrome.storage.sync) return;
    try {
      // Sort newest-active first so most-relevant conversations fill early chunks
      ids.sort((a, b) => cache[b].edited - cache[a].edited);

      const totalChunks = Math.min(MAX_SYNC_CHUNKS, Math.ceil(ids.length / SYNC_CHUNK_SIZE));
      const payload = {
        gct_meta: {
          v      : 2,            // storage format version
          chunks : totalChunks,
          count  : ids.length,
          updatedAt: Date.now(),
        },
      };

      for (let c = 0; c < totalChunks; c++) {
        const chunk = {};
        const slice = ids.slice(c * SYNC_CHUNK_SIZE, (c + 1) * SYNC_CHUNK_SIZE);
        for (let j = 0; j < slice.length; j++) {
          const id = slice[j];
          const en = cache[id];
          // Format: [created_s, edited_s, flags]
          chunk[id] = [
            Math.floor(en.created / 1000),
            Math.floor(en.edited  / 1000),
            en.lvc ? 1 : 0,
          ];
        }
        payload[`gct_c_${c}`] = chunk;
      }

      await chrome.storage.sync.set(payload);
    } catch (_) {
      // Sync quota / error: local storage retains the full copy safely
    }
  }

  async function loadStorage() {
    /* 1 ── Load from sync first (most authoritative – cross-device) ── */
    try {
      if (chrome.storage && chrome.storage.sync) {
        const data = await chrome.storage.sync.get(null);
        if (data && data.gct_meta) {
          const chunks = data.gct_meta.chunks || 0;
          for (let c = 0; c < chunks; c++) {
            const chunk = data[`gct_c_${c}`];
            if (chunk && typeof chunk === 'object') {
              for (const [id, times] of Object.entries(chunk)) {
                if (Array.isArray(times) && times.length >= 2) {
                  const lvc = times.length >= 3 && times[2] === 1;
                  mergeSingle(id, times[0] * 1000, times[1] * 1000, lvc);
                }
              }
            }
          }
        }
      }
    } catch (_) {}

    /* 2 ── Supplement from local (picks up offline-only entries) ── */
    try {
      if (chrome.storage && chrome.storage.local) {
        const res = await chrome.storage.local.get(['gct_conversations']);
        if (res && res.gct_conversations) {
          for (const [id, val] of Object.entries(res.gct_conversations)) {
            if (val && typeof val.c === 'number' && typeof val.e === 'number') {
              const lvc = val.f === 1;
              mergeSingle(id, val.c * 1000, val.e * 1000, lvc);
            }
          }
        }
      }
    } catch (_) {}
  }

  /* Live sync-change listener (other devices pushing updates) */
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync') return;
      let updated = false;
      for (const key of Object.keys(changes)) {
        if (!key.startsWith('gct_c_')) continue;
        const chunk = changes[key].newValue;
        if (!chunk || typeof chunk !== 'object') continue;
        for (const [id, times] of Object.entries(chunk)) {
          if (Array.isArray(times) && times.length >= 2) {
            const lvc = times.length >= 3 && times[2] === 1;
            if (mergeSingle(id, times[0] * 1000, times[1] * 1000, lvc)) updated = true;
          }
        }
      }
      if (updated && activeHoverId && cache[activeHoverId]) {
        updateTooltipContent(cache[activeHoverId]);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     TOOLTIP  (singleton DOM element, XSS-safe via textContent only)
  ═══════════════════════════════════════════════════════════════════════ */

  function ensureTooltip() {
    if (tooltipEl && document.body && document.body.contains(tooltipEl)) return;

    tooltipEl = document.createElement('div');
    tooltipEl.id = 'gct-tooltip-container';
    tooltipEl.setAttribute('role', 'tooltip');
    tooltipEl.setAttribute('aria-hidden', 'true');

    rowCreatedEl = document.createElement('div');
    rowCreatedEl.className = 'gct-row gct-row-created';
    rowCreatedEl.textContent = 'dibuat: -';

    rowEditedEl = document.createElement('div');
    rowEditedEl.className = 'gct-row gct-row-edited';
    rowEditedEl.textContent = 'diedit: -';

    tooltipEl.appendChild(rowCreatedEl);
    tooltipEl.appendChild(rowEditedEl);

    const root = document.body || document.documentElement;
    if (root) root.appendChild(tooltipEl);
  }

  /** All tooltip text set via textContent → immune to XSS injection. */
  function updateTooltipContent(info) {
    if (!rowCreatedEl || !rowEditedEl) return;
    if (info) {
      rowCreatedEl.textContent = `dibuat: ${formatDateTime(info.created)}`;
      rowEditedEl.textContent  = `diedit: ${formatDateTime(info.edited)}`;
    } else {
      rowCreatedEl.textContent = 'dibuat: memuat...';
      rowEditedEl.textContent  = 'diedit: memuat...';
    }
  }

  function positionTooltip(targetEl) {
    if (!tooltipEl || !targetEl) return;
    const rect  = targetEl.getBoundingClientRect();
    const tRect = tooltipEl.getBoundingClientRect();

    let top  = rect.top  + rect.height  / 2 - tRect.height / 2;
    let left = rect.right + 10;

    if (left + tRect.width > window.innerWidth - 8) left = rect.left - tRect.width - 10;
    if (left < 8)  left = 8;
    if (top  < 8)  top  = 8;
    if (top  + tRect.height > window.innerHeight - 8) top = window.innerHeight - tRect.height - 8;

    tooltipEl.style.top  = `${Math.round(top)}px`;
    tooltipEl.style.left = `${Math.round(left)}px`;
  }

  function extractConversationId(el) {
    if (!el) return null;
    const a = (el.tagName && el.tagName.toLowerCase() === 'a')
      ? el
      : el.querySelector('a[href*="/app/"]');
    if (a) {
      const m = (a.getAttribute('href') || '').match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (m && m[1]) return normalizeId(m[1]);
    }
    const attrId = el.getAttribute('data-conversation-id') || el.getAttribute('data-id');
    if (attrId) return normalizeId(attrId);
    const pA = el.closest('a[href*="/app/"]');
    if (pA) {
      const m = (pA.getAttribute('href') || '').match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (m && m[1]) return normalizeId(m[1]);
    }
    return null;
  }

  function showTooltipForElement(el) {
    ensureTooltip();
    const id = extractConversationId(el);
    if (!id) { hideTooltip(); return; }
    activeHoverId = id;
    updateTooltipContent(cache[id] || null);
    positionTooltip(el);
    tooltipEl.classList.add('gct-show');
    tooltipEl.setAttribute('aria-hidden', 'false');
  }

  function hideTooltip() {
    clearTimeout(hoverTimer);
    currentTargetEl = null;
    activeHoverId   = null;
    if (tooltipEl) {
      tooltipEl.classList.remove('gct-show');
      tooltipEl.setAttribute('aria-hidden', 'true');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     EVENT LISTENERS
  ═══════════════════════════════════════════════════════════════════════ */

  /** Single delegated mouseover/mouseout for the entire page – O(1) listeners. */
  function setupHoverListeners() {
    document.addEventListener('mouseover', function (e) {
      const target = e.target;
      if (!target || !target.closest) return;
      const convEl = target.closest('a[href*="/app/"], [data-test-id="conversation"]');
      if (!convEl) {
        if (currentTargetEl && !currentTargetEl.contains(target)) hideTooltip();
        return;
      }
      if (convEl === currentTargetEl) return;
      currentTargetEl = convEl;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        if (currentTargetEl === convEl) showTooltipForElement(convEl);
      }, 60);
    }, { passive: true });

    document.addEventListener('mouseout', function (e) {
      if (!currentTargetEl) return;
      if (!e.relatedTarget || !currentTargetEl.contains(e.relatedTarget)) hideTooltip();
    }, { passive: true });
  }

  /**
   * Local user-action detection.
   * ONLY these paths can set lvc=true.
   */
  function setupInteractionListeners() {
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const id = getActiveConversationId();
      if (id) {
        recordLocalInteraction(id);
      } else {
        // New conversation: capture time before we know the conversation ID
        pendingNewConvTime = Date.now();
      }
    }, { passive: true });

    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      const btn = e.target.closest(
        'button[aria-label*="Send"], button[aria-label*="Kirim"], ' +
        'button.send-button, .send-button-container, [data-test-id="send-button"]'
      );
      if (!btn) return;
      const id = getActiveConversationId();
      if (id) {
        recordLocalInteraction(id);
      } else {
        pendingNewConvTime = Date.now();
      }
    }, { passive: true });
  }

  /**
   * Receive messages from interceptor.js (MAIN world → ISOLATED world).
   * Strict validation guards against spoofed postMessage attacks.
   */
  function setupMessageReceiver() {
    window.addEventListener('message', function (event) {
      // ── Security checks ─────────────────────────────────────────────────
      if (event.source !== window)                                 return;
      if (event.origin !== window.location.origin)                 return;
      if (!event.data || typeof event.data !== 'object')           return;
      if (event.data.source !== 'gemini-timestamp-interceptor')    return;
      // ────────────────────────────────────────────────────────────────────

      const { type, payload } = event.data;

      if (type === 'TIMESTAMPS_FOUND' && Array.isArray(payload)) {
        /*
         * Route through mergeItems which applies source-specific priority rules.
         * Sidebar items → only edited updated.
         * Conversation items → both created/edited updated (server estimate, lvc=false).
         */
        mergeItems(payload);

      } else if (type === 'ACTIVE_INTERACTION' && payload && payload.id) {
        /*
         * Network activity detected in a conversation (NOT user-triggered send).
         * Only bumps `edited` timestamp; does NOT set lvc.
         */
        recordNetworkActivity(normalizeId(payload.id), payload.timestamp || Date.now());

      } else if (type === 'NAVIGATED' && payload && payload.id) {
        /*
         * SPA navigation: a new conversation URL appeared.
         *
         * If pendingNewConvTime is set → this is a brand-new conversation the
         * user just created.  Record it with lvc=true using the pre-captured
         * time so `created` reflects when the user hit Send, not when the
         * server URL was assigned.
         */
        const id = normalizeId(payload.id);
        if (!id) return;

        if (pendingNewConvTime) {
          const pending = pendingNewConvTime;
          pendingNewConvTime = null;

          const ex = cache[id];
          if (!ex) {
            cache[id] = { created: pending, edited: Date.now(), lvc: true };
            scheduleSave();
          } else if (!ex.lvc) {
            // Entry exists but was from server estimate → upgrade with local time
            if (pending < ex.created) ex.created = pending;
            ex.lvc = true;
            scheduleSave();
          }
          // else: already lvc=true, no action needed
        }

        // Refresh tooltip if user is hovering the conversation that just navigated
        if (activeHoverId === id && cache[id]) {
          updateTooltipContent(cache[id]);
        }
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     BOOTSTRAP
  ═══════════════════════════════════════════════════════════════════════ */

  loadStorage();
  setupMessageReceiver();
  setupHoverListeners();
  setupInteractionListeners();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureTooltip);
  } else {
    ensureTooltip();
  }
})();
