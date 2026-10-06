/**
 * Gemini Conversation Timestamps - Content Script
 * Manages hybrid storage (chrome.storage.sync & chrome.storage.local),
 * live multi-device account sync, and lightweight hover tooltip display.
 */
(function () {
  'use strict';

  // Prevent multiple injections
  if (window.__gct_content_loaded) return;
  window.__gct_content_loaded = true;

  // In-memory timestamp cache: { [normId]: { created: ms, edited: ms } }
  const cache = Object.create(null);

  // Constants
  const SYNC_CHUNK_SIZE = 120; // Items per sync chunk (~4KB, well below 8KB quota)
  const MAX_SYNC_CHUNKS = 10;  // Up to 1,200 conversations in sync storage
  const WRITE_DEBOUNCE_MS = 1000;

  // DOM Elements for Singleton Tooltip
  let tooltipEl = null;
  let rowCreatedEl = null;
  let rowEditedEl = null;
  let currentTargetEl = null;
  let activeHoverId = null;
  let hoverTimer = null;
  let saveTimer = null;
  let newChatStartTime = null;

  /**
   * Helper to normalize conversation ID (strip 'c_' prefix)
   */
  function normalizeId(id) {
    if (!id || typeof id !== 'string') return '';
    return id.startsWith('c_') ? id.slice(2) : id;
  }

  /**
   * Format epoch timestamp to: "HH:mm DD/MM/YY"
   * Example: "02:30 07/10/26"
   */
  function formatDateTime(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') return '-';
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '-';

    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const YY = String(d.getFullYear() % 100).padStart(2, '0');

    return `${HH}:${mm} ${DD}/${MM}/${YY}`;
  }

  /**
   * Merge a single timestamp record into cache
   */
  function mergeSingle(rawId, created, edited) {
    const id = normalizeId(rawId);
    if (!id || typeof created !== 'number' || typeof edited !== 'number') return false;

    // Filter out obvious invalid numbers
    if (created < 1672531200000 || edited < 1672531200000) return false;

    const existing = cache[id];
    if (!existing) {
      cache[id] = { created, edited };
      return true;
    } else {
      let changed = false;
      const minCreated = Math.min(existing.created, created);
      const maxEdited = Math.max(existing.edited, edited);
      if (minCreated !== existing.created) {
        existing.created = minCreated;
        changed = true;
      }
      if (maxEdited !== existing.edited) {
        existing.edited = maxEdited;
        changed = true;
      }
      return changed;
    }
  }

  /**
   * Merge array of timestamp items
   */
  function mergeItems(items) {
    if (!Array.isArray(items)) return;
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.id && it.created && it.edited) {
        if (mergeSingle(it.id, it.created, it.edited)) {
          changed = true;
        }
      }
    }
    if (changed) {
      scheduleSave();
      // If currently hovering an updated conversation, update tooltip immediately
      if (activeHoverId && cache[activeHoverId]) {
        updateTooltipContent(cache[activeHoverId]);
      }
    }
  }

  /**
   * Debounced save to both chrome.storage.sync and chrome.storage.local
   */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveToStorage, WRITE_DEBOUNCE_MS);
  }

  async function saveToStorage() {
    const ids = Object.keys(cache);
    if (ids.length === 0) return;

    // 1. Mirror everything into chrome.storage.local (unlimited local space)
    const localData = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      localData[id] = {
        c: Math.floor(cache[id].created / 1000),
        e: Math.floor(cache[id].edited / 1000),
      };
    }

    try {
      if (chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ gct_conversations: localData });
      }
    } catch (_) {}

    // 2. Prioritize and chunk data for chrome.storage.sync (auto-sync with Google account)
    if (!chrome.storage || !chrome.storage.sync) return;

    try {
      // Sort IDs by edited time descending (most recently active conversations synced first)
      ids.sort((a, b) => cache[b].edited - cache[a].edited);

      const totalChunks = Math.min(MAX_SYNC_CHUNKS, Math.ceil(ids.length / SYNC_CHUNK_SIZE));
      const syncPayload = {
        gct_meta: {
          v: 1,
          chunks: totalChunks,
          count: ids.length,
          updatedAt: Date.now(),
        },
      };

      for (let c = 0; c < totalChunks; c++) {
        const chunkObj = {};
        const slice = ids.slice(c * SYNC_CHUNK_SIZE, (c + 1) * SYNC_CHUNK_SIZE);
        for (let j = 0; j < slice.length; j++) {
          const id = slice[j];
          chunkObj[id] = [
            Math.floor(cache[id].created / 1000),
            Math.floor(cache[id].edited / 1000),
          ];
        }
        syncPayload[`gct_c_${c}`] = chunkObj;
      }

      await chrome.storage.sync.set(syncPayload);
    } catch (_) {
      // If sync quota or error occurs, local storage retains full copy safely
    }
  }

  /**
   * Load stored timestamps from chrome.storage.sync and local fallback
   */
  async function loadStorage() {
    // 1. Load from chrome.storage.sync (auto-synced from Google account)
    try {
      if (chrome.storage && chrome.storage.sync) {
        const syncData = await chrome.storage.sync.get(null);
        if (syncData && syncData.gct_meta) {
          const totalChunks = syncData.gct_meta.chunks || 0;
          for (let c = 0; c < totalChunks; c++) {
            const chunk = syncData[`gct_c_${c}`];
            if (chunk && typeof chunk === 'object') {
              for (const [id, times] of Object.entries(chunk)) {
                if (Array.isArray(times) && times.length >= 2) {
                  mergeSingle(id, times[0] * 1000, times[1] * 1000);
                }
              }
            }
          }
        }
      }
    } catch (_) {}

    // 2. Load from chrome.storage.local to pick up any offline/cached entries
    try {
      if (chrome.storage && chrome.storage.local) {
        const localRes = await chrome.storage.local.get(['gct_conversations']);
        if (localRes && localRes.gct_conversations) {
          for (const [id, val] of Object.entries(localRes.gct_conversations)) {
            if (val && typeof val.c === 'number' && typeof val.e === 'number') {
              mergeSingle(id, val.c * 1000, val.e * 1000);
            }
          }
        }
      }
    } catch (_) {}
  }

  /**
   * Listen for remote sync changes from other PCs/laptops
   */
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName === 'sync') {
        let updated = false;
        for (const key of Object.keys(changes)) {
          if (key.startsWith('gct_c_') && changes[key].newValue) {
            const chunk = changes[key].newValue;
            for (const [id, times] of Object.entries(chunk)) {
              if (Array.isArray(times) && times.length >= 2) {
                if (mergeSingle(id, times[0] * 1000, times[1] * 1000)) {
                  updated = true;
                }
              }
            }
          }
        }
        if (updated && activeHoverId && cache[activeHoverId]) {
          updateTooltipContent(cache[activeHoverId]);
        }
      }
    });
  }

  /**
   * Initialize Tooltip DOM (Singleton, safe DOM manipulation)
   */
  function ensureTooltip() {
    if (tooltipEl && document.body && document.body.contains(tooltipEl)) return;

    tooltipEl = document.createElement('div');
    tooltipEl.id = 'gct-tooltip-container';
    tooltipEl.className = 'gct-tooltip';
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

  /**
   * Update tooltip text content safely (XSS-safe textContent)
   */
  function updateTooltipContent(info) {
    if (!rowCreatedEl || !rowEditedEl) return;
    if (info) {
      rowCreatedEl.textContent = `dibuat: ${formatDateTime(info.created)}`;
      rowEditedEl.textContent = `diedit: ${formatDateTime(info.edited)}`;
    } else {
      rowCreatedEl.textContent = 'dibuat: memuat...';
      rowEditedEl.textContent = 'diedit: memuat...';
    }
  }

  /**
   * Position tooltip neatly to the right of the conversation sidebar item
   */
  function positionTooltip(targetEl) {
    if (!tooltipEl || !targetEl) return;

    const rect = targetEl.getBoundingClientRect();
    const tRect = tooltipEl.getBoundingClientRect();

    // Center vertically relative to target item
    let top = rect.top + rect.height / 2 - tRect.height / 2;
    let left = rect.right + 10;

    // Viewport overflow bounds:
    // If placing to the right overflows the window, place to the left
    if (left + tRect.width > window.innerWidth - 8) {
      left = rect.left - tRect.width - 10;
    }

    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (top + tRect.height > window.innerHeight - 8) {
      top = window.innerHeight - tRect.height - 8;
    }

    tooltipEl.style.top = `${Math.round(top)}px`;
    tooltipEl.style.left = `${Math.round(left)}px`;
  }

  /**
   * Extract conversation ID from a DOM element or its attributes
   */
  function extractConversationId(el) {
    if (!el) return null;

    // Check if element is an anchor or has child anchor with /app/
    const a = el.tagName && el.tagName.toLowerCase() === 'a' ? el : el.querySelector('a[href*="/app/"]');
    if (a) {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return normalizeId(match[1]);
    }

    // Check dataset or attributes
    const attrId = el.getAttribute('data-conversation-id') || el.getAttribute('data-id');
    if (attrId) return normalizeId(attrId);

    // Check ancestor
    const parentA = el.closest('a[href*="/app/"]');
    if (parentA) {
      const href = parentA.getAttribute('href') || '';
      const match = href.match(/\/app\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) return normalizeId(match[1]);
    }

    return null;
  }

  /**
   * Show tooltip for element
   */
  function showTooltipForElement(el) {
    ensureTooltip();
    const id = extractConversationId(el);
    if (!id) {
      hideTooltip();
      return;
    }

    activeHoverId = id;
    const info = cache[id];
    updateTooltipContent(info);

    positionTooltip(el);
    tooltipEl.classList.add('gct-show');
    tooltipEl.setAttribute('aria-hidden', 'false');
  }

  /**
   * Hide tooltip
   */
  function hideTooltip() {
    clearTimeout(hoverTimer);
    currentTargetEl = null;
    activeHoverId = null;
    if (tooltipEl) {
      tooltipEl.classList.remove('gct-show');
      tooltipEl.setAttribute('aria-hidden', 'true');
    }
  }

  /**
   * Event Delegation for Mouseover / Mouseout
   * Super lightweight: 1 single event listener on document instead of hundreds
   */
  function setupHoverListeners() {
    document.addEventListener(
      'mouseover',
      function (e) {
        const target = e.target;
        if (!target || !target.closest) return;

        // Target conversation links or items in sidebar
        const convEl = target.closest('a[href*="/app/"], [data-test-id="conversation"]');
        if (!convEl) {
          if (currentTargetEl && !currentTargetEl.contains(target)) {
            hideTooltip();
          }
          return;
        }

        if (convEl === currentTargetEl) return;

        currentTargetEl = convEl;
        clearTimeout(hoverTimer);

        // 60ms debounce for smooth hovering feel
        hoverTimer = setTimeout(function () {
          if (currentTargetEl === convEl) {
            showTooltipForElement(convEl);
          }
        }, 60);
      },
      { passive: true }
    );

    document.addEventListener(
      'mouseout',
      function (e) {
        if (!currentTargetEl) return;
        const related = e.relatedTarget;
        if (!related || !currentTargetEl.contains(related)) {
          hideTooltip();
        }
      },
      { passive: true }
    );
  }

  /**
   * Get active conversation ID from URL
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
   * Record active interaction in current conversation
   */
  function recordInteraction(id) {
    if (!id) return;
    const now = Date.now();
    const existing = cache[id];
    if (existing) {
      existing.edited = Math.max(existing.edited, now);
    } else {
      cache[id] = { created: now, edited: now };
    }
    scheduleSave();
  }

  /**
   * Track user sending prompt / pressing Enter to update 'diedit' live
   */
  function setupInteractionListeners() {
    document.addEventListener(
      'keydown',
      function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          const id = getActiveConversationId();
          if (id) {
            recordInteraction(id);
          } else {
            // New conversation starting
            newChatStartTime = Date.now();
          }
        }
      },
      { passive: true }
    );

    document.addEventListener(
      'click',
      function (e) {
        const target = e.target;
        if (!target || !target.closest) return;
        const sendBtn = target.closest(
          'button[aria-label*="Send"], button[aria-label*="Kirim"], button.send-button, .send-button-container'
        );
        if (sendBtn) {
          const id = getActiveConversationId();
          if (id) {
            recordInteraction(id);
          } else {
            newChatStartTime = Date.now();
          }
        }
      },
      { passive: true }
    );
  }

  /**
   * Listen for messages from network interceptor (MAIN world)
   */
  function setupMessageReceiver() {
    window.addEventListener('message', function (event) {
      // Strict origin and source validation
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      if (!event.data || typeof event.data !== 'object') return;
      if (event.data.source !== 'gemini-timestamp-interceptor') return;

      const { type, payload } = event.data;

      if (type === 'TIMESTAMPS_FOUND' && Array.isArray(payload)) {
        mergeItems(payload);
      } else if (type === 'ACTIVE_INTERACTION' && payload && payload.id) {
        recordInteraction(payload.id);
      } else if (type === 'NAVIGATED' && payload && payload.id) {
        const id = normalizeId(payload.id);
        if (newChatStartTime) {
          // Associate new chat creation time
          mergeSingle(id, newChatStartTime, Date.now());
          newChatStartTime = null;
          scheduleSave();
        }
      }
    });
  }

  // --- Initialize Extension ---
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
