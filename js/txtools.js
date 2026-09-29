import { $ } from './util.js';
import { saveSettings } from './store.js';
import { toSrt, toVtt, toText, autoSegments } from './transcript.js';

// 文字起こしのツール: 書き出し（.srt / .vtt / テキスト）、時刻のずれの補正、自動でセルにする
export class TxTools {
  constructor(app) {
    this.app = app;
    this.dialog = $('#txToolsDialog');
    this.form = $('#txToolsForm');
    this.form.addEventListener('click', (e) => this.onClick(e));
    this.form.addEventListener('input', (e) => {
      if (e.target.name === 'gap' || e.target.name === 'max') this.preview();
    });
    this.form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); // 数字の欄の Enter で閉じない
    });
  }

  open() {
    const { app } = this;
    if (!app.store.cues.length) {
      app.hint('先に字幕・文字起こしを入れてください（「字幕を読み込む」「貼り付け」「音声認識」）');
      return;
    }
    this.form.gap.value = app.settings.splitGap;
    this.form.max.value = app.settings.splitMax;
    this.update();
    this.preview();
    this.dialog.showModal();
  }

  update() {
    const t = this.app.store.doc?.transcript;
    $('#txToolsInfo').textContent = t ? `「${t.name}」 ${t.cues.length} 行` : '';
    const off = t?.offset || 0;
    $('#txOffset').textContent = `ずらした合計 ${off > 0 ? '+' : ''}${off.toFixed(1)} 秒`;
  }

  options() {
    const num = (v, d, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    return {
      gap: num(this.form.gap.value, 2, 0.3, 60),
      maxLen: num(this.form.max.value, 60, 5, 1800),
      minLen: 5,
    };
  }

  preview() {
    const segs = autoSegments(this.app.store.cues, this.options());
    const fresh = segs.filter((r) => !this.app.store.findCell(r.s, r.e));
    $('#txSplitMsg').textContent = `この設定だと ${segs.length} 個のセルになります${fresh.length < segs.length ? `（すでにある ${segs.length - fresh.length} 個は作りません）` : ''}`;
  }

  onClick(e) {
    const b = e.target.closest('[data-tx]');
    if (!b) return;
    const { app } = this;
    const a = b.dataset.tx;
    if (a === 'srt' || a === 'vtt' || a === 'txt') this.download(a);
    else if (a === 'shift') {
      app.shiftTranscript(Number(b.dataset.d));
      app.refreshCaption();
      this.update();
    } else if (a === 'split') {
      const o = this.options();
      app.settings.splitGap = o.gap;
      app.settings.splitMax = o.maxLen;
      saveSettings(app.settings);
      const made = app.store.addCells(autoSegments(app.store.cues, o));
      this.dialog.close();
      if (made.length) {
        app.revealCell(made[0].id);
        app.hint(`文字起こしから ${made.length} 個のセルを作りました（Ctrl+Z でまとめて元に戻せます）`);
      } else {
        app.hint('新しく作るセルはありませんでした（同じ範囲のセルがすでにあります）');
      }
    }
  }

  download(kind) {
    const { store } = this.app;
    const cues = store.cues;
    const text = kind === 'srt' ? toSrt(cues) : kind === 'vtt' ? toVtt(cues) : toText(cues);
    const ext = kind === 'txt' ? 'txt' : kind;
    const base = (store.doc.title || 'transcript').replace(/\.[a-z0-9]+$/i, '').replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([text], { type: kind === 'vtt' ? 'text/vtt' : 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.app.hint(`文字起こしを「${base}.${ext}」として書き出しました`);
  }
}
