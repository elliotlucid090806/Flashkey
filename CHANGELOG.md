# Changelog

All notable changes to FlashKey are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-29

First public release.

### Added
- Expansion engine for inputs, textareas and rich editors (Lexical, ProseMirror, Quill, React and Vue forms), including iframes, `about:blank` composers and open shadow DOM. Expansion is undoable with Ctrl+Z.
- Constant-time trigger lookup (about 0.3 µs per keystroke with 10,000 snippets) and lazy loading on first focus.
- Variables: `{cursor}`, `{clipboard}`, `{date}` with formats and date maths (including business days), `{time}`, `{day}`, `{input:}`, `{choice:}`, `{tab}`.
- Quick-Picker (Ctrl+Shift+Space) and fill-in prompts in a closed Shadow DOM.
- Toolbar popup with search, copy or insert, quick add, pause per site, and backup.
- FlashKey Studio: folders, tags, pins, sorting, bulk actions, a live "Try it" box, rich-text snippets and five rolling safety snapshots.
- Import from JSON (FlashKey, Text Blaze, Magical, ProKeys, Auto Text Expander), CSV/TSV with a column mapper, and AutoHotKey. Export to JSON, CSV and AutoHotKey.
- Guardrails for password, one-time-code and payment fields, and a per-site blocklist with wildcards.
- Light, Dark and System themes.

[1.0.0]: https://github.com/elliotlucid090806/Flashkey/commits/main
