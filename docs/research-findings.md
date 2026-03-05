# Research Findings: MV3 Chrome Extension for Auto-Mute During Cricket Ad Breaks (Logo/Overlay Disappearance)

This doc summarizes viable, mostly-deterministic approaches for a Chrome extension that **mutes/unmutes a tab** during ad breaks by detecting when a **tournament logo/watermark/overlay disappears**.

Assumptions:
- The broadcast has a relatively stable, persistent overlay during play (tournament logo, watermark, score bug, etc.).
- During ad breaks, that overlay either disappears or changes significantly.
- We want a **deterministic** solution first (no ML), with ML optional.
- Target: **Manifest V3 (MV3)**.

---

## 1) Best Chrome extension APIs for muting a tab (+ limitations)

### `chrome.tabs.update(tabId, { muted: true|false })` (recommended)

- Chrome exposes tab muting via the Tabs API. You can toggle mute by reading `tab.mutedInfo.muted` and setting the opposite with `chrome.tabs.update()`.
- `tabs.Tab.mutedInfo` includes both the current state and a reason code so you can avoid fighting the user:
  - `mutedInfo.muted` (boolean)
  - `mutedInfo.reason`: `user` / `capture` / `extension`

Why this is the best default:
- It’s the most direct “mute this tab” capability available to extensions.
- It doesn’t require audio capture, recording, or web-audio plumbing.

Limits / what it *can’t* do:
- This only controls **Chrome’s tab audio routing**. Extensions cannot directly mute:
  - OS/system audio (macOS/Windows mixer),
  - other applications,
  - the entire machine audio output.
- “Fallback to system audio mute” generally implies a **native helper app** (Native Messaging) rather than a pure extension.

Practical safeguards:
- Only unmute if your extension muted it (store “I muted this” state per tab), otherwise you’ll override the user’s manual mute.
- If you later use `chrome.tabCapture`, note that tab capture can force a muted-state change with reason `capture`.

Sources:
- Tabs API reference (mute example + `MutedInfo`): https://developer.chrome.com/docs/extensions/reference/api/tabs

---

## 2) Best APIs to capture pixels/frames from a tab (+ DRM/protected playback)

You have three meaningful capture approaches for “logo disappears” detection:

### A) `chrome.tabs.captureVisibleTab()` (screenshot sampling)

What you get:
- A screenshot (data URL) of the **visible area** of the **currently active tab** in a window.

Permissions:
- Requires `activeTab` **or** host permissions (`<all_urls>`).
- `activeTab` is preferred because it’s **temporary** and granted on user invocation (action click, shortcut, etc.), and it avoids the install-time “read all sites” warning.

Hard constraints:
- There is a documented cap: `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` is `2`.
- It only captures the *active/visible* tab, so it’s not suitable for background monitoring of a tab the user isn’t viewing.

Why it’s attractive for this project:
- At 0.5–1 fps it’s often enough for ad-break detection.
- No audio side effects.
- Smaller permission surface than `tabCapture`.

Sources:
- Tabs API: https://developer.chrome.com/docs/extensions/reference/api/tabs
- `activeTab`: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab

### B) `chrome.tabCapture` (MediaStream from the tab)

What you get:
- A `MediaStream` (or an opaque stream ID that can be consumed via `getUserMedia()`) containing the tab’s video and/or audio.

MV3-friendly pattern (Chrome 116+):
- In the service worker: `chrome.tabCapture.getMediaStreamId({ targetTabId })`
- In an **offscreen document**: call `navigator.mediaDevices.getUserMedia()` with that ID and process frames from a `<video>` element.

Important side effect:
- When you obtain a MediaStream for a tab, **audio in that tab will no longer be played to the user** by default.
- If you still want the user to hear audio, you can route it back via `AudioContext` (connect stream source → destination).

Where it’s best:
- When you need frame analysis more continuous than 1–2 fps screenshots.
- When you want a pipeline that can persist across navigations inside the tab.

Sources:
- `chrome.tabCapture`: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chrome guide (tab capture + offscreen in MV3): https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture

### C) `chrome.desktopCapture.chooseDesktopMedia()` (screen/window/tab picker)

What you get:
- A user-facing picker UI to select “screen”, “window”, or “tab”, then a stream ID you can consume.

Where it’s best:
- A privacy-forward fallback where the user explicitly approves capture (e.g., “Pick the tab/window to monitor”).

Constraint:
- Always requires explicit picker UI (not silent).

Source:
- Desktop Capture API: https://developer.chrome.com/docs/extensions/reference/api/desktopCapture

### Offscreen documents (`chrome.offscreen`) for MV3 pixel work

Why it matters:
- MV3 service workers don’t have DOM. Offscreen documents provide a hidden page to use DOM/canvas APIs.
- Offscreen documents only support the `chrome.runtime` extension API (messaging), so tab muting calls still live in the service worker.
- Only one offscreen document can be open per profile at a time.

Source:
- Offscreen API: https://developer.chrome.com/docs/extensions/reference/api/offscreen

### DRM / protected playback limitations (Widevine / EME)

Protected playback often blocks frame extraction or produces black frames (platform + pipeline dependent).

Strong signal from Chromium:
- Chromium explicitly blocks `HTMLMediaElement.captureStream()` when EME keys are present (“Stream capture not supported with EME”).

Practical takeaway:
- Any approach relying on pixels/frames can fail on DRM-protected streams.
- You should design a “degrade gracefully” behavior (don’t flap mute/unmute; allow a manual hotkey).

Sources:
- Chromium code: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/modules/mediacapturefromelement/html_media_element_capture.cc
- Widevine screen-recording restriction regression discussion (illustrates platform variance): https://issues.chromium.org/issues/326321538

---

## 3) Deterministic logo detection ideas (ROI-based)

The most reliable deterministic path is to **inspect a fixed ROI** (region of interest) where the logo/overlay normally appears.

### Recommended overall strategy

1. **Calibration step** (“Learn logo”):
   - User starts watching the match.
   - Extension captures one sample frame and records:
     - ROI location (normalized coords, e.g., `x,y,w,h` as fractions of width/height)
     - 1–3 reference signatures of that ROI
2. During monitoring:
   - Sample at a low cadence (e.g., 1 fps with screenshots; higher if using stream).
   - Crop ROI → downscale → compute similarity score against references.
   - Apply hysteresis to decide “logo present vs absent”.

### Candidate deterministic metrics (good options)

All of these become cheap if you crop ROI first and downscale hard (e.g., 64×64 or 32×32).

1) **Perceptual hashing (`pHash`) or difference hash (`dHash`)**
- Compare Hamming distance between current ROI hash and reference hash.
- Pros: fast, robust to compression and small brightness changes.
- Cons: needs threshold tuning; false positives if overlays are visually similar.

2) **SSIM (Structural Similarity)**
- Compute SSIM on downscaled grayscale ROI vs reference.
- Pros: good at structural similarity (often better than MSE).
- Cons: heavier than hashes; still needs thresholds.

3) **Template matching (normalized cross-correlation)**
- Works best if overlay position and scale are stable.
- Pros: straightforward.
- Cons: sensitive to scaling/position drift; mitigate by downscaling and allowing some margin.

4) **Histogram correlation (HSV/RGB)**
- Pros: very cheap.
- Cons: higher false positives; best as a coarse filter or secondary signal.

### Practical robustness features (often more important than the metric)

- **Hysteresis**:
  - require N consecutive “absent” samples before muting (e.g., N=3),
  - require M consecutive “present” samples before unmuting (e.g., M=2).
- **Multi-reference**: store a few reference signatures (overlay can change slightly during play).
- **Edge-based signature**: compute an edge map (Sobel) then hash/correlate edges to reduce sensitivity to color/grade changes.
- **Fail-safe**: if confidence is borderline, prefer not changing mute state over flapping.

### Performance + MV3 constraints

- `captureVisibleTab` is capped at 2 fps, so design for **~1 fps** sampling.
- Always crop ROI and downscale; a tiny ROI signature should be well under a few ms on typical hardware.
- MV3 service workers can be suspended; for “continuous” processing, use:
  - `chrome.alarms` for periodic sampling, and/or
  - an offscreen document for canvas/image processing.

---

## 4) Minimal permissions + MV3 architecture

### Minimal “deterministic screenshot” implementation (recommended first)

Permissions:
- `activeTab` (temporary access to current tab for capture)
- `storage` (store ROI + thresholds)
- `alarms` (sampling loop)
- optional `offscreen` (if you want DOM/canvas convenience for image decode + processing)

Architecture:
- Service worker owns state machine + muting decisions.
- On action click:
  1. Save `tabId` and ROI config (or start calibration).
  2. Start an alarm every ~1 second.
- On alarm:
  1. Call `tabs.captureVisibleTab()` (windowId derived from current/target tab context).
  2. Compute `logoPresent` from ROI.
  3. Apply hysteresis.
  4. Call `tabs.update(targetTabId, { muted: ... })` when state transitions occur.

Pros:
- Small permission surface and simplest UX.
- No audio routing complexity.

Cons:
- Only works reliably while the match tab is visible/active.
- DRM/protected playback can break pixel access.

### “Continuous stream analysis” implementation (backup)

Permissions:
- `tabCapture`, `offscreen` (plus `storage`)

Architecture:
- Service worker gets `tabCapture.getMediaStreamId({ targetTabId })` on a user gesture.
- Offscreen document consumes stream via `getUserMedia()` and analyzes frames.

Pros:
- Better cadence and potentially more stable frame access (depending on platform).

Cons:
- Heavier permissions and review scrutiny.
- Capturing can suppress local audio unless you explicitly re-play it.
- DRM can still block/black frames.

---

## 5) Chrome Web Store policy + privacy considerations

Because screen/tab capture can expose sensitive user data, CWS review expectations are high even if your extension’s intent is benign.

Key policy items to design for:

- **Request the narrowest permissions necessary** (don’t request extra “just in case”).
  - Source: https://developer.chrome.com/docs/webstore/program-policies/permissions
- **Provide an accurate privacy policy** if you handle any user data.
  - Source: https://developer.chrome.com/docs/webstore/program-policies/privacy
- **Limited Use requirements** (especially around browsing activity): only collect/use what’s required for the user-facing feature, and don’t reuse/transfer it.
  - Source: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- **Disclose collection/use and obtain consent** if collecting data not tightly related to your stated purpose.
  - Source: https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements

Practical privacy-forward implementation guidelines:
- Do all processing **locally** (no uploads).
- Persist only derived data (ROI coordinates + hashes), not full screenshots.
- Provide clear UI state (Monitoring ON/OFF) and an obvious stop control.

---

## Recommended approach (primary) + backup

### Primary recommendation

Start with `tabs.captureVisibleTab()` at ~1 fps + ROI dHash/pHash (or SSIM) + hysteresis + `tabs.update({ muted })`.

This is the best balance of:
- deterministic behavior,
- minimal permissions,
- straightforward MV3 implementation.

### Backup recommendation

If screenshot sampling is too limited or you need more continuous frames:
- Use `tabCapture.getMediaStreamId()` + offscreen document + frame analysis.

If DRM/protected playback blocks pixels entirely:
- Fall back to **non-pixel signals** when available (site-specific DOM cues like “Ad” labels or player UI state), and/or
- Provide a manual hotkey / one-click mute toggle as a fail-safe.

