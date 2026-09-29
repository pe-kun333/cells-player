import { $, fmt, fmtDate, escapeHtml, icon } from './util.js';
import { saveSettings } from './store.js';
import { tr, locale } from './i18n.js';

// 単語帳: 文字起こしの中の言葉を、前後の文・時刻・どのメディアかと一緒に保存する（すべてのメディア共通）。
// 一覧から、その場面へ戻ったり、CSV（Anki や表計算ソフト向け）で書き出したりできる
export class Words {
  constructor(app) {
    this.app = app;
    this.addDialog = $('#wordAddDialog');
    this.addForm = $('#wordAddForm');
    this.listDialog = $('#wordsDialog');
    this.listEl = $('#wordsList');
    this.searchEl = $('#wordsSearch');
    this.scopeBtns = [...this.listDialog.querySelectorAll('[data-scope]')];
    this.pending = null;  // 追加しようとしている言葉の前後の文と時刻
    this.editing = null;  // メモを直している言葉の id

    $('#btnWords').addEventListener('click', () => this.openList());
    this.addForm.addEventListener('submit', (e) => this.onAdd(e));
    this.listEl.addEventListener('click', (e) => this.onListClick(e));
    this.listEl.addEventListener('keydown', (e) => this.onListKeydown(e));
    this.searchEl.addEventListener('input', () => this.render());
    this.searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.preventDefault(); // 検索欄の Enter でダイアログを閉じない
    });
    for (const b of this.scopeBtns) {
      b.addEventListener('click', () => {
        app.settings.wordScope = b.dataset.scope;
        saveSettings(app.settings);
        this.render();
      });
    }
    $('#btnWordsCsv').addEventListener('click', () => this.exportCsv());
  }

  // init: { word, context, t }
  openAdd(init = {}) {
    const { app } = this;
    if (!app.store.doc) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    const t = Number.isFinite(init.t) ? init.t : app.now();
    this.pending = { context: init.context || '', t };
    const f = this.addForm;
    f.word.value = (init.word || '').slice(0, 80);
    f.note.value = '';
    $('#wordMsg').textContent = '';
    $('#wordContext').innerHTML = this.pending.context
      ? `<span class="wc-time">${fmt(t)}</span>${escapeHtml(this.pending.context)}`
      : `<span class="wc-time">${fmt(t)}</span><span class="muted">${tr('（この時刻の字幕はありません）')}</span>`;
    this.addDialog.showModal();
    f.word.focus();
    f.word.select();
  }

  onAdd(e) {
    if (e.submitter?.value !== 'save') return;
    const { app } = this;
    const f = this.addForm;
    const word = f.word.value.trim();
    if (!word) {
      e.preventDefault();
      $('#wordMsg').textContent = tr('言葉を入れてください');
      f.word.focus();
      return;
    }
    const doc = app.store.doc;
    app.store.addWord({
      word,
      note: f.note.value.trim(),
      context: this.pending?.context || '',
      t: this.pending?.t ?? app.now(),
      mediaId: doc.id,
      mediaTitle: doc.title,
      mediaUrl: doc.source !== 'local' ? doc.url : null,
    });
    app.hint(tr('「{word}」を単語帳に追加しました（上の「単語帳」から見られます）', { word }));
  }

  openList() {
    this.editing = null;
    this.render();
    this.listDialog.showModal();
  }

  // 単語帳が変わったとき（main から呼ばれる）
  refresh() {
    if (this.listDialog.open) this.render();
  }

  visible() {
    const { store, settings } = this.app;
    const q = this.searchEl.value.trim().toLowerCase();
    return store.words.filter((w) => {
      if (settings.wordScope === 'media' && w.mediaId !== store.doc?.id) return false;
      if (!q) return true;
      return [w.word, w.note, w.context, w.mediaTitle].join('\n').toLowerCase().includes(q);
    });
  }

  render() {
    const { store, settings } = this.app;
    for (const b of this.scopeBtns) b.classList.toggle('on', b.dataset.scope === settings.wordScope);
    const list = this.visible();
    $('#wordsCount').textContent = tr('{n} 語（全部で {all} 語）', { n: list.length, all: store.words.length });
    if (!list.length) {
      this.listEl.innerHTML = `<div class="words-empty">${
        store.words.length
          ? tr('条件に合う言葉がありません。')
          : tr('まだ言葉がありません。右下の「文字起こし」で行を選んで「単語帳」を押すか、W キーで追加できます。')
      }</div>`;
      return;
    }
    this.listEl.innerHTML = list.map((w) => this.itemHtml(w)).join('');
    const inp = this.listEl.querySelector('.wi-note-input');
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  itemHtml(w) {
    const here = w.mediaId === this.app.store.doc?.id;
    const ctx = escapeHtml(w.context || '');
    const word = escapeHtml(w.word);
    const marked = word && ctx.includes(word) ? ctx.split(word).join(`<mark>${word}</mark>`) : ctx;
    const note =
      this.editing === w.id
        ? `<input class="field wi-note-input" value="${escapeHtml(w.note || '')}" placeholder="${tr('意味・メモ（Enter で保存）')}">`
        : `<span class="wi-note${w.note ? '' : ' muted'}" data-w="edit" title="${tr('クリックで編集')}">${w.note ? escapeHtml(w.note) : tr('意味・メモを書く')}</span>`;
    return `<div class="word-item" data-id="${w.id}">
      <div class="wi-top">
        <span class="wi-word">${word}</span>
        ${note}
        <span class="spacer"></span>
        <button type="button" class="btn tiny" data-w="go" title="${here ? tr('この場面へ移動') : tr('このメディアを開いてその場面へ')}">${icon('play')}${fmt(w.t)}</button>
        <button type="button" class="btn tiny danger" data-w="del" title="${tr('単語帳から消す')}">${icon('trash')}</button>
      </div>
      ${ctx ? `<div class="wi-context">${marked}</div>` : ''}
      <div class="wi-meta">${escapeHtml(w.mediaTitle || '')}${here ? tr('（いま開いているメディア）') : ''}${tr('・{date} に追加', { date: fmtDate(w.at) })}</div>
    </div>`;
  }

  onListClick(e) {
    const item = e.target.closest('.word-item');
    const a = e.target.closest('[data-w]')?.dataset.w;
    if (!item || !a) return;
    const w = this.app.store.words.find((x) => x.id === item.dataset.id);
    if (!w) return;
    if (a === 'go') {
      this.listDialog.close();
      this.app.jumpToMedia(w.mediaId, w.mediaUrl, Math.max(0, w.t - 0.3), w.mediaTitle);
    } else if (a === 'del') {
      this.app.store.deleteWord(w.id);
      this.app.hint(tr('「{word}」を単語帳から消しました', { word: w.word }));
    } else if (a === 'edit') {
      this.editing = w.id;
      this.render();
    }
  }

  onListKeydown(e) {
    if (!e.target.classList.contains('wi-note-input') || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault(); // ダイアログは閉じず、編集だけやめる
      this.editing = null;
      this.render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const id = this.editing;
      this.editing = null;
      this.app.store.updateWord(id, { note: e.target.value.trim() });
    }
  }

  exportCsv() {
    const list = this.visible();
    if (!list.length) {
      this.app.hint(tr('書き出す言葉がありません'));
      return;
    }
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [[tr('言葉'), tr('意味・メモ'), tr('前後の文'), tr('時刻'), tr('メディア'), tr('追加した日時')]];
    for (const w of list) rows.push([w.word, w.note, w.context, fmt(w.t), w.mediaTitle, new Date(w.at).toLocaleString(locale)]);
    // Excel で文字化けしないよう BOM を付ける
    const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = tr('単語帳.csv');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
