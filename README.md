# vscode-undotree

Visualize and navigate save-based undo history as a tree in VS Code.

[Japanese README](./README_ja.md)

## Overview

Unlike standard linear undo/redo, **vscode-undotree** preserves editing branches. When you undo, move to an older node, and continue editing, your previous future is kept as another branch you can return to later.

The tree is based on file saves and periodic autosave checkpoints. It does not replace VS Code's native undo stack; it adds a separate history layer for navigating meaningful states.

![Undo Tree panel](./media/undotree-panel.png)

## Features

- **Tree-structured undo history**: Branches are preserved instead of discarded
- **Save-triggered checkpoints**: History nodes are created on every save
- **Periodic autosave**: Creates a checkpoint every 30 seconds when content changed (configurable)
- **Hybrid storage**: Small changes are stored as diffs; larger changes and branch points are stored as full snapshots
- **Adaptive persistence**: Trees are gzip-compressed automatically; large content is split into lazy-loaded checkpoint files
- **Sidebar panel**: Visualize the history tree and click nodes to jump
- **Keyboard navigation**: Arrow keys move focus in the sidebar; `Enter` jumps to the focused node
- **Diff mode**: Compare any node with the current document
- **Node notes**: Attach a short note to any node via the ✎ icon
- **Node size metrics**: See line-count or byte-count diff for each node relative to current or initial
- **Selective tracking**: Track only configured extensions and exclude matching files
- **Pause / Resume**: Temporarily stop history capture without losing the tree
- **Persisted history**: Save, restore, and reload tracked trees across sessions
- **Compaction**: Reduce noise in long linear chains without removing branch points
- **Hard Compact**: Remove old branches beyond a configurable age

## Installation

This extension is distributed as a `.vsix` file via [GitHub Releases](https://github.com/mmiyaji/vscode-undotree/releases).

1. Go to the [Releases page](https://github.com/mmiyaji/vscode-undotree/releases) and download the latest `.vsix` file.
2. Open VS Code.
3. Open the Command Palette (`Ctrl+Shift+P`) and run `Extensions: Install from VSIX...`.
4. Select the downloaded `.vsix` file.

## Usage

| Action | Method |
|--------|--------|
| Open Undo Tree panel | Sidebar -> Explorer -> **Undo Tree** |
| Focus panel | `Ctrl+Shift+U` |
| Create checkpoint | Save the file (`Ctrl+S`) |
| Undo / Redo | Click **Undo** / **Redo** in the panel |
| Jump to any node | Click the node row in the panel |
| Compare with current | Switch to **Diff** mode and click a node |
| Pause / Resume tracking | Click **Pause** / **Resume** in the panel |
| Open actions menu | Click the settings button in the panel |
| Enable / disable current extension | Click the status bar item |

### Panel layout

```
Undo  Redo  Pause  Diff  [menu]
────────────────────────────────
● initial                         00:00:00
● save                  +120 L    00:01:05
└─ ● save              +1 L      00:02:30
● auto                 +3 L      00:03:00
● save   ✎ my note    +5 L      00:04:12   ◀ current
```

- The highlighted row is the current position.
- Size diff (e.g. `+120 L`) shows lines added/removed relative to the current node.
- `✎ my note` is a user-attached note; click to edit.
- Branch lines are drawn with SVG connectors in the sidebar.
- Enable `undotree.showStorageKind` to show `F` (full) / `D` (delta) badges.

### Status bar

The status bar item in the lower right shows the tracking state of the current file:

| Display | Meaning |
|---------|---------|
| `$(history) Undo Tree: ON` | Current extension is tracked |
| `$(circle-slash) Undo Tree: OFF` | Current extension is not tracked; click to enable |
| `$(debug-pause) Undo Tree: PAUSED` | Tracking is paused globally; click to toggle |

Hover over the item to see the detected extension, enabled list, and exclude state.

### Keyboard shortcuts (sidebar panel)

When the sidebar panel has focus:

| Key | Action |
|-----|--------|
| `↑` / `k` | Move focus up |
| `↓` / `j` | Move focus down |
| `←` | Move focus to parent node |
| `→` | Move focus to last child node |
| `Tab` / `Shift+Tab` | Move to next / previous sibling |
| `Home` | Move focus to first node |
| `End` | Move focus to last node |
| `Enter` / `Space` | Jump to focused node (or compare in Diff mode) |
| `u` | Undo (move to parent of current node) |
| `r` | Redo (move to last child of current node) |
| `d` | Toggle Navigate / Diff mode |
| `p` | Toggle Pause / Resume |
| `n` | Move focus to next noted node |
| `N` | Move focus to previous noted node |

### Actions menu

The settings menu includes:

- `Open Settings`
- `Save Persisted State`
- `Restore Persisted State`
- `Compact History`
- `Hard Compact` (removes nodes older than `undotree.hardCompactAfterDays`)
- `Pause Tracking` / `Resume Tracking`
- `Toggle Tracking for This Extension`

## Persistence

Persisted history is stored in the extension storage directory, not in your workspace by default.

Saved data is split per tracked file:

- `undo-trees/manifest.json`
- `undo-trees/<file-hash>.json`

Behavior:

- `Save Persisted State` writes the current tracked trees to disk
- `Restore Persisted State` reloads the saved tree for the active file
- Opening a tracked file reloads its saved tree on demand
- If the file content differs from the saved current node, a new `restore` node is appended
- Pause state is also persisted

## Compaction

`Compact History` reduces noise in long linear chains by removing compressible middle nodes.

Current behavior:

- Only simple middle nodes in a straight chain are removed
- Branch points are kept
- Leaf nodes are kept
- The current node is kept
- Mixed-content nodes are kept

Here, `mixed` means a node that is not part of a pure insert-only chain or pure delete-only chain. Full snapshot nodes are treated as `mixed`, and delta nodes that contain both insertion and deletion are also treated as `mixed`, so they are excluded from compaction.

```mermaid
graph LR
  subgraph Before
    A["full"] --> B["delta"] --> C["delta"] --> D["delta"] --> E["current"]
  end

  subgraph After
    A2["full"] --> C2["delta"] --> E2["current"]
  end

  E -.-> A2
```

## Configuration

Open settings from the actions menu, or search for `undotree` in VS Code settings.

| Setting | Default | Description |
|---------|---------|-------------|
| `undotree.enabledExtensions` | `[".txt", ".md"]` | File extensions to automatically track |
| `undotree.excludePatterns` | `[]` | Filename patterns to exclude (supports `*` wildcard) |
| `undotree.persistenceMode` | `"manual"` | `manual` saves only when requested; `auto` saves automatically after history changes |
| `undotree.autosaveInterval` | `30` | Autosave snapshot interval in seconds (`0` to disable, minimum 5) |
| `undotree.timeFormat` | `"time"` | Timestamp format: `none`, `time` (HH:mm:ss), `dateTime`, or `custom` |
| `undotree.timeFormatCustom` | `"yyyy-MM-dd HH:mm:ss"` | Custom timestamp format (date-fns syntax); used when `timeFormat` is `custom` |
| `undotree.showStorageKind` | `false` | Show `F`/`D` storage-kind badges on each node |
| `undotree.nodeSizeMetric` | `"lines"` | Size diff per node: `none`, `lines`, or `bytes` |
| `undotree.nodeSizeMetricBase` | `"current"` | Reference node for size diff: `current` or `initial` |
| `undotree.compressionThresholdKB` | `100` | Total full-node content size (KB) above which the tree file is gzip-compressed |
| `undotree.checkpointThresholdKB` | `1000` | Size (KB) above which full-node content is split into separate checkpoint files |
| `undotree.contentCacheMaxKB` | `20480` | In-memory cache limit for checkpoint content (KB); LRU eviction |
| `undotree.hardCompactAfterDays` | `0` | Age threshold (days) for `Hard Compact`; `0` disables the command |

**Examples:**

```json
{
  "undotree.enabledExtensions": [".txt", ".md", ".js", ".ts"],
  "undotree.excludePatterns": ["*.min.*", "CHANGELOG*"],
  "undotree.persistenceMode": "auto",
  "undotree.nodeSizeMetric": "lines",
  "undotree.hardCompactAfterDays": 30
}
```

## Design Philosophy

### Linear undo vs. vscode-undotree

With standard undo, making a new edit after undoing permanently discards your previous future:

```mermaid
graph LR
  subgraph "Standard undo"
    A1["A"] --> B1["B"] --> C1["C"]
    B1 --> D1["D"]
    classDef lost fill:#ccc,color:#999,stroke:#ccc
    C1:::lost
  end
```

vscode-undotree preserves both paths:

```mermaid
graph LR
  subgraph "vscode-undotree"
    A2["A"] --> B2["B"] --> C2["C"]
    B2 --> D2["D"]
    style C2 fill:#d4edda,stroke:#28a745
    style D2 fill:#d4edda,stroke:#28a745
  end
```

### Save as a meaningful checkpoint

Many undo tree tools record every keystroke. That quickly becomes noisy. vscode-undotree uses **file saves as the main unit of history**, which produces a tree closer to how people think about meaningful editing states.

```mermaid
sequenceDiagram
  actor User
  participant Editor
  participant UndoTree

  User->>Editor: Type
  Editor->>UndoTree: Buffer changeEvents
  User->>Editor: Save
  Editor->>UndoTree: Commit node
```

### Hybrid storage: delta and full snapshots

```mermaid
flowchart TD
  save["Save event"] --> same{"Same content as current?"}
  same -->|Yes| skip["Skip"]
  same -->|No| ratio{"Large change or branch point?"}
  ratio -->|Yes| full["Store full snapshot"]
  ratio -->|No| delta["Store delta only"]
```

For compaction purposes, nodes are also classified as `insert`, `delete`, or `mixed`:

- `insert`: delta node with insert-only changes
- `delete`: delta node with delete-only changes
- `mixed`: full snapshot nodes, or delta nodes that contain both insertion and deletion

Branch points are upgraded to full snapshots so each branch remains reconstructable.

### Restoring any node

```mermaid
graph LR
  subgraph Tree
    N0["root / full"]
    N1["node1 / full"]
    N2["node2 / delta"]
    N3["node3 / delta"]
    N4["node4 / delta"]
    N0 --> N1 --> N2 --> N3 --> N4
  end

  N4 --> step1["Walk up to nearest full node"]
  step1 --> step2["Load full content"]
  step2 --> step3["Apply deltas in order"]
  step3 --> result["Restored content"]
```

### Persisted state and restore-on-open

Persisted trees are saved per file. When a tracked file is opened again, its saved tree is loaded on demand. If the on-disk file content differs from the saved current node, the extension appends a `restore` node so the tree stays consistent with the actual document state.

### No interference with VS Code's native undo

vscode-undotree operates alongside VS Code's built-in undo stack. It does not replace or intercept the native undo mechanism. The tree is a separate layer for navigating between save checkpoints.

## Requirements

- VS Code 1.90.0 or later

## License

MIT
