import { useState, useEffect } from "react";
import { SettingsGuide } from "./SettingsGuide.jsx";
import { LanguageMenu } from "./LanguageMenu.jsx";
import { LegalPage } from "./LegalPage.jsx";
import { FeatureDemos } from "./FeatureDemos.jsx";
const repo = "https://github.com/mmiyaji/vscode-undotree";
const marketplace =
  "https://marketplace.visualstudio.com/items?itemName=mmiyaji.vscode-undotree";
const copy = {
  ja: {
    nav: ["機能", "使い方", "インストール"],
    intro:
      "保存時の状態を記録し、分岐した履歴をVS Codeのサイドバーから確認できます。",
    download: "拡張機能ストアで開く",
    requirement: "VS Code 1.90.0以上 · MITライセンス",
    mechanism: "保存による分岐履歴のしくみ",
    paragraphs: [
      "保存をチェックポイントとして状態を記録します。過去の状態に戻って編集・保存すると、そこから新しい分岐が作られます。",
      "戻る前の履歴も別の枝として残るため、あとから比較したり、別の方針を検討したりできます。",
    ],
    coexist:
      "VS Code標準のUndo / Redoと共存します。日常の取り消し・やり直しは、そのまま利用できます。",
    storageTitle: "履歴データの保存方法と復元のしくみ",
    storageDetails: [
      "履歴の各状態を毎回ファイル全体として保持するのではなく、小さな編集は直前の状態に対する差分として記録します。変更が大きい場合や差分を安全に使えない場合は、全内容を記録します。",
      "分岐点などには全内容を保持し、そこから各枝の差分をたどって目的の状態を復元します。差分の連鎖を分岐点で区切ることで、履歴全体を毎回最初から再生する負担を抑える設計です。",
      "大きな全内容は設定に応じて圧縮や別ファイルへの保存を行い、必要になったときに読み込みます。差分と全量の使い分けにより、履歴の保存量と過去の状態を取り出す処理のバランスを取ります。履歴が増えるほど保存容量や処理時間は増えるため、必要に応じて履歴を整理できます。",
    ],
    diff: "差分を比較する",
    diffText:
      "任意の保存状態と現在の内容を、VS Codeの差分エディターで比較できます。",
    pair: "Pair Diffでは2つのチェックポイントを選び、変更内容を確認できます。",
    pin: "メモとピン留め",
    pinText: "チェックポイントにメモを残して、変更の目的や内容を記録できます。",
    pinMore: "重要な状態はピンで固定し、あとから見つけやすくできます。",
    read: "操作方法を読む",
    installText: "Visual Studio MarketplaceからVS Codeにインストールできます。",
    steps: [
      <>
        <a href={marketplace}>拡張機能ストアのUndoTree History</a>を開きます。
      </>,
      <>
        ストアの<code>Install</code>を選択し、VS Codeで開きます。
      </>,
      <>
        VS Codeで発行元が<code>mmiyaji</code>
        であることを確認し、インストールします。
      </>,
    ],
    editor:
      "VS Codeの左下に表示されたUndo Treeの分岐履歴。",
    diffAlt: "VS Codeの差分エディターによる保存状態の比較",
    pinAlt: "メモ付きのチェックポイントとピン留め一覧",
    branchAlt: "保存3から新しい枝に分岐し、元の保存4・5も残る履歴の図",
  },
  en: {
    nav: ["Features", "How it works", "Installation"],
    intro:
      "Record saved states and explore branching history in the VS Code sidebar.",
    download: "Open in Marketplace",
    requirement: "VS Code 1.90.0 or later · MIT license",
    mechanism: "How saved history branches",
    paragraphs: [
      "Saving a file records a checkpoint. Return to an earlier state, edit, and save to create a new branch.",
      "The previous branch remains available, so you can compare changes or revisit another approach.",
    ],
    coexist:
      "Works alongside native VS Code Undo / Redo. Your everyday undo and redo commands remain available.",
    storageTitle: "How history is stored and reconstructed",
    storageDetails: [
      "Instead of retaining the entire file for every state, small edits are recorded as changes from the preceding state. Large changes or cases where changes cannot safely be used are stored as full content.",
      "Full content is retained at points such as forks, and each branch's changes are applied from there to reconstruct a requested state. These checkpoints limit how far reconstruction must go back through the change chain.",
      "Depending on settings, large full snapshots can be compressed or stored separately and loaded when needed. Combining changes and full snapshots balances storage use with the work needed to retrieve earlier states. History size and processing time can still grow; history can be compacted when needed.",
    ],
    diff: "Compare changes",
    diffText:
      "Compare a saved state with your current content in the VS Code diff editor.",
    pair: "Use Pair Diff to select two checkpoints and compare their contents.",
    pin: "Notes and pins",
    pinText: "Add notes to checkpoints to record the purpose of a change.",
    pinMore: "Pin important states to find them again later.",
    read: "Read the usage guide",
    installText:
      "Install the extension in VS Code from Visual Studio Marketplace.",
    steps: [
      <>
        Open <a href={marketplace}>UndoTree History in the Marketplace</a>.
      </>,
      <>
        Select <code>Install</code> and open the extension in VS Code.
      </>,
      <>
        Confirm the publisher is <code>mmiyaji</code> and install the extension
        in VS Code.
      </>,
    ],
    editor:
      "VS Code with branching Undo Tree history in the lower left sidebar.",
    diffAlt: "Saved states compared in the VS Code diff editor",
    pinAlt: "Pinned checkpoints and checkpoint notes",
    branchAlt:
      "A new branch after Save 3 preserves the original Save 4 and Save 5 checkpoints.",
  },
};
export function App() {
  const [lang, setLang] = useState(() =>
    localStorage.getItem("undotree-site-language") === "en" ? "en" : "ja",
  );
  const [theme, setTheme] = useState(
    () => (localStorage.getItem("undotree-site-theme-explicit") === "1" && localStorage.getItem("undotree-site-theme")) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
  const [active, setActive] = useState("overview");
  const t = copy[lang];
  const ja = lang === "ja";
  const path = window.location.pathname.replace(/\/$/, "");
  const legalPage = path === "/terms" ? "terms" : path === "/privacy" ? "privacy" : null;
  const home = legalPage ? "/" : "";
  const sections = [
    ["overview", ja ? "概要" : "Overview", "file-text"],
    ["how-it-works", ja ? "履歴ツリー" : "History tree", "git-merge"],
    ["features", ja ? "機能" : "Features", "diff"],
    ["demos", ja ? "画面で見る使い方" : "Using the extension", "device-camera"],
    ["settings", ja ? "設定ガイド" : "Settings", "settings-gear"],
    ["keyboard", ja ? "キーボード操作" : "Keyboard", "keyboard"],
    ["install", t.nav[2], "cloud-download"],
  ];
  useEffect(() => {
    document.documentElement.lang = lang;
    localStorage.setItem("undotree-site-language", lang);
  }, [lang]);
  useEffect(() => {
    const title = legalPage === "terms" ? (ja ? "利用規約" : "Terms of Use") : (ja ? "プライバシーポリシー" : "Privacy Policy");
    document.title = legalPage ? `${title} | vscode-undotree` : "vscode-undotree — VS Code 拡張機能";
    document.querySelector('link[rel="canonical"]')?.setAttribute("href", `https://undotree.ruhenheim.org/${legalPage || ""}`);
  }, [legalPage, ja]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (event) => {
      if (localStorage.getItem("undotree-site-theme-explicit") !== "1") setTheme(event.matches ? "dark" : "light");
    };
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const initialSection = window.location.hash.slice(1);
    if (initialSection && !legalPage) {
      document.getElementById(initialSection)?.scrollIntoView();
    }
    const update = () => {
      let current = "overview";
      for (const [id] of sections) {
        if (document.getElementById(id)?.getBoundingClientRect().top <= 150)
          current = id;
      }
      if (
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 4
      )
        current = "install";
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  const shortcuts = ja
    ? [
        ["Undo Treeにフォーカス", "Ctrl + Shift + U"],
        ["上 / 下のノードへ移動", "↑ / ↓"],
        ["選択したノードへ移動", "Enter"],
        ["Navigate / Diffを切り替え", "d"],
        ["ショートカット一覧を表示", "?"],
      ]
    : [
        ["Focus Undo Tree", "Ctrl + Shift + U"],
        ["Move to previous / next node", "↑ / ↓"],
        ["Jump to selected node", "Enter"],
        ["Switch Navigate / Diff mode", "d"],
        ["Show keyboard shortcuts", "?"],
      ];
  return (
    <>
      <a className="skip" href="#main">
        {ja ? "本文へ移動" : "Skip to content"}
      </a>
      <aside className="sidebar">
        <a className="sidebar-brand" href={`${home}#overview`}>
          <img src="/assets/icon.png" alt="" width="76" height="76" />
          <span>vscode-undotree</span>
        </a>
        <nav aria-label={ja ? "目次" : "Contents"}>
          {sections.map(([id, label, icon]) => (
            <a
              href={`${home}#${id}`}
              key={id}
              aria-current={!legalPage && active === id ? "location" : undefined}
            >
              <i className={`codicon codicon-${icon}`} aria-hidden="true" />
              {label}
            </a>
          ))}
        </nav>
        <a className="sidebar-source" href={repo}>
          <i className="codicon codicon-github" aria-hidden="true" />
          GitHub
        </a>
      </aside>
      <div className="document">
        <header className="topbar">
          <a className="wordmark" href={`${home}#overview`}>
            vscode-undotree
          </a>
          <nav aria-label={ja ? "メインナビゲーション" : "Main navigation"}>
            <a href={`${home}#features`}>{t.nav[0]}</a>
            <a href={`${home}#how-it-works`}>{t.nav[1]}</a>
            <a href={`${home}#install`}>{t.nav[2]}</a>
          </nav>
          <div className="preferences">
            <LanguageMenu value={lang} onChange={setLang} />
            <button
              className="theme-toggle"
              type="button"
              aria-label={
                theme === "dark"
                  ? ja
                    ? "ライトモードに切り替え"
                    : "Switch to light mode"
                  : ja
                    ? "ダークモードに切り替え"
                    : "Switch to dark mode"
              }
              title={
                theme === "dark"
                  ? ja
                    ? "ライトモード"
                    : "Light mode"
                  : ja
                    ? "ダークモード"
                    : "Dark mode"
              }
              onClick={() => {
                const next = theme === "dark" ? "light" : "dark";
                localStorage.setItem("undotree-site-theme", next);
                localStorage.setItem("undotree-site-theme-explicit", "1");
                setTheme(next);
              }}
            >
              <i className="codicon codicon-color-mode" aria-hidden="true" />
            </button>
          </div>
        </header>
        <main id="main" className="content">
          {legalPage ? <LegalPage page={legalPage} lang={lang} /> : <>
          <section className="overview" id="overview" aria-labelledby="title">
            <h1 id="title">vscode-undotree</h1>
            <p className="intro">{t.intro}</p>
            <div className="actions">
              <a className="button primary" href={marketplace}>
                <i
                  className="codicon codicon-cloud-download"
                  aria-hidden="true"
                />
                {t.download}
              </a>
              <a className="button" href={repo}>
                <i className="codicon codicon-github" aria-hidden="true" />
                GitHub
              </a>
            </div>
            <figure className="editor-shot">
              <img
                src="./assets/history-current.png"
                alt={t.editor}
                width="903"
                height="439"
              />
            </figure>
            <p className="meta">{t.requirement}</p>
          </section>
          <section
            className="section"
            id="how-it-works"
            aria-labelledby="mechanism-title"
          >
            <h2 id="mechanism-title">{t.mechanism}</h2>
            <figure className="branch-figure">
              <img
                src={
                  ja
                    ? "./assets/branch-history.png"
                    : "./assets/branch-history-en.png"
                }
                alt={t.branchAlt}
                width="2038"
                height="771"
              />
            </figure>
            <div className="branch-description">
              {t.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
            <p className="note">{t.coexist}</p>
            <details className="settings-example history-storage">
              <summary>{t.storageTitle}</summary>
              {t.storageDetails.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </details>
          </section>
          <section
            className="section"
            id="features"
            aria-labelledby="features-title"
          >
            <h2 id="features-title">{t.nav[0]}</h2>
            <dl className="feature-list">
              <div>
                <dt>
                  <i className="codicon codicon-git-merge" aria-hidden="true" />
                  {ja ? "分岐を残す" : "Keep branches"}
                </dt>
                <dd>{t.paragraphs[1]}</dd>
              </div>
              <div>
                <dt>
                  <i className="codicon codicon-diff" aria-hidden="true" />
                  {t.diff}
                </dt>
                <dd>
                  {t.diffText} {t.pair}
                </dd>
              </div>
              <div>
                <dt>
                  <i className="codicon codicon-pin" aria-hidden="true" />
                  {t.pin}
                </dt>
                <dd>
                  {t.pinText} {t.pinMore}
                </dd>
              </div>
            </dl>
            <a
              className="text-link"
              href={`${repo}/blob/main/${ja ? "README_ja.md" : "README.md"}`}
            >
              {t.read}
              <i className="codicon codicon-link-external" aria-hidden="true" />
            </a>
          </section>
          <FeatureDemos lang={lang} />
          <SettingsGuide lang={lang} />
          <section
            className="section"
            id="keyboard"
            aria-labelledby="keyboard-title"
          >
            <h2 id="keyboard-title">
              {ja ? "キーボード操作" : "Keyboard shortcuts"}
            </h2>
            <p className="note">
              {ja
                ? "Ctrl + Shift + Uでパネルにフォーカスします。以降のキーはUndo Treeパネル内で使えます。"
                : "Focus the panel with Ctrl + Shift + U. The remaining shortcuts work inside the Undo Tree panel."}
            </p>
            <table>
              <thead>
                <tr>
                  <th scope="col">{ja ? "操作" : "Action"}</th>
                  <th scope="col">{ja ? "ショートカット" : "Shortcut"}</th>
                </tr>
              </thead>
              <tbody>
                {shortcuts.map(([action, key]) => (
                  <tr key={key}>
                    <td>{action}</td>
                    <td>
                      <kbd>{key}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section
            className="section install"
            id="install"
            aria-labelledby="install-title"
          >
            <h2 id="install-title">{t.nav[2]}</h2>
            <p>{t.installText}</p>
            <ol>
              {t.steps.map((step, i) => (
                <li key={i}>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </section>
          </>}
        </main>
        <footer className="footer">
          <a href={`${home}#overview`}>vscode-undotree</a>
          <div className="footer-links">
            <a href="/terms">{ja ? "利用規約" : "Terms of Use"}</a>
            <a href="/privacy">{ja ? "プライバシーポリシー" : "Privacy Policy"}</a>
            <a href={`${repo}/blob/main/LICENSE`}>MIT</a>
            <a href={repo}>GitHub</a>
            <a href="https://ruhenheim.org/">
              {ja ? "作者サイト" : "Author website"} · ruhenheim.org
            </a>
          </div>
        </footer>
      </div>
    </>
  );
}
