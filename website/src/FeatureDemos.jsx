const copy = {
  ja: {
    title: "画面で見る使い方",
    diffTitle: "保存した状態と、今の内容を比較する",
    diffText: "戻す前に、どこが変わったか確認したいときに使います。Undo TreeのDiffモードから履歴を選ぶと、VS Codeの差分エディターで変更箇所を確認できます。",
    diffSteps: ["Undo TreeをDiffモードに切り替える", "「現在と比較」で保存状態を選ぶ", "差分を確認してから、戻す状態を決める"],
    diffCaption: "商品カードを作るTypeScriptコードの変更前後。在庫切れの除外、価格順の並び替え、日本円の価格表示を追加しています。削除は赤、追加は緑です。",
    diffAlt: "products.tsの保存履歴を現在と比較したVS Code画面。変更後にstockでの絞り込み、価格順のsort、Intl.NumberFormatによる円表示が追加されている",
    pairTitle: "過去の2つの状態も比較できます",
    pairText: "「ノード間比較（Pair Diff）」では比較元と比較先のチェックポイントを選びます。別の枝に残した案を比べるときにも使えます。現在のファイルを書き換えずに比較できます。",
    pinTitle: "確認済みの状態に、メモとピンを付ける",
    pinText: "動作を確認できた時点や、別の案に進む前の状態にメモを残します。ピン留めしたチェックポイントは一覧にまとまり、保存を重ねたあとも見つけやすくなります。",
    pinSteps: ["チェックポイントに目的や確認結果をメモする", "戻りたい状態をピン留めする", "ピン一覧から対象の履歴を探す"],
    pinCaption: "「在庫・価格順・円表示を追加」のチェックポイントをピン留めした実画面。「商品カードの基本表示」の履歴も残っています。",
    pinAlt: "商品一覧のTypeScriptコードとUndo Tree。ピン一覧に在庫・価格順・円表示を追加というメモ付きのチェックポイントが表示されている",
    full: "画像を拡大して見る",
  },
  en: {
    title: "Using the extension",
    diffTitle: "Compare a saved state with your current content",
    diffText: "Check what changed before restoring a file. Select a checkpoint in Undo Tree’s Diff mode to inspect changes in the VS Code diff editor.",
    diffSteps: ["Switch Undo Tree to Diff mode", "Choose a checkpoint under vs Current", "Review the diff before choosing a state to restore"],
    diffCaption: "Before and after a TypeScript product-card change: exclude out-of-stock products, sort by price, and format prices in Japanese yen. Deletions are red; additions are green.",
    diffAlt: "VS Code comparing a saved products.ts checkpoint with current content, adding a stock filter, price sort, and yen formatting with Intl.NumberFormat",
    pairTitle: "Compare two earlier states, too",
    pairText: "In Pair Diff, choose a base checkpoint and a target checkpoint. This also lets you compare approaches kept on different branches, without changing the current file.",
    pinTitle: "Add notes and pins to reviewed states",
    pinText: "Leave a note when you finish checking a change or before trying another approach. Pinned checkpoints appear in a separate list so you can find them after more saves.",
    pinSteps: ["Note a checkpoint’s purpose or review result", "Pin a state you want to return to", "Find that checkpoint in the pinned list"],
    pinCaption: "The “Stock, price & JPY” checkpoint is pinned. The earlier “Basic product cards” checkpoint remains in history.",
    pinAlt: "TypeScript product-list code alongside Undo Tree, with a pinned checkpoint for stock filtering, price sorting, and yen formatting",
    full: "View full-size screenshot",
  },
};

export function FeatureDemos({ lang }) {
  const t = copy[lang];
  const suffix = lang === "en" ? "-en" : "";
  const diffImage = `/assets/products-diff${suffix}.jpg`;
  const pinImage = `/assets/products-pins${suffix}.jpg`;
  return (
    <section className="section feature-demos" id="demos" aria-labelledby="demos-title">
      <h2 id="demos-title">{t.title}</h2>
      <article className="feature-demo" aria-labelledby="diff-demo-title">
        <h3 id="diff-demo-title">{t.diffTitle}</h3>
        <p>{t.diffText}</p>
        <ol className="demo-steps">{t.diffSteps.map(step => <li key={step}>{step}</li>)}</ol>
        <figure>
          <a className="demo-image-link" href={diffImage} aria-label={`${t.full} — Diff`}>
            <img src={diffImage} alt={t.diffAlt} width="1442" height="601" loading="lazy" decoding="async" />
          </a>
          <figcaption>{t.diffCaption} <a href={diffImage}>{t.full}</a></figcaption>
        </figure>
        <aside className="demo-detail" aria-labelledby="pair-demo-title">
          <h4 id="pair-demo-title">{t.pairTitle}</h4>
          <p>{t.pairText}</p>
        </aside>
      </article>
      <article className="feature-demo" aria-labelledby="pin-demo-title">
        <h3 id="pin-demo-title">{t.pinTitle}</h3>
        <p>{t.pinText}</p>
        <ol className="demo-steps">{t.pinSteps.map(step => <li key={step}>{step}</li>)}</ol>
        <figure>
          <a className="demo-image-link" href={pinImage} aria-label={`${t.full} — ${lang === "ja" ? "ピン留め" : "Pins"}`}>
            <img src={pinImage} alt={t.pinAlt} width="1442" height="601" loading="lazy" decoding="async" />
          </a>
          <figcaption>{t.pinCaption} <a href={pinImage}>{t.full}</a></figcaption>
        </figure>
      </article>
    </section>
  );
}
