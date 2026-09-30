import { $, fmt, fmtDate, escapeHtml, hearts, icon, whoColor } from './util.js';
import { tr, isEn } from './i18n.js';

// ライブラリ: 保存しているすべてのメディアの一覧と、まとめての検索。
// 検索の対象は、セルのメモ・コメント・定型コメント・字幕（文字起こし）・単語帳。
// 「いいね・ブックマークだけ」にすると、すべてのメディアのお気に入りの場面を並べられる。
// 結果を押すと、そのメディアを開いてその場面へ移動する（手元のファイルは、開き直してもらう）。
// 結果の ＋ で、そのセル・目印を右側のプレイリスト（playlist.js）に入れる
const PER_MEDIA = 5;   // 1つのメディアで最初に見せる件数
const MAX_HITS = 3000; // これ以上は数えるだけにする

// 結果の行に付ける種類の名前（英語では1件ごとの名前なので単数にする）
const KINDS = {
  cell: ['セル', 'Cell'],
  comment: ['コメント', 'Comment'],
  tag: ['定型コメント', 'Quick comment'],
  mark: ['目印', 'Marker'],
  cue: ['字幕', 'Caption'],
  word: ['単語', 'Word'],
};
const kindName = (k) => KINDS[k][isEn ? 1 : 0];

// 全角・半角や大文字・小文字の違いを気にせずに探す
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase();

// 検索語の前後だけを切り出して、見つかった所に印を付ける
function snippet(text, terms, width = 90) {
  const flat = String(text).replace(/\s*\n\s*/g, ' ');
  const low = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  let start = 0;
  if (flat.length > width && at > width / 3) start = Math.min(at - Math.floor(width / 3), flat.length - width);
  const part = flat.slice(start, start + width);
  const pre = start > 0 ? '…' : '';
  const post = start + width < flat.length ? '…' : '';
  // 印を付ける範囲を集めてから、文字として安全に組み立てる
  const lp = part.toLowerCase();
  const marks = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = lp.indexOf(t); i >= 0; i = lp.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  let html = '';
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    html += escapeHtml(part.slice(pos, a)) + `<mark>${escapeHtml(part.slice(a, b))}</mark>`;
    pos = b;
  }
  html += escapeHtml(part.slice(pos));
  return pre + html + post;
}

export class Library {
  constructor(app) {
    this.app = app;
    this.dialog = $('#libraryDialog');
    this.searchEl = $('#libSearch');
    this.listEl = $('#libList');
    this.countEl = $('#libCount');
    this.favEl = $('#libFav');
    this.kindBtns = [...this.dialog.querySelectorAll('[data-kind]')];
    this.kind = 'all';
    this.docs = [];
    this.entries = [];
    this.hits = [];
    this.expanded = new Set();
    this.timer = null;

    $('#btnLibrary').addEventListener('click', () => this.open());
    this.searchEl.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.expanded.clear();
      this.timer = setTimeout(() => this.render(), 150);
    });
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault(); // 検索欄の Enter でダイアログを閉じない
    });
    this.favEl.addEventListener('change', () => {
      this.expanded.clear();
      this.render();
    });
    for (const b of this.kindBtns) {
      b.addEventListener('click', () => {
        this.kind = b.dataset.kind;
        this.expanded.clear();
        this.render();
      });
    }
    this.listEl.addEventListener('click', (e) => this.onClick(e));
  }

  async open() {
    if (!this.dialog.open) this.dialog.showModal();
    this.searchEl.focus();
    this.listEl.innerHTML = `<div class="lib-empty">${tr('読み込み中…')}</div>`;
    this.app.playlist.render();
    this.docs = (await this.app.store.allDocs()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.entries = this.buildEntries();
    this.expanded.clear();
    this.render();
    // プレイリストの写し（範囲・メモ・題名）を、元のセル・目印の今の内容に合わせる
    this.app.playlist.sync(this.docs);
    this.app.playlist.render();
  }

  // 探すもの（1件ずつ）を作る
  buildEntries() {
    const out = [];
    for (const doc of this.docs) {
      const who = (x) => (x.src ? doc.shares?.find((s) => s.id === x.src) || { by: '?', color: 0 } : null);
      for (const c of doc.cells) {
        const base = { doc, t: c.s, lv: c.lv, bm: c.bm, who: who(c), focus: { kind: 'cell', id: c.id }, obj: c };
        // primary: 「いいね・ブックマークだけ」で、1つのセル・目印を1行で見せるときに使う行。
        // メモのないセルも入れておく（「セル」を選んだときに、すべてのセルを並べるため）
        out.push({ ...base, kind: 'cell', text: c.memo, range: [c.s, c.e], primary: true });
        for (const cm of c.comments || []) out.push({ ...base, kind: 'comment', t: Number.isFinite(cm.t) ? cm.t : c.s, text: cm.text });
      }
      for (const m of doc.markers) {
        const base = { doc, t: m.t, lv: m.lv, bm: m.bm, who: who(m), focus: { kind: 'marker', id: m.id }, item: m, obj: m };
        const first = out.length;
        if (m.tags?.length) out.push({ ...base, kind: 'tag', text: m.tags.join('、') });
        for (const cm of m.comments || []) out.push({ ...base, kind: 'comment', text: cm.text });
        if (!m.tags?.length && !m.comments?.length && (m.lv || m.bm)) out.push({ ...base, kind: 'mark', text: '' });
        if (out.length > first) out[first].primary = true;
      }
      for (const q of doc.transcript?.cues || []) out.push({ doc, kind: 'cue', t: q.s, text: q.text, lv: 0, bm: false });
      for (const q of doc.transcript2?.cues || []) out.push({ doc, kind: 'cue', t: q.s, text: q.text, lv: 0, bm: false });
    }
    // 単語帳（メディアの id で結び付ける。メモが消えていても、単語のメディアの名前で出す）
    const byId = new Map(this.docs.map((d) => [d.id, d]));
    for (const w of this.app.store.words) {
      const doc = byId.get(w.mediaId) || { id: w.mediaId, title: w.mediaTitle || '', source: w.mediaUrl ? (/youtu\.?be/.test(w.mediaUrl) ? 'youtube' : 'url') : 'local', url: w.mediaUrl, markers: [], cells: [], updatedAt: 0, orphan: true };
      out.push({ doc, kind: 'word', t: w.t, text: w.note ? `${w.word} — ${w.note}` : w.word, sub: w.context, lv: 0, bm: false });
    }
    for (const e of out) e.hay = norm(`${e.text}\n${e.sub || ''}`);
    return out;
  }

  terms() {
    return norm(this.searchEl.value).split(/\s+/).filter(Boolean);
  }

  matchKind(e) {
    const k = this.kind;
    if (k === 'all') return true;
    if (k === 'comment') return e.kind === 'comment' || e.kind === 'tag';
    if (k === 'cell') return e.kind === 'cell';
    return e.kind === k;
  }

  render() {
    for (const b of this.kindBtns) b.classList.toggle('on', b.dataset.kind === this.kind);
    const terms = this.terms();
    const fav = this.favEl.checked;
    this.addable = [];
    // 何も探さず「すべて」のときはメディアの一覧。「セル」「コメント」などを選んだときは、その種類をすべて並べる
    if (!terms.length && !fav && this.kind === 'all') {
      this.renderMedia();
      return;
    }
    const browse = !terms.length && !fav;
    const hits = [];
    let total = 0;
    for (const e of this.entries) {
      if (!this.matchKind(e)) continue;
      if (fav && !(e.lv || e.bm)) continue;
      // 探す言葉がなく「いいね・ブックマークだけ」のときは、1つの場面を1行にする
      if (fav && !terms.length && !e.primary) continue;
      if (!terms.every((t) => e.hay.includes(t))) continue;
      total++;
      if (hits.length < MAX_HITS) hits.push(e);
    }
    this.hits = hits;
    this.countEl.textContent = total > hits.length
      ? tr('{n} 件（最初の {m} 件を表示）', { n: total, m: hits.length })
      : tr('{n} 件', { n: total });
    if (!hits.length) {
      const empty = browse ? tr('まだありません。') : fav && !terms.length ? tr('いいね・ブックマークした場面はまだありません。') : tr('見つかりませんでした。');
      this.listEl.innerHTML = `<div class="lib-empty">${empty}</div>`;
      return;
    }
    // メディアごとにまとめる（新しく更新した順。メディアの中は時間順）
    const groups = new Map();
    hits.forEach((e, i) => {
      const g = groups.get(e.doc.id) || { doc: e.doc, rows: [] };
      g.rows.push(i);
      groups.set(e.doc.id, g);
    });
    const order = [...groups.values()].sort((a, b) => (b.doc.updatedAt || 0) - (a.doc.updatedAt || 0));
    for (const g of order) g.rows.sort((a, b) => hits[a].t - hits[b].t);
    // 結果のセル・目印を、見えている順（メディアごと・時間順）にまとめてプレイリストへ入れられるように
    const seen = new Set();
    for (const g of order) {
      for (const i of g.rows) {
        const e = hits[i];
        const key = e.obj && `${e.doc.id}|${e.obj.id}`;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        this.addable.push({ doc: e.doc, kind: e.focus.kind, o: e.obj });
      }
    }
    this.listEl.innerHTML = `<div class="lib-addall" id="libAddAll">${this.addAllHtml()}</div>` + order
      .map((g) => {
        const open = this.expanded.has(g.doc.id);
        const shown = open ? g.rows : g.rows.slice(0, PER_MEDIA);
        const more = g.rows.length - shown.length;
        return `<section class="lib-group">
          ${this.mediaHead(g.doc, tr('{n} 件', { n: g.rows.length }))}
          ${shown.map((i) => this.rowHtml(hits[i], i, terms, fav && !terms.length)).join('')}
          ${more > 0 ? `<button type="button" class="lib-more" data-more="${escapeHtml(g.doc.id)}">${tr('さらに {n} 件', { n: more })}</button>` : ''}
        </section>`;
      })
      .join('');
  }

  // 「すべて入れる」のボタン（まだ入っていないものの数）
  addAllHtml() {
    const pl = this.app.playlist;
    const n = (this.addable || []).filter((x) => !pl.has(x.doc.id, x.o.id)).length;
    if (!this.addable?.length) return '';
    return n
      ? `<button type="button" class="btn small" data-addall>${icon('list-add')} ${tr('結果のセル・目印をすべてプレイリストに入れる（{n} 件）', { n })}</button>`
      : `<span class="lib-addall-done">${icon('check')} ${tr('結果のセル・目印は、すべてプレイリストに入っています')}</span>`;
  }

  // プレイリストが変わったとき: ＋ の印と「すべて入れる」だけを直す（一覧の位置は動かさない）
  syncAdds() {
    if (!this.dialog.open) return;
    const pl = this.app.playlist;
    for (const b of this.listEl.querySelectorAll('[data-add]')) {
      const e = this.hits[Number(b.dataset.add)];
      if (!e) continue;
      const on = pl.has(e.doc.id, e.obj.id);
      if (on === b.classList.contains('on')) continue;
      b.outerHTML = this.addBtn(e, Number(b.dataset.add));
    }
    const all = this.listEl.querySelector('#libAddAll');
    if (all) all.innerHTML = this.addAllHtml();
  }

  addBtn(e, i) {
    const on = this.app.playlist.has(e.doc.id, e.obj.id);
    const what = e.focus.kind === 'cell' ? tr('このセル') : tr('この目印');
    const title = on ? tr('{what}をプレイリストから外す', { what }) : tr('{what}をプレイリストに入れる', { what });
    return `<button type="button" class="lib-add${on ? ' on' : ''}" data-add="${i}" title="${title}" aria-label="${title}" aria-pressed="${on}">${icon(on ? 'check' : 'list-add')}</button>`;
  }

  kindLabel(doc) {
    return { youtube: 'YouTube', url: 'URL', local: tr('ファイル') }[doc.source] || '';
  }

  mediaHead(doc, count) {
    const here = this.app.store.doc?.id === doc.id;
    const local = doc.source === 'local';
    return `<div class="lib-media">
      <span class="lib-kind">${this.kindLabel(doc)}</span>
      <button type="button" class="lib-title" data-open="${escapeHtml(doc.id)}" title="${escapeHtml(local ? tr('同じファイルを開くと、メモが復元されます') : tr('クリックで開く'))}">${escapeHtml(doc.title || doc.id)}</button>
      ${here ? `<span class="lib-here">${tr('いま開いている')}</span>` : ''}
      <span class="lib-n">${count}</span>
    </div>`;
  }

  // whole: 1つの場面を1行で見せる（目印なら、定型コメントとコメントをまとめて出す）
  rowHtml(e, i, terms, whole = false) {
    if (whole && e.item) {
      const m = e.item;
      const text = [m.tags.join('、'), m.comments[0]?.text].filter(Boolean).join('　');
      e = { ...e, kind: 'mark', text };
    }
    const kind = `<span class="lib-badge k-${e.kind}">${kindName(e.kind)}</span>`;
    const who = e.who ? `<span class="lib-who" style="--who:${whoColor(e.who)}">${escapeHtml(e.who.by)}</span>` : '';
    const time = e.range ? `${fmt(e.range[0])}–${fmt(e.range[1])}` : fmt(e.t);
    const text = e.text ? snippet(e.text, terms) : `<span class="muted">${tr('（メモなし）')}</span>`;
    const sub = e.sub ? `<span class="lib-sub">${snippet(e.sub, terms, 70)}</span>` : '';
    const fav = (e.lv ? `<span class="lib-like">${hearts(e.lv)}</span>` : '') + (e.bm ? `<span class="lib-bm">${icon('bookmark', 'fill')}</span>` : '');
    return `<div class="lib-line">
      <button type="button" class="lib-row" data-go="${i}">
        <span class="lib-t">${time}</span>${kind}${who}
        <span class="lib-text">${text}${sub}</span>
        ${fav}
      </button>
      ${e.obj ? this.addBtn(e, i) : ''}
    </div>`;
  }

  // 何も探していないとき: メディアの一覧
  renderMedia() {
    const docs = this.docs;
    this.countEl.textContent = tr('{n} 本のメディア', { n: docs.length });
    if (!docs.length) {
      this.listEl.innerHTML = `<div class="lib-empty">${tr('まだメモのあるメディアがありません。動画や音声を開いて、目印やセルを付けるとここに並びます。')}</div>`;
      return;
    }
    const words = this.app.store.words;
    this.listEl.innerHTML = docs
      .map((d) => {
        const own = (list) => list.filter((x) => !x.src).length;
        const nw = words.filter((w) => w.mediaId === d.id).length;
        const parts = [
          tr('セル {c}・目印 {m}', { c: own(d.cells), m: own(d.markers) }),
          d.transcript?.cues?.length ? tr('字幕 {n} 行', { n: d.transcript.cues.length }) : '',
          nw ? tr('単語 {n}', { n: nw }) : '',
          d.shares?.length ? tr('共有 {n}', { n: d.shares.length }) : '',
          d.duration ? fmt(d.duration) : '',
          d.updatedAt ? tr('{date} 更新', { date: fmtDate(d.updatedAt) }) : '',
        ].filter(Boolean);
        return `<section class="lib-group lib-item">
          ${this.mediaHead(d, '')}
          <div class="lib-meta">${escapeHtml(parts.join(tr('・')))}</div>
        </section>`;
      })
      .join('');
  }

  onClick(e) {
    const add = e.target.closest('[data-add]');
    if (add) {
      const hit = this.hits[Number(add.dataset.add)];
      if (hit?.obj) this.app.playlist.toggle(hit.doc, hit.focus.kind, hit.obj);
      return;
    }
    if (e.target.closest('[data-addall]')) {
      const n = this.app.playlist.add(this.addable || []);
      this.app.playlist.flash(tr('{n} 件をプレイリストに入れました', { n }));
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      this.expanded.add(more.dataset.more);
      this.render();
      return;
    }
    const openEl = e.target.closest('[data-open]');
    if (openEl) {
      const doc = this.docs.find((d) => d.id === openEl.dataset.open) || this.hits.find((h) => h.doc.id === openEl.dataset.open)?.doc;
      if (doc) this.go(doc, null, null);
      return;
    }
    const row = e.target.closest('[data-go]');
    if (!row) return;
    const hit = this.hits[Number(row.dataset.go)];
    if (hit) this.go(hit.doc, hit.t, hit.focus || null);
  }

  // そのメディアを開いて（開いていればそのまま）、その場面へ
  go(doc, t, focus) {
    const url = doc.source !== 'local' ? doc.url : null;
    this.dialog.close();
    this.app.jumpToMedia(doc.id, url, t, doc.title, focus);
  }
}
