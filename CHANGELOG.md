# Changelog

## 0.3.0

### New features

- **Node notes**: Attach a short note to any node via the ✎ icon in the panel. Notes survive compaction and hard-compact.
- **Hard Compact**: New command `Undo Tree: Hard Compact` removes old nodes beyond a configurable age (`undotree.hardCompactAfterDays`). Current node, noted nodes, and their ancestors are always protected.
- **Node size metrics**: Each node can display a line-count or byte-count diff relative to the current or initial node. Controlled by `undotree.nodeSizeMetric` (`none` / `lines` / `bytes`) and `undotree.nodeSizeMetricBase` (`current` / `initial`). Numbers use thousands separators; bytes switch to MB tier automatically.
- **Adaptive persistence**: Large tree files are gzip-compressed automatically (`undotree.compressionThresholdKB`). Very large full-snapshot content is split into separate checkpoint files (`undotree.checkpointThresholdKB`) and loaded lazily to avoid blocking the UI.
- **Loading indicator**: A cover overlay appears in the sidebar when a checkpoint file is read from disk. Only shown on actual cache misses, not on every node click.
- **Async node jump**: Jumping to a checkpoint node is now non-blocking; the editor is updated asynchronously.
- **Content cache**: Checkpoint content is cached in memory with an LRU eviction policy (`undotree.contentCacheMaxKB`, default 20 MB).
- **Hash-based session restore**: On reopen, `currentId` is reconciled with the actual file content by hash so the tree position stays consistent even if node IDs shift.
- **DAG convergence**: Saving content identical to an existing node reuses that node instead of creating a duplicate.
- **`timeFormat: none`**: New option to hide timestamps entirely.
- **Latest-node highlight**: The most recently timestamped leaf node is highlighted in green.
- **Right-area sticky**: Timestamps and size metrics stick to the right edge during horizontal scroll.
- **Keyboard navigation**: Arrow keys move focus within the sidebar; `Enter` jumps to the focused node.
- **`showStorageKind` setting**: Optionally show `F`/`D` storage-kind badges on each node (default off).
- **Debug output channel**: Extension logs to an `Undo Tree` output channel for diagnostics.
- **Dirty-flag persistence**: Only modified trees are written to disk on each auto-save cycle, reducing I/O when many files are tracked.

### Fixes

- Fixed auto-persist deleting saved trees for files that were not open in the current session.
- Fixed `ロードできません` / loading-stuck state caused by unhandled errors during disk restore.
- Fixed "No active editor" shown in the sidebar when focus moved to the panel during an async tree load.
- Fixed `undotree.autosaveInterval` minimum enforcement (now at least 5 s).

### Changes

- Replaced text-based branch drawing with inline SVG connectors for consistent alignment.
- Removed `undotree.nodeMarkerStyle` setting (replaced by `undotree.nodeSizeMetric`).
- `(empty)` badge is shown for nodes that recorded an empty document.
- Size diff shows `±0` explicitly rather than hiding the field.

## 0.2.1

- Fixed tree initialization when opening an existing file so the initial node reflects the current document content.
- Reworked tree layout rendering to produce stable branch structure and avoid incorrect indentation for linear chains.
- Removed content-based node convergence so editing from an older node always creates a new branch in the history tree.
- Fixed branching behavior when jumping to older nodes and then saving, including autosave timing issues.
- Replaced text-based branch drawing with inline SVG connectors for more consistent alignment and visibility.
- Changed the settings button to open a menu with settings, persisted save, restore, compact, pause/resume, and tracking actions.
- Added persisted history save and restore commands.
- Added on-demand persisted history restore when tracked files are opened again.
- Added `undotree.persistenceMode` with `manual` and `auto` modes.
- Persisted pause state and ensured manual and automatic persistence both retain it.
- Added configurable timestamp formats, including `date-fns`-compatible custom formatting with `undotree.timeFormat` and `undotree.timeFormatCustom`.
- Added configurable node marker styles with `undotree.nodeMarkerStyle`, including `none`, `simple`, and `semantic` with `semantic` as the default.
- Improved `none` marker rendering so rows do not keep an empty marker gap.
- Localized command and setting labels through package NLS files, including Japanese translations for the newly added settings.
- Updated tests and README documentation to match the current behavior.
