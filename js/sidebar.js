import { $, fmt, fmtLen, fmtDate, escapeHtml, hearts, icon, commentSummary, tagChips, whoColor, viaBadges } from './util.js';
import { saveSettings } from './store.js';
import { cuesIn, subTextAt } from './transcript.js';
import { tr } from './i18n.js';

const NUDGES = [-1, -0.1, 0.1, 1];

// 共有で読み込んだセル・目印でもできる操作（見る・移動する・リピートするだけ）
const SHARED_ACTS = new Set(['seek', 'jump', 'lead', 'repeat', 'tx', 'txcopy', 'talk', 'toggle', 'pl']);

// 並び順（時間順以外は字下げせずに並べる）
const SORTS = {
  like: (a, b) => b.o.lv - a.o.lv || a.t - b.t,
  new: (a, b) => (b.o.at || 0) - (a.o.at || 0) || a.t - b.t,
  comments: (a, b) => b.o.comments.length - a.o.comments.length || a.t - b.t,
};

// 右サイドバー: セル／目印／すべて の一覧。セルは X のポストのようなカードで表示する
export class Sidebar {
  constructor(app) {
    this.app = app;
    this.listEl = $('#sideList');
    this.countEl = $('#sideCount');
    this.tabsEl = $('#sideTabs');
    this.likeSel = $('#filterLike');
    this.bmBtn = $('#filterBm');
    this.tagSel = $('#filterTag');
    this.searchEl = $('#sideSearch');
    this.sortSel = $('#sideSort');
    this.focusMemo = false; // メモの編集を始めた直後に、カーソルを末尾へ置く

    this.tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      app.ui.tab = b.dataset.tab;
      this.render();
    });
    this.likeSel.addEventListener('change', () => {
      app.ui.minLike = Number(this.likeSel.value);
      this.likeSel.blur();
      this.render();
    });
    this.tagSel.addEventListener('change', () => {
      app.ui.tag = this.tagSel.value;
      this.tagSel.blur();
      this.render();
    });
    this.bmBtn.addEventListener('click', () => {
      app.ui.bmOnly = !app.ui.bmOnly;
      this.render();
    });
    this.sortSel.addEventListener('change', () => {
      app.settings.sidebarSort = this.sortSel.value;
      saveSettings(app.settings);
      this.sortSel.blur();
      this.render();
    });
    this.searchEl.addEventListener('input', () => {
      app.ui.query = this.searchEl.value;
      this.render();
    });
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      this.searchEl.value = '';
      app.ui.query = '';
      this.searchEl.blur();
      this.render();
    });
    this.listEl.addEventListener('click', (e) => this.onClick(e));
    this.listEl.addEventListener('keydown', (e) => this.onKeydown(e));
    this.listEl.addEventListener('input', (e) => {
      if (e.target.tagName === 'TEXTAREA') autosize(e.target);
    });
    // 外をクリックしたらメモを保存する（再描画で消えたときは何もしない）
    this.listEl.addEventListener('focusout', (e) => {
      const f = e.target;
      if (f.dataset.field === 'memo' && f.isConnected && this.app.ui.editingMemo) this.saveMemo(f);
    });
  }

  // タグでの絞り込みは、目印ならそのタグが付いているもの、セルならそのタグの目印を区間に含むもの
  passes(x, kind) {
    const { ui, store } = this.app;
    if (x.lv < ui.minLike || (ui.bmOnly && !x.bm)) return false;
    if (!ui.tag) return true;
    if (kind === 'cell') return store.markers.some((m) => m.t >= x.s && m.t < x.e && m.tags.includes(ui.tag));
    return (x.tags || []).includes(ui.tag);
  }

  matchesQuery(x, kind) {
    const q = this.app.ui.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [kind === 'cell' ? x.memo : '', ...(x.tags || []), ...x.comments.map((c) => c.text)];
    // セルは、その区間の文字起こしも検索の対象にする
    if (kind === 'cell') for (const { cue } of cuesIn(this.app.store.cues, x.s, x.e)) hay.push(cue.text);
    return hay.join('\n').toLowerCase().includes(q);
  }

  // 使われているタグ（名前を変える前の古いタグも含む）で絞り込みの選択肢を作る
  renderTagOptions() {
    const { ui, store } = this.app;
    const counts = new Map();
    for (const m of store.markers) for (const t of m.tags) counts.set(t, (counts.get(t) || 0) + 1);
    if (ui.tag && !counts.has(ui.tag)) ui.tag = '';
    const names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ja'));
    this.tagSel.innerHTML =
      `<option value="">${tr('タグ: すべて')}</option>` +
      names.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(tr('{tag}（{n}）', { tag: t, n: counts.get(t) }))}</option>`).join('');
    this.tagSel.value = ui.tag;
  }

  items() {
    const { ui, store, settings } = this.app;
    const cells = [...store.cells].sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
    // 字下げ: 自分を丸ごと含む（先に並ぶ）セルの数
    const depth = new Map();
    cells.forEach((c, i) => {
      let d = 0;
      for (let j = 0; j < i; j++) if (cells[j].s <= c.s && cells[j].e >= c.e) d++;
      depth.set(c.id, d);
    });
    const items = [];
    if (ui.tab !== 'markers') {
      for (const c of cells) {
        if (this.passes(c, 'cell') && this.matchesQuery(c, 'cell')) items.push({ kind: 'cell', t: c.s, o: c, depth: depth.get(c.id) });
      }
    }
    if (ui.tab !== 'cells') {
      const markers = [...store.markers].sort((a, b) => a.t - b.t);
      for (const m of markers) {
        if (!this.passes(m, 'marker') || !this.matchesQuery(m, 'marker')) continue;
        const d = ui.tab === 'all' ? cells.filter((c) => c.s <= m.t && m.t < c.e).length : 0;
        items.push({ kind: 'marker', t: m.t, o: m, depth: d });
      }
    }
    const sort = SORTS[settings.sidebarSort];
    if (sort) {
      for (const it of items) it.depth = 0;
      items.sort(sort);
    } else if (ui.tab === 'all') {
      const rank = (it) => (it.kind === 'cell' ? 0 : 1);
      items.sort((a, b) => a.t - b.t || rank(a) - rank(b));
    }
    return items;
  }

  render() {
    const { ui, store, settings } = this.app;
    for (const b of this.tabsEl.children) b.classList.toggle('on', b.dataset.tab === ui.tab);
    this.bmBtn.classList.toggle('on', ui.bmOnly);
    this.likeSel.value = String(ui.minLike);
    this.sortSel.value = settings.sidebarSort;
    this.renderTagOptions();
    this.countEl.textContent = store.doc ? tr('セル {c}・目印 {m}', { c: store.cells.length, m: store.markers.length }) : '';
    if (ui.editingMemo && !store.getCell(ui.editingMemo)) ui.editingMemo = null;

    // 再描画しても入力中の欄とスクロール位置を保つ
    const active = document.activeElement;
    const keep =
      active && this.listEl.contains(active) && active.dataset.key
        ? { key: active.dataset.key, value: active.value, start: active.selectionStart, end: active.selectionEnd }
        : null;
    const scroll = this.listEl.scrollTop;

    const items = store.doc ? this.items() : [];
    this.listEl.innerHTML =
      this.selbarHtml() +
      (items.length
        ? items.map((it) => (it.kind === 'cell' ? this.cellHtml(it.o, it.depth) : this.markerHtml(it.o, it.depth))).join('')
        : this.emptyHtml());
    this.listEl.scrollTop = scroll;
    for (const ta of this.listEl.querySelectorAll('textarea')) autosize(ta);

    if (keep) {
      const el = this.listEl.querySelector(`[data-key="${keep.key}"]`);
      if (el) {
        el.value = keep.value;
        autosize(el);
        el.focus();
        try {
          el.setSelectionRange(keep.start, keep.end);
        } catch {}
      }
    } else if (this.focusMemo) {
      const el = this.listEl.querySelector('[data-field="memo"]');
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    this.focusMemo = false;
    this.updateActive();
    if (this.txCur !== undefined) this.markTranscript(this.txCur);

    if (ui.flashId) {
      const el = this.listEl.querySelector(`.card[data-id="${ui.flashId}"]`);
      ui.flashId = null;
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el.classList.add('is-flash');
        setTimeout(() => el.classList.remove('is-flash'), 1200);
      }
    }
  }

  updateActive() {
    const { activeCells, nearId, ui } = this.app;
    const tid = ui.target?.id;
    for (const el of this.listEl.querySelectorAll('.card')) {
      el.classList.toggle('is-digest', el.dataset.id === ui.digestId);
      if (el.dataset.kind === 'cell') {
        el.classList.toggle('is-active', activeCells.has(el.dataset.id));
        // S やタイムラインの下のバーで操作するセル（重なっているときに分かるように）
        el.classList.toggle('is-cur-cell', el.dataset.id === this.app.curCellId && activeCells.size > 1);
      } else {
        el.classList.toggle('is-target', el.dataset.id === tid);
        el.classList.toggle('is-now', el.dataset.id === nearId);
      }
    }
  }

  emptyHtml() {
    const { ui, store } = this.app;
    const box = (html) => `<div class="side-empty">${html}</div>`;
    if (!store.doc) return box(tr('動画や音声を開くと、ここにセルや目印が並びます。'));
    if (ui.query.trim()) return box(escapeHtml(tr('「{q}」に一致するものはありません。', { q: ui.query.trim() })));
    if (ui.minLike || ui.bmOnly || ui.tag) return box(tr('条件に合うものがありません。'));
    if (ui.tab === 'markers') {
      return box(tr('目印はまだありません。<br>M キーで、再生を止めずに目印を付けられます。'));
    }
    return box(tr('セルはまだありません。<br>タイムラインの「区間」をクリックするか、Enter キーでいまいる区間をセルにできます。<br>「等間隔でセル化」で、30秒ごとなどにまとめて作ることもできます。'));
  }

  // セルを選んでいるときに一覧の上に出る帯（連結・選択の解除）
  selbarHtml() {
    const n = this.app.ui.selectedCells.size;
    if (!n) return '';
    return `<div class="selbar">
      <span class="selbar-count">${tr('{n}件のセルを選択中', { n })}</span>
      <span class="spacer"></span>
      <button class="btn small primary" data-sact="merge" title="${tr('選んだセルを1つにまとめる')}">${tr('連結')}</button>
      <button class="btn small" data-sact="clear" title="${tr('選択を解除 (Esc)')}">${tr('解除')}</button>
    </div>`;
  }

  cardAttrs(kind, o, depth, extra) {
    const d = Math.min(depth, 4);
    const sh = this.app.store.shareOf(o);
    const cls = `card ${kind}-card${d ? ' is-nested' : ''}${this.app.ui.expanded.has(o.id) ? ' is-open' : ''}${sh ? ' is-shared' : ''}${extra}`;
    return `class="${cls}" data-kind="${kind}" data-id="${o.id}" style="--depth:${d}${sh ? `;--who:${whoColor(sh)}` : ''}"`;
  }

  // 共有で読み込んだものに付ける、共有した人の名前
  whoChip(sh) {
    return sh ? `<span class="who-chip" title="${escapeHtml(tr('{name} さんの共有', { name: sh.by }))}">${escapeHtml(sh.by)}</span>` : '';
  }

  // ---- セル（ポスト風のカード） ----

  cellHtml(c, depth) {
    const { ui } = this.app;
    const sh = this.app.store.shareOf(c);
    const rep = ui.repeatId === c.id;
    const open = ui.expanded.has(c.id) && !sh;
    const talk = ui.commentsOpen.has(c.id);
    const tx = ui.txOpen.has(c.id) && this.app.store.cues.length > 0;
    const memo = sh
      ? c.memo
        ? `<div class="memo is-static">${escapeHtml(c.memo)}</div>`
        : ''
      : ui.editingMemo === c.id
        ? `<div class="memo-edit" data-act="noop">
            <textarea class="memo-input" data-field="memo" data-key="memo-${c.id}" rows="2" placeholder="${tr('このセルのメモ')}">${escapeHtml(c.memo)}</textarea>
            <div class="memo-hint">${tr('Enter で改行・Ctrl+Enter か外をクリックで保存・Esc で取り消し')}</div>
          </div>`
        : `<div class="memo${c.memo ? '' : ' is-empty'}" data-act="edit-memo" title="${tr('クリックで編集')}">${c.memo ? escapeHtml(c.memo) : tr('メモを書く…')}</div>`;
    const pips = [1, 2, 3].map((n) => `<i class="${n <= c.lv ? 'on' : ''}"></i>`).join('');
    const selected = ui.selectedCells.has(c.id);
    return `<article ${this.cardAttrs('cell', c, depth, (rep ? ' is-repeat' : '') + (selected ? ' is-selected' : ''))}>
      <div class="cell-head">
        <button class="tbtn" data-act="seek" title="${tr('クリックでセルの先頭へ移動・ダブルクリックでそこから再生')}">${fmt(c.s, true)}–${fmt(c.e, true)}</button>
        ${this.leadBtn()}
        <span class="cell-len">${fmtLen(c.e - c.s)}</span>
        <span class="badge-now">${tr('再生中')}</span>
        ${rep ? `<span class="badge-rep">${icon('repeat')}${tr('リピート中')}</span>` : ''}
        <span class="spacer"></span>
        ${sh ? this.whoChip(sh) : `<input type="checkbox" class="cell-check" data-act="select"${selected ? ' checked' : ''} title="${tr('連結するセルとして選ぶ')}" aria-label="${tr('このセルを選ぶ')}">
        <button class="tool" data-act="toggle" title="${open ? tr('閉じる') : tr('範囲の調整・削除')}" aria-label="${tr('その他')}">${icon('dots')}</button>`}
      </div>
      ${memo}
      <div class="actions">
        ${sh ? this.sharedMarks(c, sh, pips) : `<button class="act like" data-act="cycle" data-lv="${c.lv}" title="${tr('いいね（押すたびに 1 → 2 → 3 → 解除）')}">${icon('heart', c.lv ? 'fill' : '')}<span class="pips">${pips}</span></button>
        <button class="act mark${c.bm ? ' on' : ''}" data-act="bm" title="${tr('ブックマーク')}" aria-pressed="${c.bm}">${icon('bookmark', c.bm ? 'fill' : '')}</button>`}
        ${sh && !c.comments.length ? '' : `<button class="act talk${talk ? ' open' : ''}" data-act="talk" title="${tr('コメント')}" aria-expanded="${talk}">${icon('comment')}${c.comments.length ? `<span class="n">${c.comments.length}</span>` : ''}</button>`}
        <button class="act rep${rep ? ' on' : ''}" data-act="repeat" title="${tr('リピート再生（同時に1つだけ）')}">${icon('repeat')}<span>${tr('リピート')}</span></button>
        ${this.plBtn(c)}
        ${sh ? '' : `<button class="act split" data-act="split" title="${tr('再生位置で2つに分ける（メモ・いいね・コメントは前のセルに残ります） (S)')}">${icon('scissors')}<span>${tr('分割')}</span></button>`}
        ${this.app.store.cues.length ? `<button class="act tx${tx ? ' open' : ''}" data-act="tx" title="${tr('この区間の文字起こし')}" aria-expanded="${tx}">${icon('text')}<span>${tr('文字起こし')}</span></button>` : ''}
      </div>
      ${tx ? this.txHtml(c) : ''}
      ${talk ? this.threadHtml(c) : ''}
      ${open ? this.cellDetail(c) : ''}
    </article>`;
  }

  // 共有されたセルのいいね・ブックマーク（押せない表示だけ）
  sharedMarks(c, sh, pips) {
    const like = c.lv
      ? `<span class="act like is-static" data-lv="${c.lv}" title="${escapeHtml(tr('{name} さんのいいね', { name: sh.by }))}">${icon('heart', 'fill')}<span class="pips">${pips}</span></span>`
      : '';
    const bm = c.bm ? `<span class="act mark on is-static" title="${tr('ブックマーク')}">${icon('bookmark', 'fill')}</span>` : '';
    return like + bm;
  }

  // セルの区間の文字起こし。行を押すとその位置へ（すばやく2回で再生）、再生中の行は強調する
  txHtml(c) {
    const lines = cuesIn(this.app.store.cues, c.s, c.e);
    if (!lines.length) return `<div class="txpanel" data-act="noop"><p class="thread-empty">${tr('この区間に字幕・文字起こしはありません。')}</p></div>`;
    const cues2 = this.app.store.cues2;
    const sub = (cue) => {
      const t = cues2.length ? subTextAt(cues2, cue.s, cue.e) : '';
      return t ? `<span class="tx-sub">${escapeHtml(t)}</span>` : '';
    };
    const rows = lines
      .map(({ cue, i }) => `<div class="tx-line" data-act="jump" data-t="${cue.s}" data-i="${i}" title="${tr('クリックでこの位置へ・ダブルクリックで再生')}"><span class="tx-t">${fmt(cue.s)}</span><span class="tx-x">${escapeHtml(cue.text)}${sub(cue)}</span></div>`)
      .join('');
    return `<div class="txpanel" data-act="noop">
      <div class="tx-lines">${rows}</div>
      <div class="tx-foot"><span>${tr('{n} 行', { n: lines.length })}</span><span class="spacer"></span><button class="btn tiny" data-act="txcopy">${tr('テキストをコピー')}</button></div>
    </div>`;
  }

  // 再生位置の字幕の行を強調する（main.js の監視から呼ばれる）
  markTranscript(i) {
    this.txCur = i;
    for (const el of this.listEl.querySelectorAll('.tx-line.cur')) el.classList.remove('cur');
    if (i < 0) return;
    for (const el of this.listEl.querySelectorAll(`.tx-line[data-i="${i}"]`)) el.classList.add('cur');
  }

  cellDetail(c) {
    return `<div class="card-detail" data-act="noop">
      ${this.edgeRow(tr('開始'), 's', c.s)}
      ${this.edgeRow(tr('終了'), 'e', c.e)}
      <div class="detail-foot"><button class="btn tiny" data-act="split" title="${tr('再生位置で2つに分ける（メモ・いいね・コメントは前のセルに残ります） (S)')}">${icon('scissors')} ${tr('再生位置で分割')}</button><span class="spacer"></span><button class="btn tiny danger" data-act="delete">${icon('trash')} ${tr('セルを削除')}</button></div>
    </div>`;
  }

  edgeRow(label, edge, t) {
    const nudges = NUDGES.map(
      (d) => `<button class="btn tiny" data-act="nudge" data-edge="${edge}" data-d="${d}">${d > 0 ? '+' : '−'}${Math.abs(d)}</button>`,
    ).join('');
    return `<div class="edge-row"><span class="edge-label">${label}</span><span class="edge-time">${fmt(t, true)}</span>${nudges}<button class="btn tiny" data-act="setnow" data-edge="${edge}">${tr('現在位置')}</button></div>`;
  }

  // コメントはポストの形で並べ、下の欄から投稿する
  threadHtml(o) {
    const sh = this.app.store.shareOf(o);
    const posts = o.comments.map((cm) => this.postHtml(cm, sh)).join('');
    if (sh) {
      return `<div class="thread" data-act="noop">
        ${posts ? `<div class="posts">${posts}</div>` : `<p class="thread-empty">${tr('コメントはありません。')}</p>`}
      </div>`;
    }
    return `<div class="thread" data-act="noop">
      ${posts ? `<div class="posts">${posts}</div>` : `<p class="thread-empty">${tr('まだコメントはありません。書いた時点の再生位置と一緒に残ります。')}</p>`}
      <div class="compose">
        <textarea class="compose-input" data-field="comment" data-key="c-${o.id}" rows="1" placeholder="${tr('コメント（Enter で改行・Ctrl+Enter で投稿）')}"></textarea>
        <button class="btn small primary" data-act="post">${tr('投稿')}</button>
      </div>
    </div>`;
  }

  // 「少し前から」ボタン。t を渡すとその時刻の少し前へ、渡さなければカードの位置の少し前へ移動する
  leadBtn(t) {
    const lead = this.app.settings.leadIn;
    const at = t === undefined ? '' : ` data-t="${t}"`;
    return `<button class="lead-btn" data-act="lead"${at} title="${tr('{s}秒前へ移動（ダブルクリックでそこから再生）', { s: lead })}">${tr('−{s}秒', { s: lead })}</button>`;
  }

  // sh: 共有で読み込んだものならその共有（書いた人の名前を出し、消せないようにする）。
  // 取り込んだ共有のコメントは cm.by に書いた人の名前を持つ
  postHtml(cm, sh) {
    const time = Number.isFinite(cm.t)
      ? `<button class="tbtn" data-act="jump" data-t="${cm.t}" title="${tr('この位置へ移動（ダブルクリックでそこから再生）')}">${fmt(cm.t)}</button>${this.leadBtn(cm.t)}`
      : '';
    const who = cm.by || sh?.by;
    const avatar = who
      ? `<div class="avatar is-who" aria-hidden="true"${sh ? ` style="--who:${whoColor(sh)}"` : ''}>${escapeHtml([...who][0] || '?')}</div>`
      : `<div class="avatar" aria-hidden="true">${tr('自')}</div>`;
    return `<div class="post">
      ${avatar}
      <div class="post-body">
        <div class="post-meta"><span class="who">${who ? escapeHtml(who) : tr('あなた')}</span>${viaBadges(cm.via)}${cm.at ? `<span>${fmtDate(cm.at)}</span>` : ''}${time}</div>
        <div class="post-text">${escapeHtml(cm.text)}</div>
        ${sh ? '' : `<div class="post-acts"><button class="pact" data-act="delc" data-cid="${cm.id}">${tr('削除')}</button></div>`}
      </div>
    </div>`;
  }

  // ---- 目印（1行のカード） ----

  // ◆ は区間の区切りになる目印、● は瞬間のいいね・コメント。定型コメントがあればキー番号を出す
  markerIcon(m) {
    const nums = this.app.tagNumbers(m.tags).slice(0, 3).join('');
    const kind = m.mark ? tr('目印（区間の区切り）') : tr('この瞬間のいいね・コメント');
    const title = nums ? kind + tr('・定型コメント {tags}', { tags: m.tags.join(tr('、')) }) : kind;
    return `<span class="marker-dot lv${m.lv}${m.mark ? ' is-mark' : ''}${nums ? ' has-num' : ''}" title="${escapeHtml(title)}">${nums}</span>`;
  }

  markerHtml(m, depth) {
    const sh = this.app.store.shareOf(m);
    if (sh) return this.sharedMarkerHtml(m, depth, sh);
    const open = this.app.ui.expanded.has(m.id);
    let text = `<span class="card-text muted">${tr('コメントなし')}</span>`;
    if (m.comments.length) text = `<span class="card-text">${escapeHtml(commentSummary(m.comments))}</span>`;
    else if (m.tags.length) text = '';
    const tagEdit = m.tags.length
      ? `<div class="edge-row"><span class="edge-label">${tr('タグ')}</span><span class="tag-chips">${m.tags
          .map((t) => `<span class="tag-chip tag-edit">${escapeHtml(t)}<button data-act="deltag" data-tag="${escapeHtml(t)}" title="${tr('このタグを外す')}" aria-label="${escapeHtml(tr('{tag}を外す', { tag: t }))}">${icon('x')}</button></span>`)
          .join('')}</span></div>`
      : '';
    return `<div ${this.cardAttrs('marker', m, depth, '')}>
      <div class="card-row">
        ${this.markerIcon(m)}
        <div class="card-main" data-act="seek" title="${tr('クリックでこの目印へ移動・ダブルクリックでそこから再生')}"><span class="card-time">${fmt(m.t, true)}</span>${tagChips(m.tags)}${text}</div>
        ${this.leadBtn()}
        <button class="like-cycle" data-act="cycle" title="${tr('いいね（クリックで 0→1→2→3→0）')}">${hearts(m.lv)}</button>
        <button class="tool${m.bm ? ' on' : ''}" data-act="bm" title="${tr('ブックマーク')}">${icon('bookmark', m.bm ? 'fill' : '')}</button>
        <button class="tool chev" data-act="toggle" title="${open ? tr('閉じる') : tr('詳細・編集')}">${icon('chevron')}</button>
      </div>
      ${open ? `<div class="card-detail" data-act="noop">
        ${this.edgeRow(tr('位置'), 't', m.t)}
        <div class="edge-row"><span class="edge-label">${tr('区切り')}</span><label class="check-inline"><input type="checkbox" data-act="markflag"${m.mark ? ' checked' : ''}> ${tr('区間の区切りにする')}</label></div>
        ${tagEdit}
        ${this.threadHtml(m)}
        <div class="detail-foot">${this.plBtn(m, true)}<span class="spacer"></span><button class="btn tiny danger" data-act="delete">${icon('trash')} ${tr('目印を削除')}</button></div>
      </div>` : ''}
    </div>`;
  }

  // 共有で読み込んだ目印: 見る・移動するだけ（開くとコメントを読める）
  sharedMarkerHtml(m, depth, sh) {
    const open = this.app.ui.expanded.has(m.id) && m.comments.length > 0;
    const text = m.comments.length ? `<span class="card-text">${escapeHtml(commentSummary(m.comments))}</span>` : '';
    const like = m.lv
      ? `<span class="like-cycle is-static" title="${escapeHtml(tr('{name} さんのいいね', { name: sh.by }))}">${hearts(m.lv)}</span>`
      : '';
    const chev = m.comments.length
      ? `<button class="tool chev" data-act="toggle" title="${open ? tr('閉じる') : tr('コメントを読む')}">${icon('chevron')}</button>`
      : '';
    return `<div ${this.cardAttrs('marker', m, depth, '')}>
      <div class="card-row">
        ${this.markerIcon(m)}
        <div class="card-main" data-act="seek" title="${tr('クリックでこの目印へ移動・ダブルクリックでそこから再生')}"><span class="card-time">${fmt(m.t, true)}</span>${tagChips(m.tags)}${text}</div>
        ${this.leadBtn()}
        ${like}
        ${this.whoChip(sh)}
        ${chev}
      </div>
      ${open ? `<div class="card-detail" data-act="noop">${this.threadHtml(m)}</div>` : ''}
    </div>`;
  }

  // 「プレイリストに入れる」ボタン（入っていれば「外す」）。目印は開いた詳細の中に出す
  plBtn(o, asText = false) {
    const on = this.app.playlist.has(this.app.store.doc?.id, o.id);
    const title = on
      ? tr('プレイリストから外す')
      : tr('プレイリストに入れる（ライブラリの右側で並べ替えて、動画をまたいで続けて再生できます）');
    if (asText) {
      return `<button class="btn tiny${on ? ' on' : ''}" data-act="pl" title="${title}" aria-pressed="${on}">${icon(on ? 'check' : 'list-add')} ${on ? tr('プレイリストに入っています') : tr('プレイリストに入れる')}</button>`;
    }
    return `<button class="act pl${on ? ' on' : ''}" data-act="pl" title="${title}" aria-label="${title}" aria-pressed="${on}">${icon(on ? 'check' : 'list-add')}</button>`;
  }

  // ---- 操作 ----

  saveMemo(el) {
    const { store, ui } = this.app;
    const id = el.closest('.card').dataset.id;
    const c = store.getCell(id);
    const value = el.value.replace(/\s+$/, '');
    ui.editingMemo = null;
    if (c && c.memo !== value) store.updateCell(id, { memo: value });
    else this.render();
  }

  postComment(card) {
    const ta = card.querySelector('[data-field="comment"]');
    const text = ta.value.trim();
    if (!text) {
      ta.focus();
      return;
    }
    ta.value = '';
    this.app.store.addComment(card.dataset.kind, card.dataset.id, text, this.app.now());
  }

  onClick(e) {
    const sact = e.target.closest('[data-sact]')?.dataset.sact;
    if (sact === 'merge') return this.app.mergeSelectedCells();
    if (sact === 'clear') return this.app.clearCellSelect();
    const card = e.target.closest('.card');
    const actEl = e.target.closest('[data-act]');
    if (!card || !actEl) return;
    const { app } = this;
    const { store, ui } = app;
    const kind = card.dataset.kind;
    const id = card.dataset.id;
    const o = store.getItem(kind, id);
    if (!o) return;
    const update = (patch) => (kind === 'cell' ? store.updateCell(id, patch) : store.updateMarker(id, patch));
    const toggleIn = (set) => {
      if (set.has(id)) set.delete(id);
      else set.add(id);
      this.render();
    };

    const act = actEl.dataset.act;
    // 共有で読み込んだものは編集しない
    if (o.src && !SHARED_ACTS.has(act)) return;
    // 移動するボタンは、すばやく2回押すと移動したうえで再生を始める
    if (act === 'seek' || act === 'lead' || act === 'jump') app.noteJump(`${id}:${act}:${actEl.dataset.t ?? ''}`);

    switch (act) {
      case 'seek':
        if (kind === 'cell') app.seek(o.s);
        else app.focusMarker(id);
        break;
      case 'jump':
        app.seek(Number(actEl.dataset.t));
        break;
      case 'lead':
        if (actEl.dataset.t !== undefined) app.seek(app.leadTime(Number(actEl.dataset.t)));
        else if (kind === 'cell') app.seek(app.leadTime(o.s));
        else app.focusMarker(id, true);
        break;
      case 'edit-memo':
        ui.editingMemo = id;
        this.focusMemo = true;
        this.render();
        break;
      case 'cycle':
        update({ lv: (o.lv + 1) % 4 });
        break;
      case 'bm':
        update({ bm: !o.bm });
        break;
      case 'repeat':
        app.toggleRepeat(id);
        break;
      case 'split':
        app.splitCellAt(id);
        break;
      case 'pl': {
        const added = app.playlist.toggle(store.doc, kind, o);
        app.hint(
          added
            ? tr('プレイリストに入れました（{n} 件目）。ライブラリ（L）の右側で並べ替え・再生できます', { n: app.playlist.items.length })
            : tr('プレイリストから外しました'),
        );
        break;
      }
      case 'tx':
        toggleIn(ui.txOpen);
        break;
      case 'txcopy': {
        const text = cuesIn(store.cues, o.s, o.e).map(({ cue }) => cue.text).join('\n');
        navigator.clipboard.writeText(text).then(
          () => app.hint(tr('{range} の文字起こしをコピーしました', { range: `${fmt(o.s)} – ${fmt(o.e)}` })),
          () => app.hint(tr('コピーできませんでした')),
        );
        break;
      }
      case 'talk':
        toggleIn(ui.commentsOpen);
        if (ui.commentsOpen.has(id)) this.listEl.querySelector(`.card[data-id="${id}"] [data-field="comment"]`)?.focus();
        break;
      case 'toggle':
        toggleIn(ui.expanded);
        break;
      case 'post':
        this.postComment(card);
        break;
      case 'nudge':
      case 'setnow': {
        const edge = actEl.dataset.edge;
        const value = actEl.dataset.act === 'setnow' ? app.now() : o[edge] + Number(actEl.dataset.d);
        if (kind === 'cell') app.moveCellEdge(id, edge, value);
        else app.moveMarker(id, value);
        break;
      }
      case 'delc':
        store.deleteComment(kind, id, actEl.dataset.cid);
        break;
      case 'select':
        app.toggleCellSelect(id);
        break;
      case 'markflag':
        store.updateMarker(id, { mark: !o.mark });
        break;
      case 'deltag':
        store.updateMarker(id, { tags: o.tags.filter((t) => t !== actEl.dataset.tag) });
        break;
      case 'delete':
        if (kind === 'cell') store.deleteCell(id);
        else store.deleteMarker(id);
        app.hint(kind === 'cell' ? tr('セルを削除しました（Ctrl+Z で元に戻せます）') : tr('目印を削除しました（Ctrl+Z で元に戻せます）'));
        break;
    }
  }

  onKeydown(e) {
    const f = e.target;
    if (!f.dataset.field || e.isComposing || e.keyCode === 229) return;
    const card = f.closest('.card');
    if (f.dataset.field === 'memo') {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.app.ui.editingMemo = null;
        this.render();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.saveMemo(f);
      }
      return;
    }
    // コメント欄
    if (e.key === 'Escape') {
      f.blur();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.postComment(card);
    }
  }
}

// 中身に合わせて高さを伸ばす
function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}
