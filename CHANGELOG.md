# Changelog

## 0.3.2

### New features

- Added `Pair Diff` so two arbitrary history nodes can be compared without involving the current document.
- Added `relative` timestamp display mode.
- Added a runtime language override setting (`auto`, `en`, `ja`) for sidebar and runtime UI strings.
- Added a node context menu with note, pin, diff, and display-settings actions.
- Added rename/move history migration so in-memory and persisted trees follow file URI changes.

### Improvements

- Added structured persist/load logging to the `Undo Tree` output channel so node-count changes during save and restore can be traced more easily.
- Hardened persisted-tree import by validating serialized node storage, required references, and parent/child back-references before accepting on-disk history.
- Added nonce-based Content Security Policy to the sidebar webview and removed inline action handlers in favor of explicit event listeners.
- Added topology repair for broken persisted trees and lightweight pre-checks so repair runs only when needed.
- Improved diff review flow with better panel focus behavior, shortcut help overlay, and latest-state-aware Hard Compact protection.

### Fixes

- Fixed webview HTML escaping for node labels, formatted timestamps, and fallback not-tracked content.
- Fixed checkpoint content loading so failed reads no longer fall back to cached empty strings and silently corrupt restored history.
- Fixed checkpoint cache byte accounting when the same hash is refreshed multiple times.
- Fixed reset and shutdown flows so pending persisted state is flushed safely and multi-window lock files are released.
- Fixed compact preview and diagnostics webview actions to surface failures instead of leaving the UI in a silent broken state.
- Fixed autosave after `jumpToNode()` so navigation alone does not create extra save/autosave nodes.
- Fixed note editing so memo text uses double-click or the edit icon instead of hijacking normal node selection.
- Fixed rename-in-place handling so visible history survives immediate file rename operations without requiring a tab switch.

## 0.3.1

### New features

- Added a Diagnostics panel for inspecting persisted storage, manifest state, orphan files, validation results, and multi-window locks.
- Added persisted-storage maintenance actions from Diagnostics, including validation, orphan pruning, and manifest rebuild.
- Added best-effort multi-window conflict warnings for `auto` persistence mode using short-lived lock files with heartbeat and TTL.
- Added automatic idle unload for clean persisted trees to reduce memory usage while keeping on-demand restore behavior.
- Added configurable in-memory checkpoint promotion with `undotree.memoryCheckpointThresholdKB` to reduce branch-snapshot memory pressure.

### Improvements

- Reused the Undo Tree webview shell and switched tree updates to message-driven rendering to reduce redraw cost.
- Improved compact preview with tree-based `ALL` view, keep/remove overrides, reason summaries, validation actions, and panel reuse behavior.
- Reused the same diff editor more consistently and improved focus behavior when opening comparisons.
- Added safer manifest handling with `manifest.json.bak` fallback and disabled automatic prune during manifest recovery.
- Improved persisted-history behavior so root-only untouched trees are not written to the manifest until history actually grows.
- Added diagnostics visibility for multi-window lock status, including live/stale/owned summaries.
- Added idle-unload logging to the `Undo Tree` output channel.
- Updated settings organization and documentation for advanced performance tuning.

### Fixes

- Fixed persisted history cleanup so manifest read failures do not silently prune existing data.
- Fixed `Open Storage Folder` from diagnostics and recovery warnings.
- Fixed `Reset All State` from manifest recovery warnings so it works during startup recovery flows.
- Fixed lock heartbeat so it only runs for currently open tracked text documents.
- Fixed compact preview execution so actions continue to work when the preview panel has focus.
- Fixed preview and diagnostics flows for files that were opened but never changed.
- Fixed several Japanese localization gaps around diagnostics, preview, and compact-related actions.

## 0.3.0

### New features

- Added node notes that survive compaction and hard compact.
- Added `Hard Compact` with age-based pruning via `undotree.hardCompactAfterDays`.
- Added line-count and byte-count node metrics relative to `current` or `initial`.
- Added adaptive persistence with gzip compression and large-content checkpoint files.
- Added lazy checkpoint loading with a loading indicator for disk cache misses.
- Added non-blocking async jumps to checkpoint nodes.
- Added an in-memory LRU cache for checkpoint content.
- Added current-node reconciliation by content hash after restore.
- Added latest-leaf highlighting and optional storage-kind badges.
- Added keyboard navigation in the sidebar and an output channel for diagnostics.

### Fixes

- Fixed auto-persist deleting saved trees for files that were not open in the current session.
- Fixed loading-stuck states caused by unhandled errors during disk restore.
- Fixed incorrect "No active editor" states while async tree loading was in progress.
- Fixed minimum enforcement for `undotree.autosaveInterval`.

### Changes

- Replaced text-based branch drawing with inline SVG connectors.
- Removed `undotree.nodeMarkerStyle` in favor of node-size metrics.
- Added explicit empty-document badges and zero-size diff display.

## 0.2.1

- Fixed tree initialization when opening an existing file so the initial node reflects the current document content.
- Reworked tree layout rendering to keep branch structure stable and avoid incorrect indentation in linear chains.
- Removed content-based node convergence so editing from an older node always creates a new branch.
- Fixed branching behavior when jumping to older nodes and then saving, including autosave timing issues.
- Replaced text-based branch drawing with inline SVG connectors for more consistent alignment and visibility.
- Changed the settings button to open a menu with actions such as settings, persisted save/restore, compact, pause/resume, and tracking toggles.
- Added persisted history save and restore commands.
- Added on-demand persisted history restore when tracked files are opened again.
- Added `undotree.persistenceMode` with `manual` and `auto` modes.
- Persisted pause state and ensured both manual and automatic persistence retain it.
- Added configurable timestamp formats, including `date-fns`-compatible custom formatting.
- Localized commands and settings, including Japanese translations for newly added options.
- Updated tests and README documentation to match the current behavior.
