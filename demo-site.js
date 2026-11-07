// index.html 用の架空のサイト。拡張なしでは他サイトの中に content.js を入れられないので、
// ページをここで生成し、content.js ごと iframe に読み込ませて拡張版と同じ動きを試せるようにする。
(() => {
  const ORIGIN = 'https://demo.example';
  const NEWS_PAGES = 6;
  const NEWS_PER_PAGE = 8;

  const TOPICS = {
    sea: { name: '海', color: '#d7ecf7', text: '海は地球の表面の約7割を占めています。深い場所には、太陽の光が届かない世界が広がっています。', links: ['forest', 'sky', 'space'] },
    forest: { name: '森', color: '#dcf0d5', text: '森は多くの生き物のすみかです。木々は水を蓄え、周りの気候をおだやかにしています。', links: ['mountain', 'sea', 'sky'] },
    sky: { name: '空', color: '#e4e6fb', text: '空の色は、太陽の光が大気の中で散らばることで変わって見えます。雲の形も高さによって異なります。', links: ['space', 'mountain', 'forest'] },
    mountain: { name: '山', color: '#efe6d8', text: '山は標高が上がるほど気温が下がります。ふもとと山頂では、育つ植物も大きく変わります。', links: ['forest', 'sky', 'sea'] },
    space: { name: '宇宙', color: '#e6dcf3', text: '夜空に見える星の光は、長い時間をかけて地球に届いています。銀河は無数の星の集まりです。', links: ['sky', 'sea', 'mountain'] },
  };

  const topicLink = (key) => `<a href="${ORIGIN}/topic/${key}">${TOPICS[key].name}のページへ</a>`;
  const newsLink = `<a href="${ORIGIN}/news/1">探検ニュース一覧</a>`;

  function layout(title, color, body) {
    return `<h1>${title}</h1>${body}<footer>このサイトはデモ用に作られた架空のサイトです。</footer>
      <style>
        body { max-width: 760px; margin: 0 auto; padding: 32px 24px; background: ${color}; color: #223; font: 18px/1.8 "Yu Gothic UI", system-ui, sans-serif; }
        a { color: #1450b4; } li { margin: 10px 0; }
        footer { margin-top: 48px; color: #667; font-size: 14px; }
        .news { min-height: 130px; padding: 12px 0; border-bottom: 1px solid #99a; }
      </style>`;
  }

  function home() {
    return layout('探検図鑑へようこそ', '#fff8e6', `
      <p>リンクの中へどこまでも入っていける、無限ズームのデモです。</p>
      <ul>
        <li><b>拡大・縮小:</b> ホイールを上に回すと拡大、下に回すと縮小します。スマホではピンチします。</li>
        <li><b>リンクを開く:</b> リンクをクリック(タップ)するか、リンクを画面中央で拡大します。</li>
        <li><b>移動:</b> ドラッグ&ドロップで動かせます。スマホでは1本指でなぞります。</li>
        <li><b>閉じる:</b> カード右上の × を押します。</li>
      </ul>
      <h2>テーマ</h2>
      <ul>${Object.keys(TOPICS).map((key) => `<li>${topicLink(key)}</li>`).join('')}</ul>
      <h2>読み物</h2>
      <p>${newsLink}(末尾まで進むと次のページが継ぎ足されます)</p>`);
  }

  function topic(key) {
    const t = TOPICS[key];
    return layout(t.name, t.color, `
      <p>${t.text}</p>
      <h2>関連するテーマ</h2>
      <ul>${t.links.map((other) => `<li>${topicLink(other)}</li>`).join('')}</ul>
      <p>${newsLink}</p>`);
  }

  function news(page) {
    const items = Array.from({ length: NEWS_PER_PAGE }, (_, i) => {
      const key = Object.keys(TOPICS)[(page + i) % 5];
      return `<div class="news"><a href="${ORIGIN}/topic/${key}">記事 ${page}-${i + 1}: ${TOPICS[key].name}を探検する</a></div>`;
    }).join('');
    const next = page < NEWS_PAGES ? `<a rel="next" href="${ORIGIN}/news/${page + 1}">次へ</a>` : '';
    return layout('探検ニュース', '#f4f4f6', `<main id="news">${items}</main><nav class="pagination">${next}</nav>`);
  }

  function pageBody(url) {
    const { pathname } = new URL(url);
    const [, kind, id] = pathname.split('/');
    if (kind === 'topic' && TOPICS[id]) return topic(id);
    if (kind === 'news') return news(Number(id) || 1);
    return home();
  }

  const escapeForScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

  window.zbSite = {
    startUrl: `${ORIGIN}/`,
    // 継ぎ足し用。実サイトの fetch の結果に相当する、スクリプトを含まない HTML を返す
    fetchPage: (url) => `<!doctype html><html><body>${pageBody(url)}</body></html>`,
    // iframe に渡す HTML。先に zbDemo を定義してから content.js を読み込む
    render(url) {
      const contentScript = new URL('content.js', location.href).href;
      const body = pageBody(url);
      const title = body.match(/<h1>(.*?)<\/h1>/)[1];
      return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>
        <script>window.zbDemo = { url: ${escapeForScript(url)}, fetchPage: (u) => window.parent.zbSite.fetchPage(u) };</script>
        <script src=${escapeForScript(contentScript)}></script></head><body>${body}</body></html>`;
    },
  };
})();
