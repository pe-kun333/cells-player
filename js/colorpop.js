import { $, fmt, icon, clamp } from './util.js';
import { saveSettings, DEFAULT_CELL_COLORS } from './store.js';
import { tr } from './i18n.js';

// セルに色を付けるポップアップ（右のセルのカード・タイムラインのセルのメニュー・いまのセルのバーの「色」ボタンから）。
// 登録した6色から選ぶと、そのセルの枠（タイムラインのバーの枠も）がその色になる。もう一度押すと外れる。
// 「色を登録」で6色を選び直せる（セルには何番目の色かを持たせているので、選び直すと同じ番号のセルの色もまとめて変わる）
export class ColorPop {
  constructor(app) {
    this.app = app;
    this.el = $('#colorPop');
    this.cur = null; // { id, anchor, sel, editing }
    this.paintQueued = false;
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('input', (e) => this.onInput(e));
    // 外を押したら閉じる（開いたボタンをもう一度押したときは、そのボタンの方で閉じる）
    document.addEventListener('pointerdown', (e) => {
      if (this.cur && !this.el.contains(e.target) && !this.anchorEl()?.contains(e.target)) this.close();
    }, true);
    // Esc はこのポップアップだけを閉じる（下にタイムラインのメニューが開いていても、そちらは残す）
    window.addEventListener('keydown', (e) => {
      if (!this.cur || e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }, true);
    window.addEventListener('resize', () => this.close());
    // 開いたボタンが一緒に動くスクロールのときだけ閉じる（ボタンから離れて浮いたままにしない）。
    // 再生に合わせてほかの一覧が自動でスクロールしても閉じない。色を登録している間は閉じない（色を選ぶ画面が消えないように）
    document.addEventListener('scroll', (e) => {
      if (!this.cur || this.cur.editing) return;
      const t = e.target;
      if (t !== document && this.el.contains(t)) return;
      const a = this.anchorEl();
      if (t === document || (a && t.contains?.(a))) this.close();
    }, true);
  }

  get isOpen() {
    return !!this.cur;
  }

  // anchor: 押した「色」ボタン（その下に出す）。同じボタンをもう一度押すと閉じる
  open(id, anchor) {
    const sel = this.selectorFor(id, anchor);
    if (this.cur && this.cur.id === id && this.cur.sel === sel) {
      this.close();
      return;
    }
    this.cur = { id, anchor, sel, editing: false };
    this.render();
    if (this.cur) this.place();
  }

  // 開いたボタンの探し方（一覧やメニューが描き直されると、ボタンは新しい要素になるため）
  selectorFor(id, anchor) {
    if (anchor?.closest('#sideList')) return `#sideList .card[data-id="${id}"] [data-act="color"]`;
    if (anchor?.closest('#tlMenu')) return '#tlMenu [data-tlm="c-color"]';
    if (anchor?.closest('#cellBar')) return '#cellBar [data-cb="color"]';
    return '';
  }

  // いまの「色」ボタン（描き直されていたら探し直す。見つからなければ null）
  anchorEl() {
    const cur = this.cur;
    if (!cur) return null;
    if (!cur.anchor?.isConnected) cur.anchor = cur.sel ? document.querySelector(cur.sel) : null;
    return cur.anchor;
  }

  close() {
    if (!this.cur) return;
    this.cur = null;
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  // メモが変わったとき（main の renderAll から）: セルがなくなったら閉じ、色が変わったら選んでいる色を描き直す。
  // 色を登録している間は描き直さない（色を選ぶ画面が閉じてしまうので）
  refresh() {
    if (!this.cur) return;
    const c = this.app.store.getCell(this.cur.id);
    if (!c || c.src) {
      this.close();
      return;
    }
    if (!this.cur.editing) this.render();
  }

  render() {
    const c = this.app.store.getCell(this.cur.id);
    if (!c || c.src) {
      this.close();
      return;
    }
    const colors = this.app.settings.cellColors;
    const n = c.color | 0;
    const editing = this.cur.editing;
    const head = `<div class="cpop-head">${icon('palette')}<b>${editing ? tr('色を登録') : tr('セルの色')}</b><span class="cpop-sub">${fmt(c.s)}–${fmt(c.e)}</span>
      <button type="button" class="cpop-x" data-cpop="close" title="${tr('閉じる (Esc)')}" aria-label="${tr('閉じる')}">${icon('x')}</button></div>`;
    let body;
    if (editing) {
      const inputs = colors
        .map((hex, i) => `<label class="cpop-edit" title="${tr('色 {n} を選び直す', { n: i + 1 })}"><input type="color" value="${hex}" data-slot="${i}" aria-label="${tr('色 {n}', { n: i + 1 })}"><span>${i + 1}</span></label>`)
        .join('');
      body = `<div class="cpop-grid">${inputs}</div>
        <div class="cpop-note">${tr('丸を押して色を選び直します。その番号の色を付けたセルも、まとめて変わります')}</div>
        <div class="cpop-foot">
          <button type="button" data-cpop="reset">${tr('はじめの6色に戻す')}</button>
          <span class="spacer"></span>
          <button type="button" class="primary" data-cpop="done">${tr('完了')}</button>
        </div>`;
    } else {
      const swatches = colors
        .map((hex, i) => {
          const on = n === i + 1;
          const label = on ? tr('色 {n}（もう一度押すと外す）', { n: i + 1 }) : tr('色 {n}', { n: i + 1 });
          return `<button type="button" class="cpop-sw${on ? ' on' : ''}" data-color="${i + 1}" style="--sw:${hex}" title="${label}" aria-label="${label}" aria-pressed="${on}"><span>${i + 1}</span></button>`;
        })
        .join('');
      body = `<div class="cpop-grid">${swatches}</div>
        <div class="cpop-foot">
          <button type="button" data-cpop="none"${n ? '' : ' disabled'}>${tr('色なし')}</button>
          <span class="spacer"></span>
          <button type="button" data-cpop="edit" title="${tr('6つの色を選び直す')}">${icon('pencil')}${tr('色を登録')}</button>
        </div>`;
    }
    this.el.innerHTML = head + body;
    this.el.hidden = false;
  }

  // 押したボタンのすぐ下に出す（下に入らなければ上）。ボタンが見つからないときは、いまの位置のまま
  place() {
    const el = this.el;
    const a = this.anchorEl();
    const r = a ? a.getBoundingClientRect() : null;
    const prevLeft = parseFloat(el.style.left);
    const prevTop = parseFloat(el.style.top);
    const placed = Number.isFinite(prevLeft) && prevLeft > -9000 && Number.isFinite(prevTop);
    el.style.left = '-9999px';
    el.style.top = '0px';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = (vw - w) / 2;
    let top = (vh - h) / 2;
    if (r) {
      x = r.left;
      top = r.bottom + 6;
      if (top + h > vh - 8) top = r.top - h - 6;
    } else if (placed) {
      x = prevLeft;
      top = prevTop;
    }
    el.style.left = clamp(x, 8, vw - w - 8) + 'px';
    el.style.top = clamp(top, 8, Math.max(8, vh - h - 8)) + 'px';
  }

  onClick(e) {
    const b = e.target.closest('button');
    if (!b || !this.cur) return;
    const { app } = this;
    const { store } = app;
    const c = store.getCell(this.cur.id);
    if (!c) return this.close();
    if (b.dataset.color) {
      const n = Number(b.dataset.color);
      // 同じ色をもう一度押すと外す
      store.updateCell(c.id, { color: (c.color | 0) === n ? 0 : n });
      this.close();
      return;
    }
    switch (b.dataset.cpop) {
      case 'close':
        this.close();
        break;
      case 'none':
        store.updateCell(c.id, { color: 0 });
        this.close();
        break;
      case 'edit':
      case 'done':
        this.cur.editing = b.dataset.cpop === 'edit';
        this.render();
        this.place();
        break;
      case 'reset':
        this.setColors([...DEFAULT_CELL_COLORS]);
        this.render();
        break;
    }
  }

  // 色を選ぶ画面で動かしている間も、セルの枠の色をその場で変える（続けて変わった分は、まとめて描き直す）
  onInput(e) {
    const inp = e.target;
    if (inp.type !== 'color' || inp.dataset.slot === undefined) return;
    const v = String(inp.value).toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(v)) return;
    const next = [...this.app.settings.cellColors];
    next[Number(inp.dataset.slot)] = v;
    this.setColors(next);
  }

  setColors(list) {
    this.app.settings.cellColors = list;
    saveSettings(this.app.settings);
    if (this.paintQueued) return;
    this.paintQueued = true;
    setTimeout(() => {
      this.paintQueued = false;
      this.app.refreshSelection();
    }, 30);
  }
}
