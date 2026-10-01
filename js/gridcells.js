import { $, fmt, fmtLen, round2 } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// 等間隔でセル化: 動画の最初から最後まで、同じ長さ（30秒ごと・60秒ごとなど）のセルに区切る。
// 「30秒ごとに全部セル化」のボタンは、設定の長さですぐに区切る。「…」で長さを選ぶ画面を開く。
// すでにある同じ範囲のセルは作らない。まとめて1回の Ctrl+Z で元に戻せる
const MAX_CELLS = 500;
// 長さの表し方（ちょうど何分なら「1分」、それ以外は「1分30秒」「45秒」）
const lenText = (sec) => (sec >= 60 && sec % 60 === 0 ? tr('{m}分', { m: sec / 60 }) : fmtLen(sec));

// 長さ d の動画を sec 秒ごとに区切った範囲。merge: 最後の余りを前のセルに含める
function gridRanges(d, sec, merge) {
  if (!d || !sec) return [];
  const out = [];
  for (let s = 0; s < d - 0.05; s += sec) out.push({ s: round2(s), e: round2(Math.min(d, s + sec)) });
  const last = out[out.length - 1];
  if (out.length > 1 && merge && last.e - last.s < sec - 0.05) {
    out.pop();
    out[out.length - 1].e = last.e;
  }
  return out;
}

// 「30秒ごとに全部セル化」のような、ボタンの文字
export const gridLabel = (sec) => tr('{len}ごとに全部セル化', { len: lenText(sec) });

export class GridCells {
  constructor(app) {
    this.app = app;
    this.dialog = $('#gridDialog');
    this.form = $('#gridForm');
    $('#btnGridCells').addEventListener('click', () => this.open());
    $('#btnGridQuick').addEventListener('click', () => this.quick());
    this.renderButtons();
    this.form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sec]');
      if (!b) return;
      this.form.sec.value = b.dataset.sec;
      this.preview();
    });
    this.form.addEventListener('input', (e) => {
      if (e.target.name === 'merge') this.mergeTouched = true;
      this.preview();
    });
    this.form.addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'make') return;
      if (!this.make()) e.preventDefault();
    });
  }

  open() {
    const { app } = this;
    if (!app.player) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    if (!app.duration()) {
      app.hint(tr('まだ動画の長さが分かりません。少し再生してから、もう一度押してください'));
      return;
    }
    this.form.sec.value = app.settings.gridSec || 30;
    this.mergeTouched = false; // 手で切り替えるまでは、余りが長さの半分より短いときだけ前のセルに含める
    this.preview();
    this.dialog.showModal();
  }

  // 設定の長さ（秒）
  get presetSec() {
    const v = Number(this.app.settings.gridSec);
    return Number.isFinite(v) && v >= 1 ? Math.min(v, 3600) : 30;
  }

  // ボタンの文字を設定の長さに合わせる
  renderButtons() {
    const sec = this.presetSec;
    const b = $('#btnGridQuick');
    b.querySelector('span').textContent = gridLabel(sec);
    b.title = tr('動画の最初から最後まで、{len}ごとのセルに区切ります（長さは「設定」か、となりの「…」で変えられます。Ctrl+Z でまとめて元に戻せます）', { len: lenText(sec) });
  }

  // 設定の長さで、すぐに区切る（余りが長さの半分より短ければ前のセルに含める）
  quick() {
    const { app } = this;
    if (!app.player) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    const d = app.duration();
    if (!d) {
      app.hint(tr('まだ動画の長さが分かりません。少し再生してから、もう一度押してください'));
      return;
    }
    const sec = this.presetSec;
    const rem = d - Math.floor(d / sec) * sec;
    const ranges = gridRanges(d, sec, rem < sec / 2);
    if (ranges.length > MAX_CELLS) {
      app.hint(tr('セルが多すぎます（{n} 個）。{max} 個までになるよう、長さを長くしてください', { n: ranges.length, max: MAX_CELLS }));
      return;
    }
    this.apply(ranges, sec);
  }

  apply(ranges, sec) {
    const { app } = this;
    const made = app.store.addCells(ranges);
    if (made.length) app.revealCell(made[0].id);
    app.hint(
      made.length
        ? tr('{len}ごとに {n} 個のセルを作りました（Ctrl+Z でまとめて元に戻せます）', { len: lenText(sec), n: made.length })
        : tr('同じ範囲のセルはもうあります'),
    );
  }

  sec() {
    const v = Number(this.form.sec.value);
    return Number.isFinite(v) && v >= 1 ? Math.min(v, 3600) : 0;
  }

  // 区切る範囲。最後の余りは、選んでいれば前のセルに含める
  ranges() {
    return gridRanges(this.app.duration(), this.sec(), this.form.merge.checked);
  }

  preview() {
    const d = this.app.duration();
    const sec = this.sec();
    for (const b of this.form.querySelectorAll('[data-sec]')) b.classList.toggle('on', Number(b.dataset.sec) === sec);
    // 最後に余りが出るときだけ「前のセルに含める」を出す
    const rem = sec ? d - Math.floor(d / sec) * sec : 0;
    const showMerge = sec > 0 && rem > 0.05 && d > sec;
    if (!this.mergeTouched) this.form.merge.checked = rem < sec / 2;
    $('#gridMergeRow').hidden = !showMerge;
    if (showMerge) $('#gridMergeText').textContent = tr('最後の余り（{len}）は前のセルに含める', { len: fmtLen(rem) });
    const msg = $('#gridMsg');
    const make = this.form.querySelector('[value="make"]');
    if (!sec) {
      msg.textContent = tr('長さ（秒）を入れてください');
      make.disabled = true;
      return;
    }
    const ranges = this.ranges();
    if (ranges.length > MAX_CELLS) {
      msg.textContent = tr('セルが多すぎます（{n} 個）。{max} 個までになるよう、長さを長くしてください', { n: ranges.length, max: MAX_CELLS });
      make.disabled = true;
      return;
    }
    const exist = ranges.filter((r) => this.app.store.findCell(r.s, r.e)).length;
    msg.textContent =
      tr('{dur} の動画を {len}ごとに区切って、{n} 個のセルを作ります', { dur: fmt(d), len: lenText(sec), n: ranges.length - exist }) +
      (exist ? tr('（同じ範囲の {m} 個は、もうあるので作りません）', { m: exist }) : '');
    make.disabled = ranges.length - exist <= 0;
  }

  make() {
    const { app } = this;
    const sec = this.sec();
    const ranges = this.ranges();
    if (!ranges.length || ranges.length > MAX_CELLS) return false;
    app.settings.gridSec = sec;
    saveSettings(app.settings);
    this.renderButtons();
    this.apply(ranges, sec);
    return true;
  }
}
