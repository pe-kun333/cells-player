import { $ } from './util.js';
import { saveSettings } from './store.js';

// 声が出てから認識の途中結果が届くまでの、おおよその遅れ（秒）
const LATENCY = 0.8;
// 文が確定しないまま話が続くときに、途中までを仮の行として保存する間隔（ミリ秒）
const SAVE_EVERY = 6000;
export const LIVE_NAME = '音声認識（Chrome）';

// Chrome の音声認識（Web Speech API）で、流れている音声をその場で文字起こしする。
// Chrome の音声認識はマイクの音を聞くので、PC の音を「ステレオ ミキサー」などでマイクとして入力して使う。
// 認識した文は、そのときの再生位置から動画の時刻を決めて、字幕の行として追加する
export class LiveCaption {
  constructor(app) {
    this.app = app;
    this.rec = null;
    this.active = false;
    this.interim = '';
    this.recent = null;
    this.session = '';
    this.pending = new Map(); // 認識中（未確定）の文: 番号 → { start, text, lastNow, savedAt }
    this.restarts = [];       // すぐに止まる状態が続いていないかを見る
    this.networkErrors = 0;
    this.btn = $('#btnLive');
    this.dialog = $('#liveDialog');
    this.form = $('#liveForm');

    this.btn.addEventListener('click', () => (this.active ? this.stop('音声認識を止めました') : this.start()));
    this.form.addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'start') return;
      const s = this.app.settings;
      s.liveLang = this.form.lang.value;
      s.liveHelpSeen = true;
      saveSettings(s);
      this.start();
    });
    this.render();
  }

  get Recognition() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  openHelp() {
    this.form.lang.value = this.app.settings.liveLang;
    this.dialog.showModal();
  }

  start() {
    const { app } = this;
    if (!app.player) {
      app.toast('先に動画か音声を開いてください');
      return;
    }
    if (!this.Recognition) {
      app.toast('このブラウザは音声認識に対応していません。Chrome（または Edge）で開いてください');
      return;
    }
    // 初めてのときは、PC の音をマイクとして入力する準備の説明を出す
    if (!app.settings.liveHelpSeen) {
      this.openHelp();
      return;
    }
    const t = app.store.doc?.transcript;
    if (t && t.name !== LIVE_NAME && t.cues.length) {
      if (!confirm(`いまの字幕「${t.name}」に、音声認識の結果を追加していきますか？`)) return;
    }
    this.active = true;
    this.restarts = [];
    this.networkErrors = 0;
    // 字幕を含む元に戻すの履歴は消しておく（戻したときに、あとから認識した行まで消えないように）
    app.store.dropTranscriptUndo();
    this.spawn();
    this.render();
    app.showTranscriptList();
    app.hint(
      '音声認識を始めました。再生すると、聞こえた言葉が右下の「文字起こし」に行として追加されていきます' +
        (app.settings.captions ? '' : '（動画の上の字幕は非表示のままです。T キーで表示）'),
    );
  }

  spawn() {
    const rec = new this.Recognition();
    rec.lang = this.app.settings.liveLang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => this.onResult(e);
    rec.onerror = (e) => this.onError(e);
    rec.onend = () => this.onEnd(rec);
    this.rec = rec;
    // 認識のひと続きごとに別の名前を付ける（同じ文の仮の行と確定した行を結び付けるため）
    this.session = Date.now().toString(36);
    this.pending = new Map();
    try {
      rec.start();
    } catch (err) {
      this.fail(`音声認識を始められませんでした（${err.message}）`);
    }
  }

  onResult(e) {
    const now = this.app.now();
    const wall = performance.now();
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const text = (res[0]?.transcript || '').trim();
      const key = `${this.session}:${i}`;
      if (res.isFinal) {
        // 途中結果を見ずにいきなり確定したときは、話し始めが分からないので文字数から見積もる
        const p = this.pending.get(i);
        if (text) this.commit(key, p?.start, now, text, false);
        this.pending.delete(i);
        continue;
      }
      if (!this.active) continue; // 止めたあとに届く途中結果は使わない（確定した文だけ受け取る）
      let p = this.pending.get(i);
      if (!p) {
        p = { start: now - LATENCY, text: '', lastNow: now, savedAt: wall };
        this.pending.set(i, p);
      }
      p.text = text;
      p.lastNow = now;
      // なかなか確定しない（話が続いている）ときは、途中までを仮の行として保存しておく。確定したら置き換わる
      if (text && wall - p.savedAt >= SAVE_EVERY) {
        this.commit(key, p.start, now, text, true);
        p.savedAt = wall;
      }
      interim += text;
    }
    this.networkErrors = 0;
    if (this.active) this.setInterim(interim);
  }

  // 確定しないまま認識が終わった文を、行として保存する
  flushPending() {
    for (const [i, p] of this.pending) {
      if (p.text) this.commit(`${this.session}:${i}`, p.start, p.lastNow, p.text, false);
    }
    this.pending = new Map();
  }

  commit(key, start, now, text, provisional) {
    const guess = Math.min(8, Math.max(1, text.length * 0.12)); // 文字数からのおおよその長さ
    const e = Math.max(0, now - (provisional ? 0 : 0.3));
    let s = start;
    // 話し始めが分からないときや、途中で再生位置を動かしたときは、文字数から長さを見積もる
    if (s === undefined || !(s < e) || e - s > 30) s = e - guess;
    s = Math.max(0, s);
    const cue = { s: Math.round(s * 100) / 100, e: Math.round(Math.max(e, s + 0.5) * 100) / 100, text };
    this.app.store.upsertLiveCue(key, cue, LIVE_NAME);
    // 確定した文は時刻としてはもう過ぎているので、読めるよう少しのあいだ字幕に残す
    if (!provisional) this.recent = { text, until: performance.now() + 2500 };
  }

  // 少しのあいだ字幕に残す、直前に確定した文
  recentText() {
    return this.recent && performance.now() < this.recent.until ? this.recent.text : '';
  }

  setInterim(text) {
    if (text === this.interim) return;
    this.interim = text;
    this.app.onLiveInterim();
  }

  onError(e) {
    switch (e.error) {
      case 'no-speech':
      case 'aborted':
        return; // 無音などで止まっただけ。終わったら自動で再開する
      case 'not-allowed':
      case 'service-not-allowed':
        this.fail('マイクの使用が許可されていません。アドレスバーのマイクのアイコンから許可してください');
        return;
      case 'audio-capture':
        this.fail('音の入力（マイク）が見つかりません。「ステレオ ミキサー」などを有効にしてください');
        this.openHelp();
        return;
      case 'language-not-supported':
        this.fail('この言語の音声認識は使えません。「音声認識」の説明画面で言語を変えてください');
        return;
      case 'network':
        this.networkErrors++;
        if (this.networkErrors >= 3) this.fail('音声認識のサービスにつながりません。インターネット接続を確認してください');
        return;
      default:
        this.app.hint(`音声認識でエラーが起きました（${e.error}）。続けて試します`);
    }
  }

  // Chrome は一定時間で認識を終えるので、使っている間は自動で再開する
  onEnd(rec) {
    if (rec !== this.rec) return;
    this.flushPending();
    this.setInterim('');
    if (!this.active) return;
    const t = performance.now();
    this.restarts = this.restarts.filter((x) => t - x < 15000);
    this.restarts.push(t);
    if (this.restarts.length > 8) {
      this.fail('音声認識がすぐに止まってしまうため、終了しました。音の入力の設定を確認してください');
      return;
    }
    setTimeout(() => {
      if (this.active && this.rec === rec) this.spawn();
    }, 250);
  }

  fail(message) {
    this.stop();
    this.app.toast(message);
  }

  stop(message) {
    const rec = this.rec;
    this.active = false;
    this.rec = null;
    // 認識途中の文も行として残す（このあと確定した文が届いたら、同じ文として置き換わる）
    this.flushPending();
    if (rec) {
      rec.onend = null;
      try {
        rec.stop();
      } catch {}
    }
    this.setInterim('');
    this.render();
    if (message) this.app.hint(message);
  }

  render() {
    this.btn.classList.toggle('is-live', this.active);
    this.btn.querySelector('span').textContent = this.active ? '認識中' : '音声認識';
    this.btn.title = this.active
      ? 'クリックで音声認識を止める'
      : '流れている音声を Chrome の音声認識でその場で文字起こしする（PC の音をマイクとして入力する設定が必要です）';
    this.app.refreshCaption?.();
  }
}
