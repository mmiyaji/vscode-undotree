const repo = "https://github.com/mmiyaji/vscode-undotree";

const content = {
  terms: {
    ja: {
      title: "利用規約",
      intro: "vscode-undotree の利用条件について説明します。提供者は mmiyaji です。",
      sections: [
        ["ライセンス", "拡張機能はMITライセンスで提供しています。商用利用、変更、再配布を含む利用条件は、リポジトリのLICENSE原文に従います。このページはその案内であり、MITライセンスによる権利を制限したり、追加の利用条件を課したりするものではありません。"],
        ["保証と責任", "MITライセンスに定めるとおり、適用法で認められる範囲で、動作や特定の用途への適合性について保証はなく、作者は利用に伴う損害について責任を負いません。詳細と適用範囲はLICENSE原文をご確認ください。"],
        ["履歴とバックアップ", "履歴の欠落や破損、設定や操作による削除が起こる場合があります。重要なファイルにはGitや別のバックアップを併用してください。履歴を復元すると現在のファイル内容が変更されます。"],
        ["データの取り扱い", "履歴には過去の内容や未保存の編集内容が含まれることがあります。追跡対象と保存設定を確認し、機密情報を含むファイルは必要に応じて追跡対象から除外してください。詳しくはプライバシーポリシーをご覧ください。"],
        ["外部サービスと変更", "Visual Studio Marketplace、GitHub、作者サイトなどの外部サービスには、それぞれの利用条件が適用されます。機能やこの案内を変更した場合は、リポジトリまたはこのサイトでお知らせします。"],
      ],
    },
    en: {
      title: "Terms of Use",
      intro: "These terms explain the use of vscode-undotree, provided by mmiyaji.",
      sections: [
        ["License", "The extension is distributed under the MIT License. The repository’s LICENSE governs use, including commercial use, modification, and redistribution. This page explains those terms; it does not restrict rights granted by the MIT License or add license conditions."],
        ["Warranty and liability", "Under the MIT License, and to the extent permitted by applicable law, the software carries no warranty of operation or suitability for a particular purpose, and the author is not liable for damages arising from its use. See the original LICENSE for the full terms and scope."],
        ["History and backups", "History may be incomplete, become corrupted, or be deleted through settings or actions. Use Git or another backup for important files. Restoring history changes the current file contents."],
        ["Data handling", "History may include previous contents and unsaved edits. Review your tracking and storage settings, and exclude files containing sensitive information as needed. See the Privacy Policy for details."],
        ["External services and changes", "External services such as Visual Studio Marketplace, GitHub, and the author’s website have their own terms. Changes to features or this information will be communicated through the repository or this website."],
      ],
    },
  },
  privacy: {
    ja: {
      title: "プライバシーポリシー",
      intro: "vscode-undotree と、その紹介サイトで扱う情報について説明します。提供者は mmiyaji です。",
      sections: [
        ["拡張機能が扱う情報", "分岐履歴の記録・比較・復元のため、追跡対象ファイルの内容、ファイルのURIやパス、変更差分、記録日時、分岐やピンなどの履歴情報を扱います。定期チェックポイントには、ファイルに保存する前の編集内容も含まれることがあります。"],
        ["保存先と外部送信", "履歴はVS Codeの拡張機能ホストのメモリ上で処理し、既定の自動永続化モードでは拡張機能用のストレージ（globalStorage）にも保存します。通常は利用中のPC上に保存しますが、リモート環境では拡張機能が動作するホスト側に保存される場合があります。拡張機能自身が履歴やファイル内容を作者のサーバーへ送信する処理や、利用状況を収集するテレメトリー処理は実装していません。"],
        ["機密情報の取り扱い", "過去に記録した秘密情報は、元のファイルを修正・削除しても履歴に残る場合があります。保存データの圧縮は暗号化ではありません。追跡対象からの除外、追跡の停止、既存履歴の削除を必要に応じて行ってください。除外や追跡停止だけでは、記録済みの履歴は削除されません。"],
        ["保存期間と削除", "永続化した履歴はVS Codeの再起動後も残り、既定では期限による自動削除は行いません。現在のワークスペースの履歴を削除するにはUndo Treeの「Reset All State」を使います。複数のワークスペースを利用している場合は、それぞれで確認してください。拡張機能をアンインストールするだけで保存済みデータが削除されるとは限りません。"],
        ["このサイトの表示設定", "このサイトは選択した言語とテーマをブラウザーのlocalStorageに保存します。キーは undotree-site-language、undotree-site-theme、undotree-site-theme-explicit です。ブラウザーのサイトデータ削除機能で消去できます。サイトのコードには広告やアクセス解析用のスクリプトを組み込んでいません。"],
        ["サイト配信と外部リンク", "このサイトはCloudflareで配信しています。配信やセキュリティ確保のため、IPアドレスやリクエスト情報がCloudflareによって処理される場合があります。詳細は同社のプライバシーポリシーをご確認ください。GitHub、Visual Studio Marketplace、作者サイトへの移動後は、各サイトのポリシーが適用されます。"],
        ["お問い合わせと変更", "お問い合わせはGitHub Issuesで受け付けています。Issueは公開されるため、ファイル本文、秘密情報、個人情報を投稿しないでください。情報の取り扱いを変更した場合は、このページを更新します。"],
      ],
    },
    en: {
      title: "Privacy Policy",
      intro: "This policy describes information handled by vscode-undotree and its website, provided by mmiyaji.",
      sections: [
        ["Information handled by the extension", "To record, compare, and restore branching history, the extension handles tracked file contents, file URIs or paths, change diffs, recording times, and history information such as branches and pins. Periodic checkpoints may include edits that have not yet been saved to the file."],
        ["Storage and transmission", "History is processed in the VS Code extension host’s memory. The default automatic persistence mode also saves it to extension storage (globalStorage). This is normally on your PC; in remote environments it may be on the host running the extension. The extension itself implements neither transmission of history or file contents to the author’s servers nor usage telemetry collection."],
        ["Sensitive information", "Previously recorded secrets may remain in history even after the original file is changed or deleted. Compression of stored data is not encryption. Exclude files, stop tracking, or delete existing history as needed. Excluding a file or stopping tracking does not delete its previously recorded history."],
        ["Retention and deletion", "Persisted history survives VS Code restarts and does not expire automatically by default. Use Undo Tree’s “Reset All State” to delete history for the current workspace. If you use multiple workspaces, check each one. Uninstalling the extension alone may not remove stored data."],
        ["Website preferences", "This website stores your selected language and theme in your browser’s localStorage, under undotree-site-language, undotree-site-theme, and undotree-site-theme-explicit. You can remove them by clearing the site’s browser data. The website’s code includes no advertising or analytics scripts."],
        ["Hosting and external links", "Cloudflare delivers this website. Cloudflare may process IP addresses and request information to deliver and secure it; see its Privacy Policy for details. After you follow links to GitHub, Visual Studio Marketplace, or the author’s website, their respective policies apply."],
        ["Contact and updates", "Contact the author through GitHub Issues. Issues are public, so do not post file contents, secrets, or personal information. This page will be updated when information handling changes."],
      ],
    },
  },
};

export function LegalPage({ page, lang }) {
  const ja = lang === "ja";
  const text = content[page][lang];
  return (
    <article className="legal-page" aria-labelledby="legal-title">
      <a className="legal-back" href="/">← {ja ? "紹介ページに戻る" : "Back to overview"}</a>
      <h1 id="legal-title">{text.title}</h1>
      <p className="meta">{ja ? "最終更新日：2026年11月15日" : "Last updated: November 15, 2026"}</p>
      <p>{text.intro}</p>
      {text.sections.map(([heading, body]) => (
        <section key={heading}>
          <h2>{heading}</h2>
          <p>{body}</p>
        </section>
      ))}
      <nav className="legal-references" aria-label={ja ? "関連リンク" : "Related links"}>
        <a href={`${repo}/blob/main/LICENSE`}>{ja ? "MITライセンス原文" : "MIT License"}</a>
        <a href={page === "terms" ? "/privacy" : "/terms"}>
          {page === "terms" ? (ja ? "プライバシーポリシー" : "Privacy Policy") : (ja ? "利用規約" : "Terms of Use")}
        </a>
        {page === "privacy" && <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare Privacy Policy</a>}
        <a href={`${repo}/issues`}>{ja ? "お問い合わせ（GitHub Issues）" : "Contact (GitHub Issues)"}</a>
      </nav>
    </article>
  );
}
