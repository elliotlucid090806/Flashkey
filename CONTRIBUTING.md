# Contributing to FlashKey

Thanks for your interest! Bug reports, ideas and pull requests are all welcome.

## Ground rules

FlashKey's promise is **fast, private and quiet**, so every change has to keep it:

- **No network requests.** No analytics, telemetry, remote config or CDNs.
- **No new permissions** without a very good reason, explained in the pull request.
- **No runtime dependencies.** The `flashkey/` folder is plain JavaScript with no build step.
- **Stay invisible.** No floating buttons, and no scroll, touch, wheel or mouse-move listeners on web pages. Nothing should load until a text field is focused.
- **Never touch sensitive fields** such as passwords, one-time codes or card numbers.

## Getting set up

```bash
git clone https://github.com/elliotlucid090806/Flashkey.git
cd Flashkey
npm install
npx playwright install chromium
```

Load the `flashkey/` folder at `chrome://extensions` (with **Developer mode** on, then **Load unpacked**). After changing a file, click the reload icon on the FlashKey card and refresh the page you're testing on.

## Tests

```bash
npm test           # unit tests (node:test), about 1 second
npm run test:e2e   # the real extension in headless Chromium, about 30 seconds
npm run package    # builds dist/flashkey-v<version>.zip and checks the manifest
```

The end-to-end suite types into pages built with the real Lexical, ProseMirror, Quill and React libraries. If you fix a bug on a specific site, please add a fixture to `tests/fixtures/` that reproduces how that site's editor behaves, plus a test in `tests/e2e/extension.test.js`.

## Code style

- Two-space indentation, LF line endings and semicolons (see `.editorconfig`).
- Shared modules in `flashkey/shared/` use the UMD pattern, so the same file works in the service worker, extension pages, content scripts and Node tests.
- Keep the keystroke path allocation-free and synchronous. Anything slow belongs after a trigger has matched.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep the change focused, and add or update tests.
3. Make sure `npm test` and `npm run test:e2e` pass. CI runs both.
4. Describe what changed and how you tested it.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
