/**
 * Gemini Conversation Timestamps - Popup Script
 * Reads storage to show total synced conversations
 */
document.addEventListener('DOMContentLoaded', async function () {
  const countEl = document.getElementById('count-value');

  try {
    let totalCount = 0;

    // Check local storage master record
    if (chrome.storage && chrome.storage.local) {
      const res = await chrome.storage.local.get(['gct_conversations']);
      if (res && res.gct_conversations) {
        totalCount = Object.keys(res.gct_conversations).length;
      }
    }

    // Fallback check in sync meta
    if (totalCount === 0 && chrome.storage && chrome.storage.sync) {
      const syncRes = await chrome.storage.sync.get(['gct_meta']);
      if (syncRes && syncRes.gct_meta && syncRes.gct_meta.count) {
        totalCount = syncRes.gct_meta.count;
      }
    }

    if (countEl) {
      countEl.textContent = `${totalCount} percakapan`;
    }
  } catch (_) {
    if (countEl) {
      countEl.textContent = '0 percakapan';
    }
  }
});
