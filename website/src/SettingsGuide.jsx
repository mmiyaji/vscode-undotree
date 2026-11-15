const example = JSON.stringify(
  {
    "undotree.trackingMode": "listed",
    "undotree.enabledExtensions": [".ts", ".tsx", ".js", ".json", ".md"],
    "undotree.enabledFileNames": [
      "Dockerfile",
      "Makefile",
      "README",
      ".gitignore",
    ],
    "undotree.persistenceMode": "auto",
  },
  null,
  2,
);

export function SettingsGuide({ lang }) {
  const ja = lang === "ja";
  const tracking = [
    [
      "undotree.trackingMode",
      ja ? "追跡対象の選び方" : "Tracking scope",
      ja
        ? "既定のautoは未知の拡張子を含むテキスト全般を追跡します。既存の対象リストが明示されていれば尊重します。textはテキスト全般、listedは指定リストを使います。"
        : "The default auto mode tracks text files, including unknown extensions, while respecting explicit existing lists. Choose text for all text files or listed for selected extensions and names.",
    ],
    [
      "undotree.maxTrackedFileChars",
      ja ? "大きな文書の制限" : "Large document limit",
      ja
        ? "既定は100万UTF-16単位（UTF-16テキストで約2MB）。上限超過は記録しません。サイドバーでそのファイルを閉じるまで追跡するか、0で上限を解除できます。大きな文書は編集・保存が重くなる場合があります。"
        : "Defaults to one million UTF-16 code units (about 2 MB of UTF-16 text). Larger files are skipped. Track one until closed from the sidebar, or set 0 to remove the limit. Large files can slow editing and persistence.",
    ],
    [
      "undotree.enabledExtensions",
      ja ? "追跡する拡張子" : "Tracked extensions",
      ja
        ? "リスト方式で追跡する拡張子です。絞り込む場合は、.tsや.mdのように先頭のドットを含めて指定します。"
        : "Extensions used in list mode. To narrow the list, include the leading dot, for example .ts or .md.",
    ],
    [
      "undotree.enabledFileNames",
      ja ? "名前で追跡するファイル" : "Tracked file names",
      ja
        ? "DockerfileやMakefileなどをファイル名の完全一致で指定します。大文字・小文字は区別しません。"
        : "Track exact file names such as Dockerfile or Makefile. Matching is case-insensitive.",
    ],
    [
      "undotree.excludePatterns",
      ja ? "追跡から除外するファイル" : "Excluded files",
      ja
        ? "除外が常に優先されます。既定でnode_modules・ビルド出力・lockファイル・.envなどを除外します。独自に指定する場合は、既定の配列も含めて編集してください。例：generated/**、**/cache/**、*.min.*。"
        : "Exclusions always take priority. Defaults exclude node_modules, build output, lock files and .env files, among others. When customizing this array, retain the default entries you still need. Examples: generated/**, **/cache/** and *.min.*.",
    ],
  ];
  const other = [
    [
      "undotree.persistenceMode",
      "auto",
      ja
        ? "既定のautoは履歴を自動保存し、再起動後も利用できます。manualを明示した場合は「Save Persisted State」で保存します。"
        : "The default auto mode saves history for future sessions. An explicit manual setting is respected; use Save Persisted State in that mode.",
    ],
    [
      "undotree.autosaveInterval",
      "30",
      ja
        ? "編集中の状態を定期的に記録する間隔（秒）。0で定期記録を無効にします。ファイル保存時の記録は続きます。"
        : "Interval in seconds for periodic editing checkpoints. Set 0 to disable periodic checkpoints; file saves still record history.",
    ],
    [
      "undotree.colorTheme",
      "blue",
      ja
        ? "拡張のアクセントカラー。autoでVS Codeのテーマに合わせます。このWebページの配色設定とは別です。"
        : "The extension’s accent color. Use auto to follow the VS Code theme. This is separate from this website’s appearance setting.",
    ],
    [
      "undotree.language",
      "auto",
      ja
        ? "拡張の表示言語。autoはVS Codeに従い、ja・enで固定できます。このWebページの言語とは別です。"
        : "The extension’s UI language: auto follows VS Code; ja or en selects a fixed language. This is separate from the website’s language.",
    ],
  ];
  return (
    <section
      id="settings"
      className="section settings-guide"
      aria-labelledby="settings-title"
    >
      <h2 id="settings-title">{ja ? "設定ガイド" : "Settings guide"}</h2>
      <p>
        {ja ? (
          <>
            VS Codeの設定を開き、<code>@ext:mmiyaji.vscode-undotree</code>
            で検索します。プロジェクトごとに変える場合は「ワークスペース」を選びます。
          </>
        ) : (
          <>
            Open VS Code Settings and search for{" "}
            <code>@ext:mmiyaji.vscode-undotree</code>. Select the Workspace tab
            for project-specific settings.
          </>
        )}
      </p>
      <h3>{ja ? "追跡するファイルを選ぶ" : "Choose which files to track"}</h3>
      <dl className="settings-list">
        {tracking.map(([key, title, description]) => (
          <div key={key}>
            <dt>
              {title}
              <code>{key}</code>
            </dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      <p className="settings-callout">
        {ja ? (
          <>
            リスト方式では、拡張子の配列は既定値への追加ではなく、置き換えです。
            <code>enabledExtensions</code>
            を独自に指定すると、既定のファイル名の追跡も無効になります。名前でも追跡したい場合は
            <code>enabledFileNames</code>を一緒に指定します。
          </>
        ) : (
          <>
            In list mode, the extensions array replaces the defaults rather than extending
            them. Customizing <code>enabledExtensions</code> also disables
            default file-name tracking. Set <code>enabledFileNames</code>{" "}
            explicitly to keep tracking files by name.
          </>
        )}
      </p>
      <details className="settings-example">
        <summary>
          {ja
            ? "設定例を見る：Web開発用に絞り込む"
            : "Example: track a web development project"}
        </summary>
        <p>
          {ja ? (
            <>
              ワークスペースの<code>.vscode/settings.json</code>
              に、以下の設定を追加します。既存の設定がある場合は、各項目を組み込んでください。
            </>
          ) : (
            <>
              Add these entries to your workspace’s{" "}
              <code>.vscode/settings.json</code>. Merge them with any existing
              settings.
            </>
          )}
        </p>
        <pre>
          <code>{example}</code>
        </pre>
        <p className="note">
          {ja
            ? "この例では、列挙した拡張子とファイル名だけを追跡し、履歴を自動で保存します。除外設定は既定値のままです。"
            : "This example tracks only the listed extensions and file names, saves history automatically, and keeps the default exclusions."}
        </p>
      </details>
      <h3>{ja ? "ほかによく使う設定" : "Other useful settings"}</h3>
      <dl className="settings-list">
        {other.map(([key, value, description]) => (
          <div key={key}>
            <dt>
              <code>{key}</code>
              <span className="setting-default">
                {ja ? "既定値" : "Default"}: {value}
              </span>
            </dt>
            <dd>{description}</dd>
          </div>
        ))}
      </dl>
      <p className="note">
        {ja
          ? "設定を変更しても履歴が増えない場合は、ステータスバーのUndo TreeがONになっているか、一時停止中ではないかを確認し、対象ファイルを保存してください。"
          : "If no history appears after changing settings, check that Undo Tree is ON in the status bar and tracking is not paused, then save the target file."}
      </p>
    </section>
  );
}
