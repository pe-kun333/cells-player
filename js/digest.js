import { $, fmt, icon, escapeHtml, cellLabel } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// 連続再生（ダイジェスト）: サイドバーにいま並んでいるセル・目印を、上から順に続けて再生する。
// セルはその区間を、目印は「少し前から」〜設定の秒数あと までを1つの区切りとして再生する
export class Digest {
  constructor(app) {
    this.app = app;
    this.clips = [];
    this.i = -1;
    this.active = false;
    this.lastT = 0;
    this.settleUntil = 0; // 自分で移動した直後は「手で動かした」と判定しない
    this.startBtn = $('#btnDigest');
    this.bar = $('#digestBar');
    this.startBtn.addEventListener('click', () => this.start());
    this.bar.addEventListener('click', (e) => {
      const a = e.target.closest('[data-dg]')?.dataset.dg;
      if (a === 'prev') this.go(this.i - 1, true);
      else if (a === 'next') this.go(this.i + 1, true);
      else if (a === 'loop') this.toggleLoop();
      else if (a === 'stop') this.stop(tr('連続再生をやめました'));
    });
  }

  build() {
    const { app } = this;
    const items = app.sidebarItems();
    const cells = items.filter((it) => it.kind === 'cell').map((it) => it.o);
    const clips = [];
    for (const it of items) {
      if (it.kind === 'cell') {
        const c = it.o;
        clips.push({ id: c.id, s: c.s, e: c.e, label: `${fmt(c.s)} – ${fmt(c.e)}  ${cellLabel(c, 24)}` });
        continue;
      }
      const m = it.o;
      // 一覧に並んでいるセルの中の目印は、そのセルの再生に含まれるので飛ばす
      if (cells.some((c) => m.t >= c.s && m.t < c.e)) continue;
      const first = m.comments[0]?.text || m.tags.join(tr('・'));
      clips.push({
        id: m.id,
        s: app.leadTime(m.t),
        e: Math.min(app.duration(), m.t + app.settings.momentClip),
        label: tr('{time} の目印  {text}', { time: fmt(m.t), text: first }),
      });
    }
    return clips.filter((c) => c.e - c.s > 0.2);
  }

  start() {
    const { app } = this;
    if (!app.player) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    const clips = this.build();
    if (!clips.length) {
      app.hint(tr('連続再生するセルや目印がありません（サイドバーの一覧に並んでいるものを順に再生します）'));
      return;
    }
    app.stopModes('digest'); // リピート・練習とは同時に使えない
    this.clips = clips;
    this.active = true;
    this.go(0, true);
    app.player.play();
    app.hint(tr('{n} 件を続けて再生します', { n: clips.length }));
  }

  // i 番目の区切りへ。force: 前へ・次へボタンなどで、再生位置が近くても必ず頭から
  go(i, force = false) {
    if (!this.active) return;
    const { app } = this;
    if (i < 0) i = 0;
    if (i >= this.clips.length) {
      if (!app.settings.digestLoop) {
        app.player.pause();
        this.stop(tr('連続再生が終わりました'));
        return;
      }
      i = 0;
    }
    this.i = i;
    const c = this.clips[i];
    // 前の区切りの終わりと次の頭がつながっているときは、音が途切れないよう移動しない
    if (force || Math.abs(app.now() - c.s) > 0.15) app.seek(c.s);
    this.lastT = c.s;
    this.settleUntil = performance.now() + 500;
    app.ui.digestId = c.id;
    this.render();
    app.onDigestClip(c.id);
  }

  stop(message) {
    this.active = false;
    this.clips = [];
    this.i = -1;
    this.app.ui.digestId = null;
    this.render();
    this.app.onDigestClip(null);
    if (message) this.app.hint(message);
  }

  toggleLoop() {
    const s = this.app.settings;
    s.digestLoop = !s.digestLoop;
    saveSettings(s);
    this.render();
    this.app.hint(s.digestLoop ? tr('最後まで行ったら最初から繰り返します') : tr('最後まで行ったら止まります'));
  }

  // main.js の監視から呼ぶ（別のウィンドウを見ていても動く）
  tick(now, playing) {
    if (!this.active || !playing) {
      this.lastT = now;
      return;
    }
    const c = this.clips[this.i];
    if (!c) return;
    if (performance.now() < this.settleUntil) {
      this.lastT = now;
      return;
    }
    if (this.lastT < c.e && now >= c.e - 0.03 && now < c.e + 1) {
      this.go(this.i + 1);
      return;
    }
    // 手で別の場所へ動かしたとき: そこを含む区切りがあればそこから続け、なければ連続再生をやめる
    if (now < c.s - 1 || now > c.e + 1) {
      const j = this.clips.findIndex((x) => now >= x.s && now < x.e);
      if (j >= 0) {
        this.i = j;
        this.app.ui.digestId = this.clips[j].id;
        this.render();
        this.app.onDigestClip(this.clips[j].id);
      } else {
        this.stop(tr('区切りの外へ移動したので、連続再生をやめました'));
      }
    }
    this.lastT = now;
  }

  // 最後の区切りが動画の終わりまでだったとき（ended）
  onEnded() {
    if (!this.active) return false;
    this.go(this.i + 1, true);
    if (this.active) this.app.player.play();
    return true;
  }

  render() {
    const on = this.active;
    this.startBtn.hidden = on;
    this.bar.hidden = !on;
    if (!on) return;
    const c = this.clips[this.i];
    const loop = this.app.settings.digestLoop;
    this.bar.innerHTML = `
      <span class="dg-state">${icon('play')}${tr('連続再生 {i} / {n}', { i: this.i + 1, n: this.clips.length })}</span>
      <span class="dg-label" title="${escapeHtml(c ? c.label : '')}">${escapeHtml(c ? c.label : '')}</span>
      <button data-dg="prev" title="${tr('前へ')}" aria-label="${tr('前へ')}">${icon('back')}</button>
      <button data-dg="next" title="${tr('次へ')}" aria-label="${tr('次へ')}">${icon('next')}</button>
      <button data-dg="loop" class="${loop ? 'on' : ''}" title="${tr('最後まで行ったら最初から繰り返す')}" aria-label="${tr('繰り返し')}" aria-pressed="${loop}">${icon('repeat')}</button>
      <button data-dg="stop" title="${tr('連続再生をやめる')}">${icon('x')}${tr('停止')}</button>`;
  }
}
