/* FlashKey — offscreen document: reads clipboard text for {clipboard}. Never writes, never networks. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen' || msg.type !== 'fk:offscreen-read') return;
  const sink = document.getElementById('sink');
  sink.value = '';
  sink.focus();
  let ok = false;
  try { ok = document.execCommand('paste'); } catch (_) { ok = false; }
  const text = sink.value;
  sink.value = '';
  sendResponse({ ok, text });
});
