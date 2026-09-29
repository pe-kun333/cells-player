import { $, fmt, fmtLen, fmtDate, escapeHtml, hearts, icon, commentSummary, tagChips } from './util.js';
import { saveSettings } from './store.js';
import { cuesIn } from './transcript.js';

const NUDGES = [-1, -0.1, 0.1, 1];

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
      '<option value="">タグ: すべて</option>' +
      names.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}（${counts.get(t)}）</option>`).join('');
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
    this.countEl.textContent = store.doc ? `セル ${store.cells.length}・目印 ${store.markers.length}` : '';
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
      } else {
        el.classList.toggle('is-target', el.dataset.id === tid);
        el.classList.toggle('is-now', el.dataset.id === nearId);
      }
    }
  }

  emptyHtml() {
    const { ui, store } = this.app;
    if (!store.doc) return '<div class="side-empty">動画や音声を開くと、ここにセルや目印が並びます。</div>';
    if (ui.query.trim()) return `<div class="side-empty">「${escapeHtml(ui.query.trim())}」に一致するものはありません。</div>`;
    if (ui.minLike || ui.bmOnly || ui.tag) return '<div class="side-empty">条件に合うものがありません。</div>';
    if (ui.tab === 'markers') {
      return '<div class="side-empty">目印はまだありません。<br>M キーで、再生を止めずに目印を付けられます。</div>';
    }
    return '<div class="side-empty">セルはまだありません。<br>タイムラインの「区間」をクリックするか、Enter キーでいまいる区間をセルにできます。</div>';
  }

  // セルを選んでいるときに一覧の上に出る帯（連結・選択の解除）
  selbarHtml() {
    const n = this.app.ui.selectedCells.size;
    if (!n) return '';
    return `<div class="selbar">
      <span class="selbar-count">${n}件のセルを選択中</span>
      <span class="spacer"></span>
      <button class="btn small primary" data-sact="merge" title="選んだセルを1つにまとめる">連結</button>
      <button class="btn small" data-sact="clear" title="選択を解除 (Esc)">解除</button>
    </div>`;
  }

  cardAttrs(kind, o, depth, extra) {
    const d = Math.min(depth, 4);
    const cls = `card ${kind}-card${d ? ' is-nested' : ''}${this.app.ui.expanded.has(o.id) ? ' is-open' : ''}${extra}`;
    return `class="${cls}" data-kind="${kind}" data-id="${o.id}" style="--depth:${d}"`;
  }

  // ---- セル（ポスト風のカード） ----

  cellHtml(c, depth) {
    const { ui } = this.app;
    const rep = ui.repeatId === c.id;
    const open = ui.expanded.has(c.id);
    const talk = ui.commentsOpen.has(c.id);
    const tx = ui.txOpen.has(c.id) && this.app.store.cues.length > 0;
    const memo =
      ui.editingMemo === c.id
        ? `<div class="memo-edit" data-act="noop">
            <textarea class="memo-input" data-field="memo" data-key="memo-${c.id}" rows="2" placeholder="このセルのメモ">${escapeHtml(c.memo)}</textarea>
            <div class="memo-hint">Enter で改行・Ctrl+Enter か外をクリックで保存・Esc で取り消し</div>
          </div>`
        : `<div class="memo${c.memo ? '' : ' is-empty'}" data-act="edit-memo" title="クリックで編集">${c.memo ? escapeHtml(c.memo) : 'メモを書く…'}</div>`;
    const pips = [1, 2, 3].map((n) => `<i class="${n <= c.lv ? 'on' : ''}"></i>`).join('');
    const selected = ui.selectedCells.has(c.id);
    return `<article ${this.cardAttrs('cell', c, depth, (rep ? ' is-repeat' : '') + (selected ? ' is-selected' : ''))}>
      <div class="cell-head">
        <button class="tbtn" data-act="seek" title="クリックでセルの先頭へ移動・ダブルクリックでそこから再生">${fmt(c.s, true)}–${fmt(c.e, true)}</button>
        ${this.leadBtn()}
        <span class="cell-len">${fmtLen(c.e - c.s)}</span>
        <span class="badge-now">再生中</span>
        ${rep ? `<span class="badge-rep">${icon('repeat')}リピート中</span>` : ''}
        <span class="spacer"></span>
        <input type="checkbox" class="cell-check" data-act="select"${selected ? ' checked' : ''} title="連結するセルとして選ぶ" aria-label="このセルを選ぶ">
        <button class="tool" data-act="toggle" title="${open ? '閉じる' : '範囲の調整・削除'}" aria-label="その他">${icon('dots')}</button>
      </div>
      ${memo}
      <div class="actions">
        <button class="act like" data-act="cycle" data-lv="${c.lv}" title="いいね（押すたびに 1 → 2 → 3 → 解除）">${icon('heart', c.lv ? 'fill' : '')}<span class="pips">${pips}</span></button>
        <button class="act mark${c.bm ? ' on' : ''}" data-act="bm" title="ブックマーク" aria-pressed="${c.bm}">${icon('bookmark', c.bm ? 'fill' : '')}</button>
        <button class="act talk${talk ? ' open' : ''}" data-act="talk" title="コメント" aria-expanded="${talk}">${icon('comment')}${c.comments.length ? `<span class="n">${c.comments.length}</span>` : ''}</button>
        <button class="act rep${rep ? ' on' : ''}" data-act="repeat" title="リピート再生（同時に1つだけ）">${icon('repeat')}<span>リピート</span></button>
        ${this.app.store.cues.length ? `<button class="act tx${tx ? ' open' : ''}" data-act="tx" title="この区間の文字起こし" aria-expanded="${tx}">${icon('text')}<span>文字起こし</span></button>` : ''}
      </div>
      ${tx ? this.txHtml(c) : ''}
      ${talk ? this.threadHtml(c) : ''}
      ${open ? this.cellDetail(c) : ''}
    </article>`;
  }

  // セルの区間の文字起こし。行を押すとその位置へ（すばやく2回で再生）、再生中の行は強調する
  txHtml(c) {
    const lines = cuesIn(this.app.store.cues, c.s, c.e);
    if (!lines.length) return '<div class="txpanel" data-act="noop"><p class="thread-empty">この区間に字幕・文字起こしはありません。</p></div>';
    const rows = lines
      .map(({ cue, i }) => `<div class="tx-line" data-act="jump" data-t="${cue.s}" data-i="${i}" title="クリックでこの位置へ・ダブルクリックで再生"><span class="tx-t">${fmt(cue.s)}</span><span class="tx-x">${escapeHtml(cue.text)}</span></div>`)
      .join('');
    return `<div class="txpanel" data-act="noop">
      <div class="tx-lines">${rows}</div>
      <div class="tx-foot"><span>${lines.length} 行</span><span class="spacer"></span><button class="btn tiny" data-act="txcopy">テキストをコピー</button></div>
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
      ${this.edgeRow('開始', 's', c.s)}
      ${this.edgeRow('終了', 'e', c.e)}
      <div class="detail-foot"><button class="btn tiny danger" data-act="delete">${icon('trash')} セルを削除</button></div>
    </div>`;
  }

  edgeRow(label, edge, t) {
    const nudges = NUDGES.map(
      (d) => `<button class="btn tiny" data-act="nudge" data-edge="${edge}" data-d="${d}">${d > 0 ? '+' : '−'}${Math.abs(d)}</button>`,
    ).join('');
    return `<div class="edge-row"><span class="edge-label">${label}</span><span class="edge-time">${fmt(t, true)}</span>${nudges}<button class="btn tiny" data-act="setnow" data-edge="${edge}">現在位置</button></div>`;
  }

  // コメントはポストの形で並べ、下の欄から投稿する
  threadHtml(o) {
    const posts = o.comments.map((cm) => this.postHtml(cm)).join('');
    return `<div class="thread" data-act="noop">
      ${posts ? `<div class="posts">${posts}</div>` : '<p class="thread-empty">まだコメントはありません。書いた時点の再生位置と一緒に残ります。</p>'}
      <div class="compose">
        <textarea class="compose-input" data-field="comment" data-key="c-${o.id}" rows="1" placeholder="コメント（Enter で改行・Ctrl+Enter で投稿）"></textarea>
        <button class="btn small primary" data-act="post">投稿</button>
      </div>
    </div>`;
  }

  // 「少し前から」ボタン。t を渡すとその時刻の少し前へ、渡さなければカードの位置の少し前へ移動する
  leadBtn(t) {
    const lead = this.app.settings.leadIn;
    const at = t === undefined ? '' : ` data-t="${t}"`;
    return `<button class="lead-btn" data-act="lead"${at} title="${lead}秒前へ移動（ダブルクリックでそこから再生）">−${lead}秒</button>`;
  }

  postHtml(cm) {
    const time = Number.isFinite(cm.t)
      ? `<button class="tbtn" data-act="jump" data-t="${cm.t}" title="この位置へ移動（ダブルクリックでそこから再生）">${fmt(cm.t)}</button>${this.leadBtn(cm.t)}`
      : '';
    return `<div class="post">
      <div class="avatar" aria-hidden="true">自</div>
      <div class="post-body">
        <div class="post-meta"><span class="who">あなた</span>${cm.at ? `<span>${fmtDate(cm.at)}</span>` : ''}${time}</div>
        <div class="post-text">${escapeHtml(cm.text)}</div>
        <div class="post-acts"><button class="pact" data-act="delc" data-cid="${cm.id}">削除</button></div>
      </div>
    </div>`;
  }

  // ---- 目印（1行のカード） ----

  // ◆ は区間の区切りになる目印、● は瞬間のいいね・コメント。定型コメントがあればキー番号を出す
  markerIcon(m) {
    const nums = this.app.tagNumbers(m.tags).slice(0, 3).join('');
    const kind = m.mark ? '目印（区間の区切り）' : 'この瞬間のいいね・コメント';
    const title = nums ? `${kind}・定型コメント ${m.tags.join('、')}` : kind;
    return `<span class="marker-dot lv${m.lv}${m.mark ? ' is-mark' : ''}${nums ? ' has-num' : ''}" title="${escapeHtml(title)}">${nums}</span>`;
  }

  markerHtml(m, depth) {
    const open = this.app.ui.expanded.has(m.id);
    let text = '<span class="card-text muted">コメントなし</span>';
    if (m.comments.length) text = `<span class="card-text">${escapeHtml(commentSummary(m.comments))}</span>`;
    else if (m.tags.length) text = '';
    const tagEdit = m.tags.length
      ? `<div class="edge-row"><span class="edge-label">タグ</span><span class="tag-chips">${m.tags
          .map((t) => `<span class="tag-chip tag-edit">${escapeHtml(t)}<button data-act="deltag" data-tag="${escapeHtml(t)}" title="このタグを外す" aria-label="${escapeHtml(t)}を外す">${icon('x')}</button></span>`)
          .join('')}</span></div>`
      : '';
    return `<div ${this.cardAttrs('marker', m, depth, '')}>
      <div class="card-row">
        ${this.markerIcon(m)}
        <div class="card-main" data-act="seek" title="クリックでこの目印へ移動・ダブルクリックでそこから再生"><span class="card-time">${fmt(m.t, true)}</span>${tagChips(m.tags)}${text}</div>
        ${this.leadBtn()}
        <button class="like-cycle" data-act="cycle" title="いいね（クリックで 0→1→2→3→0）">${hearts(m.lv)}</button>
        <button class="tool${m.bm ? ' on' : ''}" data-act="bm" title="ブックマーク">${icon('bookmark', m.bm ? 'fill' : '')}</button>
        <button class="tool chev" data-act="toggle" title="${open ? '閉じる' : '詳細・編集'}">${icon('chevron')}</button>
      </div>
      ${open ? `<div class="card-detail" data-act="noop">
        ${this.edgeRow('位置', 't', m.t)}
        <div class="edge-row"><span class="edge-label">区切り</span><label class="check-inline"><input type="checkbox" data-act="markflag"${m.mark ? ' checked' : ''}> 区間の区切りにする</label></div>
        ${tagEdit}
        ${this.threadHtml(m)}
        <div class="detail-foot"><button class="btn tiny danger" data-act="delete">${icon('trash')} 目印を削除</button></div>
      </div>` : ''}
    </div>`;
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
      case 'tx':
        toggleIn(ui.txOpen);
        break;
      case 'txcopy': {
        const text = cuesIn(store.cues, o.s, o.e).map(({ cue }) => cue.text).join('\n');
        navigator.clipboard.writeText(text).then(
          () => app.hint(`${fmt(o.s)} – ${fmt(o.e)} の文字起こしをコピーしました`),
          () => app.hint('コピーできませんでした'),
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
        app.hint(`${kind === 'cell' ? 'セル' : '目印'}を削除しました（Ctrl+Z で元に戻せます）`);
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
