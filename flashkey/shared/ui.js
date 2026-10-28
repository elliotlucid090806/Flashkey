/* FlashKey — small helpers shared by the popup and the Studio (extension pages only). */
(function (root) {
  'use strict';
  const FK = (root.FlashKey = root.FlashKey || {});

  const ICONS = {
    bolt: '<path d="M13.5 2 4.5 13.6h6.1L9.4 22l9.1-11.7h-6.2z" fill="currentColor" stroke="none"/>',
    download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>',
    upload: '<path d="M12 20V9m0 0-4.5 4.5M12 9l4.5 4.5M5 5h14"/>',
    open: '<path d="M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2m0 15v2m9.5-9.5h-2m-15 0h-2m15.2-6.7-1.4 1.4M6.7 17.3l-1.4 1.4m0-13.4 1.4 1.4m10.6 10.6 1.4 1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    system: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16.5V20"/>',
    copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
    edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
    pin: '<path d="M9 4h6l-1 6 3 3v1H7v-1l3-3-1-6zM12 14v6"/>',
    folder: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.1 6.1a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/>',
    list: '<path d="M8.5 6.5h11m-11 5.5h11m-11 5.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/><path d="M12 8v4.5l3 2"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6m0 13.2v2.6M2.8 12h2.6m13.2 0h2.6M5.5 5.5l1.8 1.8m9.4 9.4 1.8 1.8m0-13-1.8 1.8m-9.4 9.4-1.8 1.8"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8.1 7.5 9.5 4.3-1.4 7.5-5 7.5-9.5V6z"/>'
  };

  function icon(name, cls) {
    const body = ICONS[name] || '';
    return `<svg class="${cls || 'icon'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'system';
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  let toastTimer = 0;
  function toast(message, action) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: 'toast', role: 'status' }, message);
    if (action) t.appendChild(h('button', { type: 'button', onclick: () => { t.remove(); action.run(); } }, action.label));
    document.body.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), action ? 6000 : 2200);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function debounce(fn, ms) {
    let t = 0;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function oneLine(s, n) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return n && t.length > n ? t.slice(0, n - 1) + '…' : t;
  }

  function timeAgo(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    const d = Math.round(s / 86400);
    return d === 1 ? 'yesterday' : d + ' days ago';
  }

  /** Text expansion saves time: ~40 wpm ≈ 200 characters per minute. */
  function timeSaved(chars) {
    const min = (chars || 0) / 200;
    if (min < 1) return Math.round(min * 60) + ' s';
    if (min < 90) return Math.round(min) + ' min';
    return (min / 60).toFixed(1) + ' h';
  }

  async function exportBackup(store) {
    const data = await store.exportBackup();
    download(FK.formats.backupFilename('json'), JSON.stringify(data, null, 2), 'application/json');
    await store.markBackedUp();
    return data.snippets.length;
  }

  FK.ui = { ICONS, icon, applyTheme, h, toast, download, debounce, oneLine, timeAgo, timeSaved, exportBackup };
})(typeof globalThis !== 'undefined' ? globalThis : this);
