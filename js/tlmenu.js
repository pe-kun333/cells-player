import { $, fmt, fmtLen, escapeHtml, icon, cellLabel, clamp } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// タイムラインをクリックしたときのメニュー（区間・目印・セル）。
// 再生位置を動かさずに、いいね・コメント・位置の調整・セル化などができる（移動・再生はメニューから選ぶ）。
// クリックしたときにメニューを出すか、これまでのようにすぐ動くかは、種類ごとにメニューの下で選べる。
// 右クリックなら、どちらの設定でもメニューを出す
const CLICK_OPTS = {
  seg: [['menu', 'メニューを出す'], ['cell', 'すぐセルにする'], ['seek', 'その区間の頭へ移動']],
  marker: [['menu', 'メニューを出す（再生位置は動かさない）'], ['seek', 'その目印へ移動']],
  cell: [['menu', 'メニューを出す（再生位置は動かさない）'], ['seek', 'セルの頭へ移動']],
};
const SETTING = { seg: 'tlSegClick', marker: 'tlMarkerClick', cell: 'tlCellClick' };
const NUDGES = [-1, -0.1, 0.1, 1];

// n 個の塗りつぶしのハート（いいねのボタン）
const heartsN = (n) => `<span class="hearts">${'<svg class="i h on" aria-hidden="true"><use href="#i-heart"/></svg>'.repeat(n)}</span>`;

export class TlMenu {
  constructor(app) {
    this.app = app;
    this.el = $('#tlMenu');
    this.cur = null; // { kind: 'seg' | 'marker' | 'cell', id, s, e, x, y }
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('keydown', (e) => this.onKeydown(e));
    // メニューの外を押したら閉じる（メニューを開いたクリックより先に動くよう、捕捉の段階で見る）
    document.addEventListener('pointerdown', (e) => {
      if (this.cur && !this.el.contains(e.target)) this.close();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!this.cur || e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }, true);
    window.addEventListener('resize', () => this.close());
    // タイムラインごと動くスクロールのときだけ閉じる（再生に合わせて一覧が自動でスクロールしても閉じない）
    document.addEventListener('scroll', (e) => {
      const t = e.target;
      if (this.cur && (t === document || t.contains?.($('#timeline')))) this.close();
    }, true);
  }

  // クリックしたときの動き（'menu' か、すぐ動く 'cell' / 'seek'）
  mode(kind) {
    return this.app.settings[SETTING[kind]] || 'menu';
  }

  open(cur) {
    this.cur = cur;
    this.render();
    if (this.cur) this.place();
  }

  close() {
    if (!this.cur) return;
    this.cur = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  // メモが変わったとき（main の renderAll から）: 開いていれば描き直す。書きかけのコメントは残す
  refresh() {
    if (!this.cur) return;
    const inp = this.el.querySelector('[data-tlm-input]');
    const text = inp?.value || '';
    const focused = inp && document.activeElement === inp;
    this.render();
    const next = this.el.querySelector('[data-tlm-input]');
    if (next && text) next.value = text;
    if (next && focused) next.focus();
  }

  // クリックした位置の近くに出す（画面からはみ出さないように）
  place() {
    const el = this.el;
    el.style.left = '-9999px';
    el.style.top = '0px';
    el.hidden = false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const { x, y } = this.cur;
    const left = clamp(x - w / 2, 8, window.innerWidth - w - 8);
    let top = y + 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    el.style.left = left + 'px';
    el.style.top = clamp(top, 8, Math.max(8, window.innerHeight - h - 8)) + 'px';
  }

  render() {
    const c = this.cur;
    const { store } = this.app;
    let html = '';
    if (c.kind === 'seg') html = this.segHtml(c);
    else if (c.kind === 'marker') {
      const m = store.getMarker(c.id);
      if (!m) return this.close();
      html = this.markerHtml(m);
    } else {
      const x = store.getCell(c.id);
      if (!x) return this.close();
      html = this.cellHtml(x);
    }
    this.el.innerHTML = html + this.footHtml(c.kind);
    this.el.hidden = false;
  }

  head(iconName, title, sub) {
    return `<div class="tlm-head">${icon(iconName)}<b>${title}</b>${sub ? `<span class="tlm-sub">${sub}</span>` : ''}
      <button type="button" class="tlm-x" data-tlm="close" title="${tr('閉じる (Esc)')}" aria-label="${tr('閉じる')}">${icon('x')}</button></div>`;
  }

  footHtml(kind) {
    const cur = this.mode(kind);
    const opts = CLICK_OPTS[kind].map(([v, label]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${tr(label)}</option>`).join('');
    return `<label class="tlm-foot" title="${tr('右クリックなら、いつでもこのメニューを出せます')}">${tr('クリックしたとき')}<select data-tlm-mode="${kind}">${opts}</select></label>`;
  }

  likeRow(o, act) {
    const likes = [1, 2, 3]
      .map((n) => `<button type="button" class="${o.lv === n ? 'on' : ''}" data-tlm="${act}-like" data-lv="${n}" title="${tr('いいね {n}（もう一度押すと外す）', { n })}">${heartsN(n)}</button>`)
      .join('');
    return `${likes}<button type="button" class="${o.bm ? 'on' : ''}" data-tlm="${act}-bm" title="${tr('ブックマーク')}" aria-pressed="${!!o.bm}">${icon('bookmark', o.bm ? 'fill' : '')}</button>`;
  }

  // ---- 区間 ----

  segHtml({ s, e }) {
    const cell = this.app.store.findCell(s, e);
    return `${this.head('cell', `${fmt(s)} – ${fmt(e)}`, fmtLen(e - s))}
      <div class="tlm-row">
        <button type="button" data-tlm="seg-play">${icon('play')} ${tr('ここから再生')}</button>
        <button type="button" data-tlm="seg-seek">${tr('頭へ移動')}</button>
      </div>
      <div class="tlm-row">
        ${cell
          ? `<button type="button" data-tlm="seg-open">${icon('cell')} ${tr('セルを見る')}</button>`
          : `<button type="button" class="primary" data-tlm="seg-cell">${icon('cell')} ${tr('セルにする')}</button>`}
        <button type="button" data-tlm="seg-repeat">${icon('repeat')} ${cell ? tr('リピート') : tr('セルにしてリピート')}</button>
      </div>`;
  }

  // ---- 目印 ----

  markerHtml(m) {
    const { store, settings } = this.app;
    const sh = store.shareOf(m);
    const kind = m.mark ? tr('区切りの目印') : tr('いいね・コメントの目印');
    const comments = m.comments.length
      ? `<div class="tlm-comments">${m.comments.map((cm) => `<div class="tlm-comment">${escapeHtml(cm.text)}</div>`).join('')}</div>`
      : '';
    const moveRow = `<div class="tlm-row">
        <button type="button" data-tlm="m-play">${icon('play')} ${tr('ここから再生')}</button>
        <button type="button" data-tlm="m-seek">${tr('移動')}</button>
        <button type="button" data-tlm="m-lead">${tr('{s}秒前から', { s: settings.leadIn })}</button>
      </div>`;
    if (sh) {
      return `${this.head('pin', fmt(m.t, true), escapeHtml(tr('{name} さんの共有', { name: sh.by })))}
        ${moveRow}${comments}
        <div class="tlm-note">${tr('共有で読み込んだ目印は編集できません（いいね・コメントは、移動してから自分の目印に付けられます）')}</div>`;
    }
    const tags = m.tags.length
      ? `<div class="tlm-row">${m.tags.map((t) => `<span class="tag-chip tag-edit">${escapeHtml(t)}<button type="button" data-tlm="m-deltag" data-tag="${escapeHtml(t)}" title="${tr('このタグを外す')}" aria-label="${escapeHtml(tr('{tag}を外す', { tag: t }))}">${icon('x')}</button></span>`).join('')}</div>`
      : '';
    const nudges = NUDGES.map((d) => `<button type="button" data-tlm="m-nudge" data-d="${d}">${d > 0 ? '+' : '−'}${Math.abs(d)}</button>`).join('');
    return `${this.head('pin', fmt(m.t, true), kind)}
      ${moveRow}
      <div class="tlm-row">${this.likeRow(m, 'm')}</div>
      ${tags}${comments}
      <input type="text" class="field tlm-input" data-tlm-input="comment" placeholder="${tr('コメントを書く（Enter で追加）')}" autocomplete="off">
      <div class="tlm-row"><span class="tlm-label">${tr('位置')}</span>${nudges}</div>
      <div class="tlm-row">
        <button type="button" data-tlm="m-left">${tr('← 左の区間をセルに')}</button>
        <button type="button" data-tlm="m-right">${tr('右の区間をセルに →')}</button>
      </div>
      <div class="tlm-row">
        <label class="tlm-check"><input type="checkbox" data-tlm-chk="mark"${m.mark ? ' checked' : ''}> ${tr('区間の区切りにする')}</label>
        <span class="spacer"></span>
        <button type="button" class="danger" data-tlm="m-del">${icon('trash')} ${tr('削除')}</button>
      </div>`;
  }

  // ---- セル ----

  cellHtml(c) {
    const { store, ui } = this.app;
    const sh = store.shareOf(c);
    const memo = cellLabel(c, 60);
    const rep = ui.repeatId === c.id;
    const moveRow = `<div class="tlm-row">
        <button type="button" data-tlm="c-play">${icon('play')} ${tr('頭から再生')}</button>
        <button type="button" data-tlm="c-seek">${tr('頭へ移動')}</button>
        <button type="button" class="${rep ? 'on' : ''}" data-tlm="c-repeat">${icon('repeat')} ${rep ? tr('リピートを止める') : tr('リピート')}</button>
      </div>`;
    const memoHtml = `<div class="tlm-memo${memo ? '' : ' muted'}">${memo ? escapeHtml(memo) : tr('（メモなし）')}</div>`;
    if (sh) {
      return `${this.head('cell', `${fmt(c.s)} – ${fmt(c.e)}`, escapeHtml(tr('{name} さんの共有', { name: sh.by })))}
        ${memoHtml}${moveRow}
        <div class="tlm-row"><button type="button" data-tlm="c-open">${tr('カードを開く（メモ・コメント）')}</button></div>`;
    }
    const inPl = this.app.playlist.has(store.doc?.id, c.id);
    return `${this.head('cell', `${fmt(c.s)} – ${fmt(c.e)}`, fmtLen(c.e - c.s))}
      ${memoHtml}${moveRow}
      <div class="tlm-row">${this.likeRow(c, 'c')}
        <button type="button" class="${inPl ? 'on' : ''}" data-tlm="c-pl" title="${inPl ? tr('プレイリストから外す') : tr('プレイリストに入れる')}">${icon(inPl ? 'check' : 'list-add')}</button>
      </div>
      <div class="tlm-row">
        <button type="button" data-tlm="c-open">${tr('カードを開く（メモ・コメント）')}</button>
        <span class="spacer"></span>
        <button type="button" class="danger" data-tlm="c-del">${icon('trash')} ${tr('削除')}</button>
      </div>`;
  }

  // ---- 操作 ----

  play(t) {
    this.app.seek(t);
    this.app.player?.play();
  }

  onClick(e) {
    const b = e.target.closest('[data-tlm]');
    if (!b || !this.cur) return;
    const { app } = this;
    const { store } = app;
    const cur = this.cur;
    const act = b.dataset.tlm;
    if (act === 'close') return this.close();

    if (cur.kind === 'seg') {
      const { s, e: end } = cur;
      const cell = store.findCell(s, end);
      if (act === 'seg-play') this.play(s);
      else if (act === 'seg-seek') app.seek(s);
      else if (act === 'seg-cell') app.createCell(s, end);
      else if (act === 'seg-open' && cell) app.revealCell(cell.id);
      else if (act === 'seg-repeat') {
        const c = cell || app.createCell(s, end);
        if (c && app.ui.repeatId !== c.id) app.toggleRepeat(c.id);
      }
      return this.close();
    }

    if (cur.kind === 'marker') {
      const m = store.getMarker(cur.id);
      if (!m) return this.close();
      switch (act) {
        case 'm-play':
          this.play(m.t);
          return this.close();
        case 'm-seek':
          app.focusMarker(m.id);
          return this.close();
        case 'm-lead':
          app.focusMarker(m.id, true);
          return this.close();
        case 'm-like': {
          const lv = Number(b.dataset.lv);
          store.updateMarker(m.id, { lv: m.lv === lv ? 0 : lv });
          return;
        }
        case 'm-bm':
          store.updateMarker(m.id, { bm: !m.bm });
          return;
        case 'm-deltag':
          store.updateMarker(m.id, { tags: m.tags.filter((t) => t !== b.dataset.tag) });
          return;
        case 'm-nudge':
          app.moveMarker(m.id, m.t + Number(b.dataset.d));
          return;
        case 'm-left':
        case 'm-right':
          app.cellBeside(m.t, act === 'm-left' ? 'left' : 'right');
          return this.close();
        case 'm-del':
          store.deleteMarker(m.id);
          app.hint(tr('目印を削除しました（Ctrl+Z で元に戻せます）'));
          return this.close();
      }
      return;
    }

    const c = store.getCell(cur.id);
    if (!c) return this.close();
    switch (act) {
      case 'c-play':
        this.play(c.s);
        return this.close();
      case 'c-seek':
        app.seek(c.s);
        return this.close();
      case 'c-repeat':
        app.toggleRepeat(c.id);
        return this.close();
      case 'c-like': {
        const lv = Number(b.dataset.lv);
        store.updateCell(c.id, { lv: c.lv === lv ? 0 : lv });
        return;
      }
      case 'c-bm':
        store.updateCell(c.id, { bm: !c.bm });
        return;
      case 'c-pl':
        app.playlist.toggle(store.doc, 'cell', c);
        this.refresh();
        return;
      case 'c-open':
        app.revealCell(c.id);
        return this.close();
      case 'c-del':
        store.deleteCell(c.id);
        app.hint(tr('セルを削除しました（Ctrl+Z で元に戻せます）'));
        return this.close();
    }
  }

  onChange(e) {
    const t = e.target;
    if (t.dataset.tlmMode) {
      // クリックしたときの動きを切り替える（次のクリックから）
      const kind = t.dataset.tlmMode;
      this.app.settings[SETTING[kind]] = t.value;
      saveSettings(this.app.settings);
      this.app.onTlClickMode();
      this.app.hint(tr('次から、クリックしたときは「{what}」にします（右クリックならいつでもメニュー）', { what: tr(CLICK_OPTS[kind].find(([v]) => v === t.value)[1]) }));
      return;
    }
    if (t.dataset.tlmChk === 'mark' && this.cur?.kind === 'marker') {
      this.app.store.updateMarker(this.cur.id, { mark: t.checked });
    }
  }

  onKeydown(e) {
    const inp = e.target.closest?.('[data-tlm-input]');
    if (!inp || e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const text = inp.value.trim();
    const m = this.cur?.kind === 'marker' && this.app.store.getMarker(this.cur.id);
    if (!text || !m) return;
    inp.value = '';
    this.app.store.addComment('marker', m.id, text, m.t);
    this.app.hint(tr('{time} の目印にコメントしました', { time: fmt(m.t, true) }));
    this.el.querySelector('[data-tlm-input]')?.focus();
  }
}
