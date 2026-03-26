# vscode-undotree

VS Code 上で、保存を単位にした Undo 履歴をツリーとして可視化する拡張です。

[English README](./README.md)

## 概要

通常の直線的な undo/redo とは異なり、**vscode-undotree** は分岐を保持します。過去の地点へ戻って編集を続けても、それまでの未来は別の分岐として残ります。

履歴は主にファイル保存時と定期 autosave チェックポイントで記録されます。VS Code 標準の undo スタックを置き換えるのではなく、意味のある保存状態をたどるための別レイヤーとして動作します。

![Undo Tree パネル](./media/undotree.png)

## カラーテーマ

`undotree.colorTheme` でサイドバーのアクセントカラーを切り替えられます。既定値は `blue` で、`neutral`、`green`、`amber`、`teal`、`violet`、`rose`、`red` も選べます。

![Undo Tree color themes](./media/undotree-color-themes.png)

## 主な機能

- 分岐を保持するツリー型履歴
- 保存時チェックポイントと定期 autosave チェックポイント
- サイドバー上での履歴移動とキーボード操作
- 現在の文書との差分、または任意ノード同士の差分表示
- ノードメモとピン留め
- 行数またはバイト数メトリクスと、親ノード基準の差分表示
- 相対時刻表示
- セッションをまたぐ手動 / 自動永続化
- Compact / Hard Compact と、そのプレビュー、検証、手動 Keep / Remove
- Diagnostics 画面による persisted storage、manifest、lock、孤立ファイルの確認
- `auto` 永続化時のマルチウィンドウ競合警告
- 圧縮、checkpoint ファイル、lazy load を使った永続化
- persisted 済みの clean tree をアイドル時にアンロードする省メモリ動作
- サイドバー UI の実行時言語切替 (`auto` / `en` / `ja`)
- ファイルの rename / move 後も履歴を引き継ぐ動作

## インストール

この拡張は `.vsix` 形式で [GitHub Releases](https://github.com/mmiyaji/vscode-undotree/releases) から配布しています。

1. [Releases](https://github.com/mmiyaji/vscode-undotree/releases) から最新の `.vsix` をダウンロードします。
2. VS Code を開きます。
3. コマンドパレットから `Extensions: Install from VSIX...` を実行します。
4. ダウンロードした `.vsix` を選択します。

## 使い方

| 操作 | 方法 |
|------|------|
| Undo Tree パネルを開く | Explorer -> **Undo Tree** |
| パネルへフォーカス | `Ctrl+Shift+U` |
| チェックポイント作成 | ファイルを保存 |
| Undo / Redo | **Undo** / **Redo** ボタン |
| ノードへ移動 | ノード行をクリック |
| 現在内容との差分を見る | **Diff** モードにしてノードを選択 |
| ノード同士を比較する | **Diff** -> **Pair Diff** -> 基準ノード選択 -> 比較ノード選択 |
| 一時停止 / 再開 | **Pause** / **Resume** |
| アクションメニューを開く | ギアボタン |
| 現在拡張子の追跡 ON/OFF | ステータスバー項目 |

### パネル構成

サイドバーには保存履歴のツリーが表示されます。ハイライトされた行が現在位置です。オプションで次の情報を表示できます。

- タイムスタンプ
- ストレージ種別バッジ (`F` / `D`)
- 行数差分またはバイト差分
- メモ
- ピン留め

### ステータスバー

ステータスバー項目は、現在のファイルに対する追跡状態を表示します。

| 表示 | 意味 |
|------|------|
| `$(history) Undo Tree: ON` | 現在の拡張子は追跡対象 |
| `$(circle-slash) Undo Tree: OFF` | 現在の拡張子は追跡対象外 |
| `$(debug-pause) Undo Tree: PAUSED` | 履歴記録をグローバルに一時停止中 |

### キーボード操作

Undo Tree パネルにフォーカスがあるとき:

| キー | 操作 |
|------|------|
| `Up` / `k` | 上へ移動 |
| `Down` / `j` | 下へ移動 |
| `Left` | 親へ移動 |
| `Right` | 最後の子へ移動 |
| `Tab` / `Shift+Tab` | 次 / 前の兄弟へ移動 |
| `Home` / `End` | 最初 / 最後のノードへ移動 |
| `Enter` / `Space` | フォーカス中のノードへ移動 |
| `d` | Navigate / Diff モード切替 |
| `b` | Pair Diff の基準ノード設定 |
| `c` | `vs Current` に戻る |
| `p` | Pause / Resume 切替 |
| `n` / `N` | 次 / 前のメモ付きノードへ移動 |
| `?` | ショートカット一覧オーバーレイ表示 |

### 右クリックメニュー

ノードを右クリックすると、次の操作が出ます。

- `Jump`
- `Compare with Current`
- `Set Pair Diff Base`
- `Pin / Unpin`
- `Edit Note`
- `Display Settings`

### アクションメニュー

アクションメニューには次が含まれます。

- `Open Settings`
- `Save Persisted State`
- `Restore Persisted State`
- `Compact History`
- `Compact History Preview`
- `Hard Compact`
- `Hard Compact Preview`
- `Pause Tracking` / `Resume Tracking`
- `Toggle Tracking for This Extension`
- `Reset All State`

## 永続化

永続化された履歴はワークスペースではなく、拡張の storage ディレクトリに保存されます。

ファイルごとに次のように分かれて保存されます。

- `undo-trees/manifest.json`
- `undo-trees/manifest.json.bak`
- `undo-trees/<file-hash>.json`
- `undo-trees/content/<hash>`（大きい checkpoint content）

動作:

- `Save Persisted State` は現在の tracked tree をディスクへ保存します
- `Restore Persisted State` はアクティブファイルの保存済み tree を読み戻します
- tracked file を開くと、必要時に保存済み tree をオンデマンドで読み込みます
- ファイル内容が保存済み current node と異なる場合は、新しい `restore` ノードを追加します
- root だけで履歴がまだ伸びていない tree は保存されません
- `manifest.json` が読めない場合は `manifest.json.bak` をフォールバックとして使います
- interrupted write で 0 バイトファイルが残らないよう、一時ファイル経由で書き込みます
- persisted tree の topology が壊れていても、可能な範囲で修復しながら読み込みます

## コンパクション

`Compact History` は、長い直列チェーンの途中ノードを整理してノイズを減らします。

現在のルール:

- 直列チェーン中の単純な中間ノードは削除対象
- 分岐点は保持
- leaf ノードは保持
- current ノードは保持
- pinned ノードと noted ノードは保護
- `mixed` ノードは保持

`Hard Compact` では、`current` とは別に最新タイムスタンプのノードも保護します。

`mixed` は、純粋な insert-only / delete-only チェーンに属さないノードです。full snapshot ノードは `mixed` として扱われ、挿入と削除の両方を含む delta ノードも `mixed` として扱います。

```mermaid
graph LR
  subgraph "Before"
    A["full"] --> B["delta"] --> C["delta"] --> D["delta"] --> E["current"]
  end

  subgraph "After"
    A2["full"] --> C2["delta"] --> E2["current"]
  end

  E -.-> A2
```

### Compact Preview

プレビュー画面では次を確認できます。

- 削除候補ノード
- 保護ノード
- `ALL` ツリービュー
- 理由サマリ
- 手動 `Keep` / `Remove`
- 必要時の Diagnostics 連携による validation / cleanup

## Diagnostics

Undo Tree には persisted storage の保守用 Diagnostics 画面があります。開発モード、または `undotree.enableDiagnostics` が有効な場合に使えます。

表示できる主な情報:

- manifest 状態
- manifest backup 状態
- persisted tree / content file 数
- orphan tree / orphan content
- missing / unreadable tree file
- missing content hash
- multi-window lock 状態

主な操作:

- `Validate Persisted Storage`
- `Prune Orphan Files`
- `Rebuild Manifest`
- `Open Storage Folder`
- `Reset All State`

## rename / move 時の挙動

Undo Tree はファイルの rename / move を監視します。

- in-memory tree を旧 URI から新 URI へ移動
- persisted manifest と tree file 名も新 URI に更新
- rename 中は close/unload を一時抑止し、途中で履歴を失わないようにする

## マルチウィンドウ動作

persisted history は同じ extension storage フォルダを使うため、VS Code の複数ウィンドウ間で共有されます。

- 別ファイルを別ウィンドウで扱うのは概ね問題ありません
- 同じファイルを複数ウィンドウで扱うのは非推奨です
- `auto` 永続化時は、同じ tracked file が別ウィンドウで active になっていると警告できます
- この警告は heartbeat と TTL を使った best-effort lock で、厳密な排他制御ではありません

## 設定

アクションメニューの `Open Settings` から開くか、VS Code 設定で `@ext:mmiyaji.vscode-undotree` を検索してください。

### General

| 設定 | 既定値 | 説明 |
|------|--------|------|
| `undotree.enabledExtensions` | `[".txt", ".md"]` | 追跡対象の拡張子 |
| `undotree.excludePatterns` | `[]` | 除外するファイル名パターン |
| `undotree.persistenceMode` | `"manual"` | `manual` は明示保存のみ、`auto` は履歴更新後に自動保存 |
| `undotree.autosaveInterval` | `30` | autosave チェックポイント間隔（秒）。`0` で無効 |
| `undotree.hardCompactAfterDays` | `0` | `Hard Compact` の日数閾値。`0` で無効 |
| `undotree.warnOnMultiWindowConflict` | `true` | `auto` モードで、同じ tracked file が別ウィンドウで active のとき警告 |
| `undotree.language` | `"auto"` | 実行時 UI 言語。`auto` / `en` / `ja` |

### Display

| 設定 | 既定値 | 説明 |
|------|--------|------|
| `undotree.timeFormat` | `"time"` | `none` / `time` / `dateTime` / `relative` / `custom` |
| `undotree.timeFormatCustom` | `"yyyy-MM-dd HH:mm:ss"` | [date-fns format](https://date-fns.org/v4.1.0/docs/format) 互換。`timeFormat = custom` のときのみ使用 |
| `undotree.showStorageKind` | `false` | `F` / `D` バッジを表示 |
| `undotree.nodeSizeMetric` | `"lines"` | `none` / `lines` / `bytes` |
| `undotree.nodeSizeMetricBase` | `"parent"` | サイズ比較基準。`current` / `initial` / `parent` |
| `undotree.colorTheme` | `"blue"` | サイドバーのアクセントテーマ。`blue` / `neutral` / `green` / `amber` / `teal` / `violet` / `rose` / `red` |

### Performance

これらは主に高度な調整用です。理由がない限り既定値を推奨します。

| 設定 | 既定値 | 説明 |
|------|--------|------|
| `undotree.enableDiagnostics` | `false` | 開発モード以外でも Diagnostics 画面を有効化 |
| `undotree.compressionThresholdKB` | `100` | このサイズを超える persisted tree file を圧縮 |
| `undotree.checkpointThresholdKB` | `1000` | このサイズを超える full snapshot を checkpoint content に分離 |
| `undotree.memoryCheckpointThresholdKB` | `32` | 大きい branch snapshot を in-memory checkpoint 化する閾値。推奨値 `32` |
| `undotree.contentCacheMaxKB` | `20480` | checkpoint content の LRU cache サイズ |

## 設計思想

### 標準 undo との違い

標準 undo は、undo 後に編集すると元の未来を捨てます。

```mermaid
graph LR
  subgraph "Standard undo"
    A1["A"] --> B1["B"] --> C1["C"]
    B1 --> D1["D"]
    classDef lost fill:#ccc,color:#999,stroke:#ccc
    C1:::lost
  end
```

vscode-undotree は両方の分岐を保持します。

```mermaid
graph LR
  subgraph "vscode-undotree"
    A2["A"] --> B2["B"] --> C2["C"]
    B2 --> D2["D"]
    style C2 fill:#d4edda,stroke:#28a745
    style D2 fill:#d4edda,stroke:#28a745
  end
```

### 保存を主チェックポイントとする

すべてのキーストロークを主履歴にするのではなく、vscode-undotree は保存を意味のあるチェックポイントとして扱います。

```mermaid
sequenceDiagram
  actor User
  participant Editor
  participant UndoTree

  User->>Editor: 編集
  Editor->>UndoTree: バッファ変更イベント
  User->>Editor: 保存
  Editor->>UndoTree: ノード確定
```

### ハイブリッド保存形式

```mermaid
flowchart TD
  save["保存イベント"] --> same("current と同じ内容か？")
  same -->|Yes| skip["スキップ"]
  same -->|No| ratio("大きな変更または分岐点か？")
  ratio -->|Yes| full["full snapshot または checkpoint"]
  ratio -->|No| delta["delta のみ保存"]
```

### ネイティブ undo との共存

vscode-undotree は VS Code 標準の undo stack を置き換えません。保存状態を中心にした別のナビゲーションレイヤーとして共存します。

## 必要環境

- VS Code 1.90.0 以上

## ライセンス

MIT
