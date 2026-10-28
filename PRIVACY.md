# FlashKey Privacy Policy

_Last updated: 29 October 2026_

FlashKey is a text expander that runs entirely inside your browser. This policy explains what it handles, and what it doesn't.

## The short version

**FlashKey does not collect, transmit, sell or share any data.** It has no servers, no accounts, no analytics and no error reporting, and it makes no network requests.

## What is stored, and where

Everything FlashKey stores lives in your browser's extension storage (`chrome.storage.local`) on your own computer:

- your snippets, folders and tags
- your settings, including your excluded sites
- up to five automatic safety snapshots of your library
- local usage counts (how many times each snippet was expanded), shown only to you in FlashKey Studio

This data never leaves your computer. It is removed when you uninstall FlashKey, or when you delete it yourself in FlashKey Studio (Settings → Delete all snippets).

## What FlashKey reads on web pages

To expand a trigger, FlashKey reads the few characters right before your text cursor in the field you're typing in. It does this only in that moment, only in that field, and never stores or sends what it reads.

FlashKey never reads or changes password fields, one-time-code fields, payment-card fields, or fields that look like verification, security or social-security codes. It also stays off any site you exclude.

## Permissions and why they're needed

| Permission | Used for |
|---|---|
| `storage`, `unlimitedStorage` | Keeping your snippet library on your computer, however large it gets |
| `contextMenus` | "Save selection as FlashKey snippet" and "Insert FlashKey snippet…" |
| `activeTab` | Showing the current site in the popup so you can pause FlashKey there |
| `offscreen` | Reading your clipboard for the `{clipboard}` variable, only when a snippet uses it |
| `clipboardRead` (optional) | Requested only the first time you use `{clipboard}`; you can refuse or remove it at any time |
| Access to websites | Expanding triggers in the text fields you type in |

## Exports and backups

When you export a backup (JSON, CSV or AutoHotKey), the file is saved to your computer by your browser. FlashKey never uploads it anywhere.

## Children

FlashKey is a general productivity tool. It doesn't knowingly collect information from anyone, including children, because it doesn't collect information at all.

## Changes

If this policy ever changes, the new version will be published in this repository with a new date. Any future optional feature that would send data anywhere (for example, opt-in sync) will be off by default and explained before you turn it on.

## Contact

Questions? Open an issue at <https://github.com/elliotlucid090806/Flashkey/issues>.
