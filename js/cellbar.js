import { $, fmt, escapeHtml, icon, cellLabel } from './util.js';
import { cellColorOf } from './store.js';
import { tr } from './i18n.js';

// いまのセルのバー（タイムラインのすぐ下）: 再生位置にあるセルの操作を、タイムラインの近くにまとめる。
// 分割・始まり／終わりを再生位置に・リピート・いいね・ブックマーク・コメント・そのほか（メニュー）。
// セルが重なっているときは、どれを操作するかを切り替えられる（S もそのセルを分ける）
export class CellBar {
  constructor(app) {
    this.app = app;
    this.el = $('#cellBar');
    this.key = '';
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  // メモが変わったとき（renderAll から）
  render() {
    this.key = '';
    this.tick(this.app.now());
  }

  // 監視から毎回呼ぶ（変わったときだけ描き直す）
  tick(now) {
    const { app } = this;
    if (!app.player || !app.store.doc) {
      if (this.key !== 'off') {
        this.key = 'off';
        this.el.hidden = true;
      }
      return;
    }
    const list = app.cellsAt(now);
    const c = app.cellAt(now);
    const key = c
      ? [c.id, c.s, c.e, c.lv, c.bm, c.color | 0, c.memo, c.comments.length, app.ui.repeatId === c.id, list.length, list.indexOf(c)].join('|')
      : 'none';
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = false;
    if (!c) {
      this.el.innerHTML = `<span class="cb-empty">${tr('再生位置にセルはありません')}</span>
        <span class="spacer"></span>
        <button type="button" data-cb="make" title="${tr('いまいる区間（前後の目印の間）をセルにする (Enter)')}">${icon('cell')}${tr('区間をセル化')}<kbd>Enter</kbd></button>`;
      return;
    }
    const memo = cellLabel(c, 40);
    const rep = app.ui.repeatId === c.id;
    const pips = [1, 2, 3].map((n) => `<i class="${n <= c.lv ? 'on' : ''}"></i>`).join('');
    const cc = cellColorOf(app.settings, c);
    const colorTitle = cc ? tr('色を変える・外す（いまは 色 {n}）', { n: c.color | 0 }) : tr('色を付ける（登録した6色から選ぶ）');
    const left = app.neighborCell(c.id, -1);
    const right = app.neighborCell(c.id, 1);
    const mergeTitle = (n, none) => (n ? tr('{range} のセルと1つにまとめる（メモ・コメントもまとめて入ります。Ctrl+Z で元に戻せます）', { range: `${fmt(n.s)} – ${fmt(n.e)}` }) : none);
    const cycle = list.length > 1
      ? `<button type="button" class="cb-cycle" data-cb="cycle" title="${tr('重なっているセルのうち、操作するセルを切り替える')}">${list.indexOf(c) + 1}/${list.length} ⇄</button>`
      : '';
    this.el.innerHTML = `
      <span class="cb-cell" title="${escapeHtml(`${fmt(c.s, true)} – ${fmt(c.e, true)}  ${memo}`)}">${icon('cell')}<b>${fmt(c.s)}–${fmt(c.e)}</b><span class="cb-memo${memo ? '' : ' muted'}">${memo ? escapeHtml(memo) : tr('（メモなし）')}</span></span>
      ${cycle}
      <span class="cb-acts">
        <button type="button" data-cb="split" title="${tr('再生位置で2つに分ける（メモ・いいね・コメントは前のセルに残ります） (S)')}">${icon('scissors')}${tr('分割')}<kbd>S</kbd></button>
        <button type="button" data-cb="start" title="${tr('セルの始まりを再生位置にする（となりのセルとの境目も一緒に動きます）')}">${tr('⇤ 始まりをここに')}</button>
        <button type="button" data-cb="end" title="${tr('セルの終わりを再生位置にする（となりのセルとの境目も一緒に動きます）')}">${tr('終わりをここに ⇥')}</button>
        <button type="button" class="${rep ? 'on' : ''}" data-cb="repeat" title="${tr('リピート再生（同時に1つだけ）')}">${icon('repeat')}<kbd>R</kbd></button>
        <button type="button" class="cb-like" data-cb="like" data-lv="${c.lv}" title="${tr('いいね（押すたびに 1 → 2 → 3 → 解除）')}">${icon('heart', c.lv ? 'fill' : '')}<span class="pips">${pips}</span></button>
        <button type="button" class="${c.bm ? 'on' : ''}" data-cb="bm" title="${tr('ブックマーク')}" aria-pressed="${c.bm}">${icon('bookmark', c.bm ? 'fill' : '')}</button>
        <button type="button" class="cb-color${cc ? ' on' : ''}" data-cb="color" title="${colorTitle}" aria-label="${colorTitle}" aria-haspopup="dialog">${icon('palette')}${cc ? `<span class="cdot" style="--cc:${cc}"></span>` : ''}</button>
        <button type="button" data-cb="mergeL" title="${mergeTitle(left, tr('前（左）に結合できるセルがありません'))}"${left ? '' : ' disabled'}>${tr('← 結合')}</button>
        <button type="button" data-cb="mergeR" title="${mergeTitle(right, tr('後ろ（右）に結合できるセルがありません'))}"${right ? '' : ' disabled'}>${tr('結合 →')}</button>
        <button type="button" data-cb="comment" title="${tr('このセルにコメントを書く')}">${icon('comment')}${c.comments.length ? `<span class="n">${c.comments.length}</span>` : ''}</button>
        <button type="button" data-cb="more" title="${tr('そのほかの操作（メニュー）')}" aria-label="${tr('そのほかの操作（メニュー）')}">${icon('dots')}</button>
      </span>`;
  }

  onClick(e) {
    const b = e.target.closest('[data-cb]');
    if (!b) return;
    const { app } = this;
    const act = b.dataset.cb;
    if (act === 'make') return app.makeCellHere();
    if (act === 'cycle') return app.cycleCellTarget();
    const c = app.cellAt();
    if (!c) return;
    const r = b.getBoundingClientRect();
    const at = { x: r.left + r.width / 2, y: r.bottom };
    switch (act) {
      case 'split':
        app.splitCellAt(c.id);
        break;
      case 'start':
        app.setCellEdge(c.id, 's');
        break;
      case 'end':
        app.setCellEdge(c.id, 'e');
        break;
      case 'repeat':
        app.toggleRepeat(c.id);
        break;
      case 'like':
        app.store.updateCell(c.id, { lv: (c.lv + 1) % 4 });
        break;
      case 'bm':
        app.store.updateCell(c.id, { bm: !c.bm });
        break;
      case 'color':
        app.colorPop.open(c.id, b);
        break;
      case 'mergeL':
      case 'mergeR':
        app.mergeWithNeighbor(c.id, act === 'mergeL' ? -1 : 1, { reveal: false });
        break;
      case 'comment':
        app.tlMenu.open({ kind: 'cell', id: c.id, ...at, focus: 'comment' });
        break;
      case 'more':
        app.tlMenu.open({ kind: 'cell', id: c.id, ...at });
        break;
    }
  }
}
