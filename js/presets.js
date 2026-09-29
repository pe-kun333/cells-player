import { $, escapeHtml, uid } from './util.js';
import { PRESET_COUNT, normalizePresetSets, saveSettings } from './store.js';

// 「よく使うコメント」のセットを編集するダイアログ。保存を押すまでは下書きを編集する
export class PresetDialog {
  constructor(app, onSaved) {
    this.app = app;
    this.onSaved = onSaved;
    this.dialog = $('#presetDialog');
    this.form = $('#presetForm');
    this.items = [...this.form.querySelectorAll('[data-item]')];
    this.draft = [];
    this.currentId = null;

    this.form.set.addEventListener('change', () => {
      this.keep();
      this.currentId = this.form.set.value;
      this.fill();
    });
    this.form.setName.addEventListener('input', () => {
      const opt = this.form.set.selectedOptions[0];
      if (opt) opt.textContent = this.form.setName.value || '（名前なし）';
    });
    $('#btnAddSet').addEventListener('click', () => {
      this.keep();
      const s = { id: uid(), name: `セット ${this.draft.length + 1}`, items: Array(PRESET_COUNT).fill('') };
      this.draft.push(s);
      this.currentId = s.id;
      this.fill();
      this.form.setName.focus();
      this.form.setName.select();
    });
    $('#btnDelSet').addEventListener('click', () => {
      if (this.draft.length <= 1) {
        this.message('セットは1つ以上必要です');
        return;
      }
      this.draft = this.draft.filter((s) => s.id !== this.currentId);
      this.currentId = this.draft[0].id;
      this.fill();
    });
    this.form.addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'save') return;
      this.keep();
      const s = this.app.settings;
      s.presetSets = normalizePresetSets(this.draft);
      s.activePresetSet = this.currentId;
      saveSettings(s);
      this.onSaved();
    });
  }

  open() {
    this.draft = structuredClone(this.app.settings.presetSets);
    this.currentId = this.app.activePresetSet().id;
    this.message('');
    this.fill();
    this.dialog.showModal();
  }

  current() {
    return this.draft.find((s) => s.id === this.currentId);
  }

  // 画面の入力内容を下書きに書き戻す
  keep() {
    const s = this.current();
    if (!s) return;
    s.name = this.form.setName.value.trim() || s.name;
    s.items = this.items.map((inp) => inp.value.trim());
  }

  fill() {
    const f = this.form;
    f.set.innerHTML = this.draft
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join('');
    f.set.value = this.currentId;
    const s = this.current();
    f.setName.value = s.name;
    this.items.forEach((inp, i) => {
      inp.value = s.items[i] || '';
    });
  }

  message(text) {
    $('#presetMsg').textContent = text;
  }
}
