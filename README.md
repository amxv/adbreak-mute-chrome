# Adbreak Mute (Chrome Extension)

Adbreak Mute is a Manifest V3 Chrome extension that monitors a selected tab and auto-mutes during ad breaks when a calibrated logo region disappears.

## What the MVP does

- Binds monitoring to a user-selected tab (from popup).
- Samples frames using `chrome.tabs.captureVisibleTab()` via `chrome.alarms`.
- Uses an offscreen document for canvas image processing (ROI dHash + Hamming distance).
- Applies hysteresis:
  - N consecutive logo-absent samples => auto-mute.
  - M consecutive logo-present samples => auto-unmute.
- Respects user mute intent:
  - Never auto-unmutes if the tab is muted by user (`reason === "user"`).
  - Auto-unmutes only when the extension previously auto-muted.
- Includes calibration/options UI:
  - Capture frame.
  - Drag ROI selection.
  - Save normalized ROI + reference dHash.
  - Configure threshold and hysteresis.
- Handles blank/black capture scenarios (DRM/protected playback) with clear status and manual fallback guidance.

## Load the extension (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.

## Basic usage

1. Open your stream tab and click the extension popup.
2. Click **Start monitoring current tab**.
3. Click **Open calibration/options**.
4. In options:
   - Click **Capture frame**.
   - Drag a rectangle over the top-left logo/watermark region.
   - Click **Save selected ROI**.
   - Adjust threshold/hysteresis if needed and click **Save settings**.
5. Keep the monitored tab active in its window while detection runs.

## Notes and limitations

- Screenshot sampling requires the monitored tab to be the active tab in its window.
- Protected/DRM video may return blank frames; auto-detection will pause and surface an error.
- Processing is fully local; screenshots are not uploaded.

## License

Apache 2.0
