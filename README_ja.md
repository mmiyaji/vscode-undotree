# vscode-undotree

VS Code の保存ベース undo 履歴をツリーとして可視化し、移動できる拡張です。

[English README](./README.md)

## 概要

通常の線形 undo/redo とは異なり、**vscode-undotree** は編集分岐を保持します。過去ノードに戻って別の編集を始めても、元の未来は失われず、別ブランチとして残ります。

履歴はファイル保存と定期 autosave を単位に作られます。VS Code 標準の undo を置き換えるものではなく、意味のある状態をたどるための別レイヤーです。

![Undo Tree パネル](./media/undotree-panel.png)

## 機能

- **ツリー構造の undo 履歴**: 分岐を捨てずに保持
- **保存トリガーのチェックポイント**: 保存ごとに履歴ノードを追加
- **定期 autosave**: 内容が変わっていれば定期的にチェックポイントを追加（間隔設定可）
- **ハイブリッドストレージ**: 小さい変更は diff、大きい変更や分岐点は full snapshot
- **適応型永続化**: ツリーファイルを自動 gzip 圧縮。大きなコンテンツは別ファイルに分離してレイジーロード
- **サイドバーパネル**: 履歴ツリーを表示し、クリックで任意ノードへ移動
- **キーボード操作**: 矢印キーでフォーカス移動、`Enter` でジャンプ
- **Diff モード**: 任意ノードと現在内容を比較
- **ノードメモ**: ✎ アイコンで任意ノードにメモを付与
- **ノードサイズ指標**: 現在ノードまたは初期ノードとの行数・バイト数差分を表示
- **選択的トラッキング**: 拡張子単位の追跡と除外パターンに対応
- **Pause / Resume**: 既存ツリーを保持したまま履歴記録を一時停止
- **永続化**: 履歴の保存、復元、再オープン時の読込に対応
- **コンパクション**: 長い直列履歴のノイズを削減
- **Hard Compact**: 設定日数より古いブランチを一括削除

## インストール

この拡張は [GitHub Releases](https://github.com/mmiyaji/vscode-undotree/releases) から `.vsix` ファイルとして配布されます。

1. [Releases ページ](https://github.com/mmiyaji/vscode-undotree/releases) から最新の `.vsix` をダウンロードします。
2. VS Code を開きます。
3. コマンドパレット (`Ctrl+Shift+P`) で `Extensions: Install from VSIX...` を実行します。
4. ダウンロードした `.vsix` を選択します。

## 使い方

| 操作 | 方法 |
|------|------|
| Undo Tree パネルを開く | サイドバー -> Explorer -> **Undo Tree** |
| パネルにフォーカス | `Ctrl+Shift+U` |
| チェックポイント作成 | ファイル保存 (`Ctrl+S`) |
| Undo / Redo | パネルの **Undo** / **Redo** |
| 任意ノードへジャンプ | ノード行をクリック |
| 現在内容と比較 | **Diff** モードにしてノードをクリック |
| 一時停止 / 再開 | パネルの **Pause** / **Resume** |
| アクションメニューを開く | パネルの設定ボタン |
| 現在拡張子の有効 / 無効を切り替え | ステータスバーのアイテムをクリック |

### パネルレイアウト

```
Undo  Redo  Pause  Diff  [menu]
────────────────────────────────
● initial                           00:00:00
● save                  +120 L     00:01:05
└─ ● save              +1 L       00:02:30
● auto                 +3 L       00:03:00
● save   ✎ メモ       +5 L       00:04:12   ◀ current
```

- ハイライトされた行が現在位置です。
- サイズ差分（例: `+120 L`）は現在ノードとの行数差分です。
- `✎ メモ` はユーザーが付与したメモです。クリックで編集できます。
- サイドバーの枝線は SVG コネクタで描画されています。
- `undotree.showStorageKind` を有効にすると `F`（full）/ `D`（delta）バッジが表示されます。

### ステータスバー

右下のステータスバーアイテムが現在ファイルの追跡状態を示します。

| 表示 | 意味 |
|------|------|
| `$(history) Undo Tree: ON` | 現在の拡張子は追跡中 |
| `$(circle-slash) Undo Tree: OFF` | 現在の拡張子は追跡対象外。クリックで有効化 |
| `$(debug-pause) Undo Tree: PAUSED` | 追跡が一時停止中。クリックで切替 |

ホバーすると検出された拡張子、有効リスト、除外状態を確認できます。

### アクションメニュー

設定メニューから次の操作を実行できます。

- `Open Settings`
- `Save Persisted State`
- `Restore Persisted State`
- `Compact History`
- `Hard Compact`（`undotree.hardCompactAfterDays` より古いノードを削除）
- `Pause Tracking` / `Resume Tracking`
- `Toggle Tracking for This Extension`

## 永続化

永続化データは、デフォルトではワークスペース内ではなく拡張の保存領域に保存されます。

ファイルごとに分割して保存します。

- `undo-trees/manifest.json`
- `undo-trees/<file-hash>.json`

挙動:

- `Save Persisted State` で現在の tracked tree を保存
- `Restore Persisted State` でアクティブファイルの保存済み tree を復元
- tracked ファイルを開くと、そのファイルの tree だけをオンデマンドで読込
- 保存済み current ノードと実ファイル内容が違う場合は `restore` ノードを追加
- Pause 状態も永続化される

## コンパクション

`Compact History` は、長い直列チェーンの途中にある圧縮可能な中間ノードを減らし、履歴の見通しを良くする機能です。

現在の挙動:

- 直列チェーン上の単純な中間ノードだけを削除
- 分岐点は残す
- 葉ノードは残す
- current ノードは残す
- mixed ノードは残す

ここでいう `mixed` は、insert だけの連続でも delete だけの連続でもないノードです。full snapshot ノードは `mixed` として扱われ、挿入と削除を両方含む delta ノードも `mixed` 扱いになるため、コンパクション対象から外れます。

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

## 設定

アクションメニューから設定を開くか、VS Code 設定で `undotree` を検索してください。

| 設定 | デフォルト | 説明 |
|------|-----------|------|
| `undotree.enabledExtensions` | `[".txt", ".md"]` | 自動追跡するファイル拡張子 |
| `undotree.excludePatterns` | `[]` | 除外するファイル名パターン（`*` ワイルドカード対応） |
| `undotree.persistenceMode` | `"manual"` | `manual` は手動保存のみ、`auto` は履歴更新後に自動保存 |
| `undotree.autosaveInterval` | `30` | 自動スナップショット間隔（秒）。`0` で無効、最小 5 |
| `undotree.timeFormat` | `"time"` | タイムスタンプ形式: `none`、`time`（HH:mm:ss）、`dateTime`、`custom` |
| `undotree.timeFormatCustom` | `"yyyy-MM-dd HH:mm:ss"` | カスタム時刻書式（date-fns 形式）。`timeFormat: custom` のときに使用 |
| `undotree.showStorageKind` | `false` | 各ノードに `F`/`D` ストレージバッジを表示 |
| `undotree.nodeSizeMetric` | `"lines"` | ノードのサイズ指標: `none`、`lines`、`bytes` |
| `undotree.nodeSizeMetricBase` | `"current"` | サイズ差分の基準: `current`（現在ノード）または `initial`（初期ノード） |
| `undotree.compressionThresholdKB` | `100` | full ノードの合計サイズ（KB）がこの値を超えるとツリーファイルを gzip 圧縮 |
| `undotree.checkpointThresholdKB` | `1000` | full コンテンツをこのサイズ（KB）以上のときに別ファイルに分離 |
| `undotree.contentCacheMaxKB` | `20480` | チェックポイントのインメモリキャッシュ上限（KB）。LRU 方式 |
| `undotree.hardCompactAfterDays` | `0` | Hard Compact の日数閾値。`0` でコマンドを無効化 |

**設定例:**

```json
{
  "undotree.enabledExtensions": [".txt", ".md", ".js", ".ts"],
  "undotree.excludePatterns": ["*.min.*", "CHANGELOG*"],
  "undotree.persistenceMode": "auto",
  "undotree.nodeSizeMetric": "lines",
  "undotree.hardCompactAfterDays": 30
}
```

## 設計思想

### 通常の undo と vscode-undotree の違い

通常の undo では、undo 後に新しい編集をすると以前の未来は失われます。

```mermaid
graph LR
  subgraph "通常の undo"
    A1["A"] --> B1["B"] --> C1["C"]
    B1 --> D1["D"]
    classDef lost fill:#ccc,color:#999,stroke:#ccc
    C1:::lost
  end
```

vscode-undotree は両方の経路を保持します。

```mermaid
graph LR
  subgraph "vscode-undotree"
    A2["A"] --> B2["B"] --> C2["C"]
    B2 --> D2["D"]
    style C2 fill:#d4edda,stroke:#28a745
    style D2 fill:#d4edda,stroke:#28a745
  end
```

### 保存を意味のあるチェックポイントとして扱う

キーストロークごとに履歴を残すとノイズが増えます。vscode-undotree は **ファイル保存を主な履歴単位** にすることで、意味のある編集状態を追いやすくしています。

```mermaid
sequenceDiagram
  actor User
  participant Editor
  participant UndoTree

  User->>Editor: 編集
  Editor->>UndoTree: changeEvent を蓄積
  User->>Editor: 保存
  Editor->>UndoTree: ノード確定
```

### ハイブリッドストレージ

```mermaid
flowchart TD
  save["保存イベント"] --> same{"現在内容と同じ?"}
  same -->|Yes| skip["スキップ"]
  same -->|No| ratio{"大きい変更または分岐点?"}
  ratio -->|Yes| full["full snapshot を保存"]
  ratio -->|No| delta["delta のみ保存"]
```

コンパクション上は、ノードはさらに `insert`、`delete`、`mixed` に分類されます。

- `insert`: 挿入だけを含む delta ノード
- `delete`: 削除だけを含む delta ノード
- `mixed`: full snapshot ノード、または挿入と削除を両方含む delta ノード

分岐点は full snapshot に昇格し、各ブランチを安全に復元できるようにしています。

### 任意ノードの復元

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

  N4 --> step1["最近傍の full ノードまで遡る"]
  step1 --> step2["full 内容を読む"]
  step2 --> step3["delta を順に適用"]
  step3 --> result["内容を復元"]
```

### 永続化と再オープン復元

永続化された tree はファイル単位で保存されます。tracked ファイルを再度開くと、そのファイルの保存済み tree だけをオンデマンドで読み込みます。保存済み current ノードと実ファイル内容が異なる場合は、実ファイル状態を反映するために `restore` ノードを追加します。

### VS Code ネイティブ undo との共存

vscode-undotree は VS Code 組み込みの undo スタックと並行して動作します。ネイティブ undo を置き換えたり、割り込んだりはしません。保存チェックポイント間を移動するための独立したレイヤーです。

## 要件

- VS Code 1.90.0 以上

## ライセンス

MIT
