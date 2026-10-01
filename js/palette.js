import { $, escapeHtml } from './util.js';
import { tr } from './i18n.js';

// 操作の一覧（Ctrl+K）: アプリでできる操作を、文字で探してすぐ実行する。
// ボタンが遠くても、キーを覚えていなくても使える。↑↓ で選び、Enter で実行、Esc で閉じる
const norm = (s) => String(s).normalize('NFKC').toLowerCase();

export class Palette {
  // commands: () => [{ group, label, key?, words?, run }]（main.js が作る。表示の言語に訳した文で渡す）
  constructor(app, commands) {
    this.app = app;
    this.commands = commands;
    this.dialog = $('#paletteDialog');
    this.input = $('#paletteInput');
    this.listEl = $('#paletteList');
    this.items = [];
    this.sel = 0;
    this.input.addEventListener('input', () => {
      this.sel = 0;
      this.render();
    });
    this.input.addEventListener('keydown', (e) => this.onKeydown(e));
    this.listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-i]');
      if (row) this.run(Number(row.dataset.i));
    });
    this.listEl.addEventListener('pointermove', (e) => {
      const row = e.target.closest('[data-i]');
      if (!row || Number(row.dataset.i) === this.sel) return;
      this.sel = Number(row.dataset.i);
      this.mark();
    });
    $('#btnPalette').addEventListener('click', () => this.open());
  }

  open() {
    if (this.dialog.open) return;
    this.input.value = '';
    this.sel = 0;
    this.render();
    this.dialog.showModal();
    this.input.focus();
  }

  render() {
    const terms = norm(this.input.value).split(/\s+/).filter(Boolean);
    this.items = this.commands().filter((c) => {
      const hay = norm(`${c.label} ${c.group} ${c.key || ''} ${c.words || ''}`);
      return terms.every((t) => hay.includes(t));
    });
    if (!this.items.length) {
      this.listEl.innerHTML = `<div class="pal-empty">${tr('見つかりませんでした。')}</div>`;
      return;
    }
    let group = '';
    this.listEl.innerHTML = this.items
      .map((c, i) => {
        const head = c.group !== group ? `<div class="pal-group">${escapeHtml(c.group)}</div>` : '';
        group = c.group;
        return `${head}<div class="pal-item" data-i="${i}" role="option"><span class="pal-label">${escapeHtml(c.label)}</span>${c.key ? `<kbd>${escapeHtml(c.key)}</kbd>` : ''}</div>`;
      })
      .join('');
    this.mark();
  }

  mark() {
    this.sel = Math.max(0, Math.min(this.sel, this.items.length - 1));
    for (const el of this.listEl.querySelectorAll('.pal-item')) {
      const on = Number(el.dataset.i) === this.sel;
      el.classList.toggle('is-sel', on);
      el.setAttribute('aria-selected', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    }
  }

  onKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.items.length) return;
      this.sel = (this.sel + (e.key === 'ArrowDown' ? 1 : -1) + this.items.length) % this.items.length;
      this.mark();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.run(this.sel);
    }
  }

  // 閉じてから実行する（実行した操作がダイアログやキー操作を使えるように）
  run(i) {
    const c = this.items[i];
    if (!c) return;
    this.dialog.close();
    setTimeout(() => c.run(), 0);
  }
}
