# AGENTS.md

## Debug Logging Workflow

- The extension mirrors background debug lines to `http://127.0.0.1:38241/log`.
- A local log sink can be started with:
  ```bash
  /Users/ashray/.vite-plus/js_runtime/node/25.8.1/bin/node tmp/extension-log-server.js
  ```
- The sink writes live logs to:
  ```bash
  tmp/extension-debug.log
  ```
- Preferred debugging loop:
  1. Start the local log server.
  2. Reload the extension in `chrome://extensions`.
  3. Reproduce from the real toolbar popup while the stream remains open.
  4. Inspect `tmp/extension-debug.log` from the terminal.

## Agent Browser Workflow

- Do not open the extension popup/debug pages in the same tab as the stream if the active stream tab matters for capture.
- Use `agent-browser` or `npx -y agent-browser` in headed mode with the user logged in.
- Keep the stream tab open in the same browser window when testing capture behavior.
- Useful commands:
  ```bash
  npx -y agent-browser open https://www.hotstar.com/in/sports/cricket/rr-vs-rcb/1540065727/video/live/watch
  npx -y agent-browser snapshot -i
  npx -y agent-browser get url
  npx -y agent-browser get title
  ```
- Prefer reading terminal-side mirrored logs over navigating to extension debug pages during live stream debugging.

## Detector Notes

- The current detector assumes the logo area is always in the top-left region.
- Template capture stores both shape-like edge data and a lightweight ink profile.
- Matching should be tuned against live stream behavior using the mirrored log scores rather than only visual intuition.
