/* Tells the expansion engine (content.js, loaded below) to run only inside the Studio's
   "Try it" boxes, and to include the snippet currently being edited — saved or not. */
window.FLASHKEY_SANDBOX = {
  scope: '[data-flashkey-sandbox]',
  draft: () => (window.FlashKeyStudioDraft ? window.FlashKeyStudioDraft() : null)
};
