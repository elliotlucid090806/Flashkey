# Security Policy

FlashKey runs on every page you type in, so security matters more than features. Thanks for helping keep it safe.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | ✅ |

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:

1. **Preferred:** [open a private security advisory](https://github.com/adultgamer123/Flashkey/security/advisories/new) on GitHub.
2. **Or email** legendsidleon1@gmail.com with the subject line `FlashKey security`.

Please include the browser version, the website (if one is involved) and the steps to reproduce. You'll get a reply within 72 hours. Fixes for confirmed issues ship as soon as possible, and you'll be credited in the release notes unless you'd rather not be.

## What counts

Anything that lets a web page, another extension or a crafted snippet:

- read the snippet library, or anything the user typed, from a web page
- run script in an extension page (popup, Studio or offscreen document)
- make FlashKey type into a password, one-time-code or payment field
- slip past the HTML sanitiser in rich-text snippets or imports
- cause FlashKey to send data anywhere

## How FlashKey is built to stay safe

- **No network access.** No servers, analytics, remote code or `fetch` calls. Extension pages run under a strict Content Security Policy (`script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`).
- **Minimal permissions.** No `webRequest`, `cookies`, `scripting`, `tabs` or `history`. Clipboard access is optional and requested only when `{clipboard}` is first used.
- **Isolated UI.** On-page UI lives in a closed Shadow DOM and is built with DOM APIs, never `innerHTML`, from page-controlled data.
- **Sanitised rich text.** Rich snippets and imported HTML go through an allow-list sanitiser (no scripts, event handlers, `javascript:` URLs, styles or iframes).
- **Sensitive fields skipped.** Password, one-time-code, payment-card and similar fields are never read or written.
- **No runtime dependencies.** The shipped extension is plain JavaScript. npm packages are used only by the test suite and never ship.
