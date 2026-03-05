# Adbreak Mute (Chrome Extension)

Adbreak Mute is a Manifest V3 Chrome extension scaffold that can mute or unmute the active tab from a popup.

## Load the extension (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked**.
4. Select this repository folder.
5. Click the Adbreak Mute extension icon in the toolbar to open the popup.

## Current scaffold features

- Manifest V3 extension setup.
- Popup UI with:
  - Enable toggle (persisted via `chrome.storage.local`).
  - `Mute tab` and `Unmute tab` buttons.
  - Current active-tab muted status line.
- Background service worker that updates tab mute state using `chrome.tabs.update`.
- Placeholder icons in `icons/`.

## Notes

- This is scaffolding only; ad/logo detection is not implemented yet.
