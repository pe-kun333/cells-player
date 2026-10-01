import { $, fmt, escapeHtml, icon } from './util.js';
import { saveSettings } from './store.js';
import { cueIndexAt } from './transcript.js';
import { tr } from './i18n.js';

// 文字起こしの行を使った練習。
// シャドーイング: 1行再生 → 行の長さ×倍率だけ止まる（そのあいだに声に出す）→ 次の行（くり返し回数も選べる）
// ディクテーション: 字幕を隠して1行再生 → 止まる → 聞こえたとおりに入力 → 文字起こしと比べて違う所に印
export class Practice {
  constructor(app) {
    this.app = app;
    this.mode = null; // 'shadow' | 'dictation'
    this.i = -1;
    this.phase = 'idle'; // play（再生中）/ gap（シャドーイングの待ち）/ answer（入力待ち）/ result（答え合わせ後）
    this.rep = 0;
    this.timer = null;
    this.gapMs = 0;
    this.settleUntil = 0;
    this.result = null;
    this.draft = '';
    this.score = { n: 0, sum: 0 };
    this.card = $('#practiceCard');
    this.card.addEventListener('click', (e) => this.onClick(e));
    this.card.addEventListener('change', (e) => this.onChange(e));
    this.card.addEventListener('keydown', (e) => this.onKeydown(e));
    this.card.addEventListener('input', (e) => {
      if (e.target.classList.contains('pr-input')) this.draft = e.target.value;
    });
  }

  get active() {
    return !!this.mode;
  }

  get cues() {
    return this.app.store.cues;
  }

  get cue() {
    return this.cues[this.i] || null;
  }

  start(mode) {
    const { app } = this;
    if (!app.player) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    if (!this.cues.length) {
      app.hint(tr('先に字幕・文字起こしを入れてください（「字幕を読み込む」「貼り付け」「音声認識」）'));
      return;
    }
    app.stopModes('practice');
    this.mode = mode;
    this.rep = 0;
    this.result = null;
    this.draft = '';
    this.score = { n: 0, sum: 0 };
    // いまの位置の行から（その行がもうほとんど終わっていれば次の行から）
    const now = app.now();
    let i = cueIndexAt(this.cues, now);
    if (i < 0) i = 0;
    else if (now > this.cues[i].e - 0.2 && i < this.cues.length - 1) i++;
    this.i = i;
    this.playLine();
    app.hint(
      mode === 'shadow'
        ? tr('シャドーイングを始めます。1行流れて止まったら、同じように声に出してみましょう')
        : tr('ディクテーションを始めます。聞こえたとおりに入力して、Enter で答え合わせします'),
    );
  }

  playLine() {
    clearTimeout(this.timer);
    const c = this.cue;
    if (!c) {
      this.finish();
      return;
    }
    this.phase = 'play';
    this.result = null;
    this.settleUntil = performance.now() + 400; // 移動した直後は「行の終わり」の判定をしない
    this.app.seek(c.s, { auto: true });
    this.app.player.play();
    this.render();
    this.app.refreshCaption();
  }

  // main の監視から呼ぶ
  tick(now, playing) {
    if (!this.mode || this.phase !== 'play' || !playing) return;
    if (performance.now() < this.settleUntil) return;
    const c = this.cue;
    if (c && now >= c.e - 0.03) this.lineEnded();
  }

  // 最後の行が動画の終わりまでだったとき
  onEnded() {
    if (!this.mode || this.phase !== 'play') return false;
    this.lineEnded();
    return true;
  }

  lineEnded() {
    this.app.player.pause();
    if (this.mode === 'shadow') {
      const c = this.cue;
      this.phase = 'gap';
      this.gapMs = Math.max(800, (c.e - c.s) * this.app.settings.shadowGap * 1000);
      this.timer = setTimeout(() => this.afterGap(), this.gapMs);
    } else {
      this.phase = 'answer';
    }
    this.render();
    this.app.refreshCaption();
    if (this.mode === 'dictation') this.card.querySelector('.pr-input')?.focus();
  }

  afterGap() {
    if (!this.mode) return;
    this.rep++;
    if (this.rep < this.app.settings.shadowRepeat) this.playLine();
    else this.go(this.i + 1);
  }

  go(i) {
    if (!this.mode) return;
    if (i >= this.cues.length) {
      this.finish();
      return;
    }
    this.i = Math.max(0, i);
    this.rep = 0;
    this.draft = '';
    this.playLine();
  }

  finish() {
    const mode = this.mode;
    const avg = this.score.n ? Math.round(this.score.sum / this.score.n) : null;
    this.stop();
    this.app.hint(
      mode === 'shadow'
        ? tr('シャドーイングが最後の行まで終わりました')
        : tr('ディクテーションが終わりました') + (avg !== null ? tr('（平均の一致 {avg}%）', { avg }) : ''),
    );
  }

  stop() {
    clearTimeout(this.timer);
    if (this.mode && this.phase === 'play') this.app.player?.pause();
    this.mode = null;
    this.phase = 'idle';
    this.render();
    this.app.refreshCaption();
  }

  // 動画の上の字幕をどうするか（null なら普段どおり）
  captionOverride() {
    if (!this.mode) return null;
    const c = this.cue;
    if (!c) return null;
    // 動画の上の字幕を出さない設定なら、練習中も出さない（行の文字は練習のカードに出る）
    if (!this.app.settings.captions) return { hide: true };
    if (this.mode === 'dictation') return this.phase === 'result' ? { text: c.text } : { hide: true };
    return this.app.settings.shadowShowText ? { text: c.text } : { hide: true };
  }

  check(answer) {
    const c = this.cue;
    if (!c) return;
    // 行が終わる前に答え合わせしたときは、そこで止める
    if (this.phase === 'play') this.app.player.pause();
    this.result = compareText(c.text, answer);
    this.score.n++;
    this.score.sum += this.result.score;
    this.phase = 'result';
    this.render();
    this.app.refreshCaption();
    this.card.querySelector('.pr-input')?.focus();
  }

  onClick(e) {
    const a = e.target.closest('[data-pr]')?.dataset.pr;
    if (!a) return;
    if (a === 'prev') this.go(this.i - 1);
    else if (a === 'next') this.go(this.i + 1);
    else if (a === 'again') this.playLine();
    else if (a === 'check') this.check(this.draft);
    else if (a === 'stop') {
      this.stop();
      this.app.hint(tr('練習をやめました'));
    }
  }

  onChange(e) {
    const k = e.target.dataset.prOpt;
    if (!k) return;
    const s = this.app.settings;
    if (k === 'gap') s.shadowGap = Number(e.target.value);
    else if (k === 'repeat') s.shadowRepeat = Number(e.target.value);
    else if (k === 'text') {
      s.shadowShowText = e.target.checked;
      this.app.refreshCaption();
    }
    saveSettings(s);
    e.target.blur();
    this.render();
  }

  onKeydown(e) {
    if (!e.target.classList.contains('pr-input') || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.target.blur();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (e.shiftKey) this.playLine(); // もう一度聞く
    else if (this.phase === 'result') this.go(this.i + 1);
    else this.check(this.draft);
  }

  render() {
    const card = this.card;
    card.hidden = !this.mode;
    if (!this.mode) {
      card.innerHTML = '';
      return;
    }
    const c = this.cue;
    const s = this.app.settings;
    const n = this.cues.length;
    const shadow = this.mode === 'shadow';
    const head = `<div class="pr-head">
      <span class="pr-title">${icon(shadow ? 'repeat' : 'text')}${shadow ? tr('シャドーイング') : tr('ディクテーション')}</span>
      <span class="pr-pos">${tr('{i} / {n} 行目', { i: this.i + 1, n })}${c ? `${tr('・')}${fmt(c.s)}` : ''}</span>
      <span class="spacer"></span>
      <button class="btn tiny" data-pr="prev">${tr('前の行')}</button>
      <button class="btn tiny" data-pr="again">${tr('もう一度')}</button>
      <button class="btn tiny" data-pr="next">${tr('次の行')}</button>
      <button class="btn tiny" data-pr="stop">${icon('x')}${tr('やめる')}</button>
    </div>`;
    let body;
    if (shadow) {
      const status = {
        play: tr('再生中… よく聞いて'),
        gap: tr('声に出してみましょう'),
      }[this.phase] || '';
      const reps = s.shadowRepeat > 1 ? tr('（{i} / {n} 回目）', { i: this.rep + 1, n: s.shadowRepeat }) : '';
      const opt = (values, cur, label) => values.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label(v)}</option>`).join('');
      body = `
        <div class="pr-line${s.shadowShowText ? '' : ' is-hidden'}">${s.shadowShowText ? escapeHtml(c?.text || '') : tr('（文字は隠しています）')}</div>
        <div class="pr-status ${this.phase}">${status}${reps}</div>
        <div class="pr-gap">${this.phase === 'gap' ? `<i style="animation-duration:${this.gapMs}ms"></i>` : ''}</div>
        <div class="pr-opts">
          <label>${tr('待ち時間')} <select data-pr-opt="gap">${opt([0.5, 1, 1.5, 2, 3], s.shadowGap, (v) => tr('行の長さの {v} 倍', { v }))}</select></label>
          <label>${tr('くり返し')} <select data-pr-opt="repeat">${opt([1, 2, 3, 5], s.shadowRepeat, (v) => tr('{n} 回', { n: v }))}</select></label>
          <label class="pr-check"><input type="checkbox" data-pr-opt="text"${s.shadowShowText ? ' checked' : ''}> ${tr('文字を見せる')}</label>
        </div>`;
    } else {
      const r = this.result;
      const avg = this.score.n ? Math.round(this.score.sum / this.score.n) : null;
      body = `
        <div class="pr-row">
          <input class="field pr-input" type="text" autocomplete="off" spellcheck="false"
            placeholder="${tr('聞こえたとおりに入力（Enter で答え合わせ・Shift+Enter でもう一度聞く）')}">
          <button class="btn small" data-pr="${r ? 'next' : 'check'}">${r ? tr('次の行') : tr('答え合わせ')}</button>
        </div>
        <div class="pr-status ${this.phase}">${this.phase === 'play' ? tr('再生中… 字幕は隠しています') : this.phase === 'answer' ? tr('入力して Enter で答え合わせ') : ''}</div>
        ${r ? `<div class="pr-result">
          <div><span class="pr-label">${tr('正解')}</span><span class="pr-diff">${r.refHtml}</span></div>
          <div><span class="pr-label">${tr('あなた')}</span><span class="pr-diff">${r.ansHtml || `<span class="muted">${tr('（未入力）')}</span>`}</span></div>
          <div class="pr-score">${tr('一致 {score}%', { score: r.score })}${avg !== null ? tr('（平均 {avg}%・{n} 行）', { avg, n: this.score.n }) : ''}　<span class="muted">${tr('Enter で次の行へ')}</span></div>
        </div>` : ''}`;
    }
    card.innerHTML = head + body;
    const inp = card.querySelector('.pr-input');
    if (inp) inp.value = this.draft;
  }
}

// ---- ディクテーションの答え合わせ ----

// 比べるときは句読点・かっこ・空白を無視し、全角半角と大文字小文字をそろえる（長音「ー」は残す）。
// 表示は元の文字のまま（英語の単語の間の空白も残す）
const IGNORE = /[\s、。，．,.!?！？「」『』（）()［］[\]【】・…‥"'“”‘’:：;；〜~]/;

function tokens(text) {
  return [...text.trim().normalize('NFKC')].map((ch) => ({ ch, key: IGNORE.test(ch) ? null : ch.toLowerCase(), ok: false }));
}

// 文字ごとに、共通部分（最長共通部分列）を使って「合っている／足りない／余分」を分ける
export function compareText(reference, answer) {
  const ref = tokens(reference);
  const ans = tokens(answer);
  const a = ref.filter((t) => t.key);
  const b = ans.filter((t) => t.key);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i].key === b[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].key === b[j].key) {
      a[i++].ok = true;
      b[j++].ok = true;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const html = (list, bad) =>
    list.map((t) => (t.key ? `<span class="${t.ok ? 'd-ok' : bad}">${escapeHtml(t.ch)}</span>` : escapeHtml(t.ch))).join('');
  const matched = a.filter((t) => t.ok).length;
  const extra = b.length - matched;
  // 余分な文字も減点する（全部打てば満点、にならないように）
  const score = a.length ? Math.max(0, Math.round(((matched - extra * 0.5) / a.length) * 100)) : 0;
  return { score, refHtml: html(ref, 'd-miss'), ansHtml: b.length ? html(ans, 'd-extra') : '' };
}
