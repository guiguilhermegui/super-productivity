For all current downloads, package links, and platform-specific notes: [check the wiki](https://github.com/super-productivity/super-productivity/wiki/2.01-Downloads-and-Install).

## Super Productivity 18.6.0

### Highlights

- Added scheduling warnings for overlapping tasks and tasks outside work hours (#7559).
- Added repeat-after-completion for repeating tasks (#7524).
- Added configurable dynamic breaks for Flowtime (#7402).
- Added an image picker for choosing background images (#7564).
- Added per-provider include/exclude regex filters for iCal calendars (#7528).

### Tasks, Focus & UI

- Show the Pomodoro timer in the browser tab title (#7579).
- Added a notes panel shortcut.
- Prevented task creation during IME conversion (#7557).
- Persist collapsed sections across project switches (#7600).
- Restored ArrowRight focus into the task detail panel.
- Format add-task-bar times using the user's locale (#7563).
- Improved UI consistency, wording capitalization, task done-toggle styling, plugin dialog backgrounds, and Velvet/liquid-glass theme details.

### Calendar & Worklog

- Prevent Google time-block sync from hitting write rate limits.
- Request verified Google OAuth scopes.
- Harden iCal regex filters against ReDoS.
- Reload worklog on context changes so metrics stay per project.

### Sync & SuperSync

- Improved SuperSync server speed and correctness (#7621), faster uploads, and optimized status/conflict checks.
- Fixed WebSocket reconnect storms caused by shared client IDs.
- Preserve WebDAV credentials on transient auth errors and improve WebDAV connection tests (#7617).
- Retry transient web fetch failures/rate-limited uploads and surface warnings.
- Hardened SuperSync snapshot replay, storage quota accounting, retry idempotency, cleanup, and deploy/migration recovery.
- Handle wrapped backup encryption imports and filter stale ops after synced import.

### Plugins & Integrations

- Added plugin automation triggers for task start/stop and a removeTag action.
- Added plugin onReady() API with IPC ping and fixed consent write delay (#7578).
- Improved plugin tag ID handling and protected the virtual TODAY tag from plugin sync.
- Use template tray icons on macOS (#7609).
- Retry Wayland idle helper startup on Electron/Linux (#7527).
- Handle Android WebView initialization and foreground service failures safely.

### Privacy & Security

- Prevent exported logs from leaking user content (#7619).
- Sanitized sync-related logging and hardened SuperSync error handling, quota paths, rate limits, and content-encoding handling.
- Avoid PWA startup stalls during network changes.

### Localization

- Updated Vietnamese translation (#7576).
- Moved collapsed subtasks label to translations and improved capitalization.
