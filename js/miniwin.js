import { fmt, fmtLen, escapeHtml, icon, cellLabel, clamp } from './util.js';
import { saveSettings, cellColorOf } from './store.js';
import { LocalPlayer, YouTubePlayer } from './players.js';
import { cueIndexAt } from './transcript.js';
import { tr } from './i18n.js';

// セルの小窓: セルの区間を、画面の上に浮かぶ小さな窓で、本体とは別に再生する。
// ・小窓ごとに自分のプレイヤーを持つ（手元のファイル・URL の動画は同じものをもう1つの <video> で、YouTube はもう1つの埋め込みで）。
//   本体の再生位置は動かさない
// ・その区間の中だけを再生する（終わりまで来たら頭へ戻る。「くり返し」を外すと終わりで止まる）
// ・音が重ならないよう、音を出している小窓を再生すると、本体とほかの小窓は止まる。本体を再生すると小窓は止まる
//   （消音にした小窓は止めない・止まらない。見本の場面を音なしで流しておける）
// ・見出しのドラッグで動かし、右下の角で大きさを変える。いくつか並べて見比べられる（MAX まで）
// ・セルの範囲を変えたら合わせて動く。セルを消したら（元に戻すまで）最後の範囲のまま再生できる
// ・YouTube の埋め込みプレーヤーの上には何も重ねない（YouTube の規約）。YouTube のときは、本体の動画と
//   ほかの小窓に重ならない所に置く（ドラッグしても重なる所には入らず、左の列をスクロールしたらよける）。
//   小窓の中でも、字幕や知らせはプレーヤーの下に出す
const MAX = 4;
const MIN_W = 220;
const GAP = 8;           // 画面の端・よける物とのすき間（px）
const YT_SEEK_GAP = 120; // YouTube は続けて移動すると重いので間引く（ミリ秒）
const HOLD = 300;        // YouTube で移動した直後は、古い再生位置を「終わりに来た」と見ないよう待つ（ミリ秒）

// 置こうとしている所（左上 x, y・幅 w・高さ h）が、よける物 o（DOMRect）に重なるか
const hit = (x, y, w, h, o) => x < o.right && x + w > o.left && y < o.bottom && y + h > o.top;

export class MiniWins {
  constructor(app) {
    this.app = app;
    this.wins = [];
    this.refitQueued = false;
    window.addEventListener('resize', () => this.refit());
    // 左の列などのスクロールで本体の動画が動いたら、重ならないよう置き直す（YouTube のときだけ）
    document.addEventListener('scroll', () => this.queueRefit(), true);
  }

  // 本体の動画やほかの小窓をよけるか（YouTube の埋め込みの上には重ねない）
  get avoiding() {
    return this.app.mediaSrc?.kind === 'youtube';
  }

  get(id) {
    return this.wins.find((w) => w.id === id) || null;
  }

  has(id) {
    return !!this.get(id);
  }

  // 開いていれば閉じ、閉じていれば開く
  toggle(id) {
    const w = this.get(id);
    if (!w) return this.open(id);
    this.close(w);
    return null;
  }

  open(id) {
    const { app } = this;
    if (!app.player || !app.store.doc || !app.mediaSrc) {
      app.toast(tr('先に動画か音声を開いてください'));
      return null;
    }
    const c = app.store.getCell(id);
    if (!c) return null;
    const had = this.get(id);
    if (had) {
      this.front(had);
      had.flash();
      return had;
    }
    if (this.wins.length >= MAX) {
      app.hint(tr('小窓は同時に {n} つまでです（使わない小窓を閉じてください）', { n: MAX }));
      return null;
    }
    const win = new MiniWin(this, c);
    this.wins.push(win);
    document.body.appendChild(win.el);
    const p = this.spawnPos(win);
    win.setPos(p.x, p.y);
    this.front(win);
    win.load();
    app.hint(tr('{range} を小窓で再生します（本体の再生位置は動きません。音が出るのは本体か小窓の1つだけです）', { range: `${fmt(c.s)} – ${fmt(c.e)}` }));
    app.onMiniChange();
    return win;
  }

  close(win) {
    const i = this.wins.indexOf(win);
    if (i < 0) return;
    this.wins.splice(i, 1);
    win.destroy();
    this.app.onMiniChange();
  }

  // quiet: 画面の描き直しをしない（メディアを閉じるときなど、このあとまとめて描き直すとき）
  closeAll({ quiet = false } = {}) {
    if (!this.wins.length) return;
    for (const w of this.wins.splice(0)) w.destroy();
    if (!quiet) this.app.onMiniChange();
  }

  // いちばん手前にする
  front(win) {
    const i = this.wins.indexOf(win);
    if (i < 0) return;
    this.wins.splice(i, 1);
    this.wins.push(win);
    this.wins.forEach((w, k) => (w.el.style.zIndex = String(40 + k)));
  }

  // セルをまとめたとき（main の結合から）: まとめる前のセルの小窓を、まとめたセルの小窓にする
  remap(ids, id) {
    if (this.get(id)) return;
    const w = this.wins.find((x) => ids.includes(x.id));
    if (!w) return;
    w.id = id;
    w.headKey = '';
    this.app.onMiniChange();
  }

  // 音を出している小窓が再生を始めたとき: 本体と、音を出しているほかの小窓を止める
  solo(win) {
    const p = this.app.player;
    if (p && !p.paused) p.pause();
    for (const w of this.wins) if (w !== win && w.audible && !w.player.paused) w.player.pause();
  }

  // 本体が再生を始めたとき（main から）: 音を出している小窓を止める
  onMainPlay() {
    for (const w of this.wins) if (w.audible && !w.player.paused) w.player.pause();
  }

  // 本体の音量を変えたとき（main から）: 消音にしていない小窓も合わせる
  syncVolume() {
    for (const w of this.wins) w.applyVolume();
  }

  // 監視（main の watch）から毎回呼ぶ
  tick() {
    for (const w of this.wins) w.tick();
  }

  // ---- 置き場所 ----

  // よける物: 本体の動画と、ほかの小窓（always: YouTube でなくても。新しく置くとき）
  obstacles(win, always = false) {
    if (!always && !this.avoiding) return [];
    const list = [];
    const st = document.getElementById('stage')?.getBoundingClientRect();
    if (st && st.width && st.height) list.push(st);
    for (const w of this.wins) if (w !== win) list.push(w.el.getBoundingClientRect());
    return list;
  }

  // (x, y) に置きたいとき、実際に置ける所。画面の中に収め、よける物に重なるなら一番近い空いた所へずらす。
  // どこにも空きがなければ null
  resolve(win, x, y, obs = this.obstacles(win)) {
    const w = win.el.offsetWidth;
    const h = win.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fit = (px, py) => ({ x: clamp(px, GAP, Math.max(GAP, vw - w - GAP)), y: clamp(py, GAP, Math.max(GAP, vh - h - GAP)) });
    const free = (p) => !obs.some((o) => hit(p.x, p.y, w, h, o));
    const p0 = fit(x, y);
    if (free(p0)) return p0;
    // 重なっている物の上下左右へ押し出してみる（押し出した先がまた別の物に重なれば、そこからもう一度）
    let best = null;
    let bestD = Infinity;
    let frontier = [p0];
    for (let depth = 0; depth < 3 && !best && frontier.length; depth++) {
      const next = [];
      for (const p of frontier) {
        for (const o of obs) {
          if (!hit(p.x, p.y, w, h, o)) continue;
          for (const c of [fit(o.left - w - GAP, p.y), fit(o.right + GAP, p.y), fit(p.x, o.top - h - GAP), fit(p.x, o.bottom + GAP)]) {
            if (!free(c)) {
              next.push(c);
              continue;
            }
            const d = Math.hypot(c.x - p0.x, c.y - p0.y);
            if (d < bestD) {
              best = c;
              bestD = d;
            }
          }
        }
      }
      frontier = next.slice(0, 48);
    }
    return best;
  }

  // 新しい小窓を置く所: 下の端から、左の列（動画の下）に横に並べる。入らなければ画面の右下から。
  // 上のバー・本体の動画・再生ボタンの並び・タイムライン・いまのセルのバーと、ほかの小窓には重ねない。
  // 空きがなければ本体の動画とほかの小窓だけをよけ、それでもなければ少しずつずらして置く
  spawnPos(win) {
    const w = win.el.offsetWidth;
    const h = win.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const col = document.querySelector('.left')?.getBoundingClientRect();
    const inCol = col && col.width >= w + GAP * 2;
    const left = inCol ? Math.max(GAP, col.left + GAP) : GAP;
    const right = inCol ? Math.min(vw - GAP, col.right - GAP) : vw - GAP;
    const xsCol = [];
    for (let x = left; x + w <= right; x += w + GAP) xsCol.push(x);
    const xsAll = [...xsCol];
    for (let x = vw - GAP - w; x >= GAP; x -= w + GAP) xsAll.push(x);
    const ys = [];
    for (let y = vh - GAP - h; y >= GAP; y -= 24) ys.push(y);
    const find = (xs, obs) => {
      for (const y of ys) for (const x of xs) if (!obs.some((o) => hit(x, y, w, h, o))) return { x, y };
      return null;
    };
    const basic = this.obstacles(win, true);
    const deck = [...basic];
    for (const sel of ['.topbar', '#playerBox', '.controls', '#timeline', '#cellBar']) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r && r.width && r.height) deck.push(r);
    }
    const p = find(xsCol, deck) || find(xsAll, deck) || find(xsCol, basic) || find(xsAll, basic);
    if (p) return p;
    const n = this.wins.length - 1;
    const x = left + n * 24;
    const y = vh - GAP - h - n * 24;
    return this.resolve(win, x, y, basic) || this.resolve(win, x, y, []);
  }

  // ドラッグで動かすとき（重なる所には入らない）
  moveWin(win, x, y) {
    const p = this.resolve(win, x, y);
    if (p) win.setPos(p.x, p.y);
  }

  // 画面の大きさ・小窓の大きさが変わったとき、本体の動画が動いたときに置き直す
  fit(win) {
    const p = this.resolve(win, win.x, win.y);
    if (p && (p.x !== win.x || p.y !== win.y)) win.setPos(p.x, p.y);
  }

  refit() {
    for (const w of this.wins) this.fit(w);
  }

  queueRefit() {
    if (this.refitQueued || !this.wins.length || !this.avoiding) return;
    this.refitQueued = true;
    requestAnimationFrame(() => {
      this.refitQueued = false;
      this.refit();
    });
  }
}

class MiniWin {
  constructor(mgr, c) {
    this.mgr = mgr;
    this.app = mgr.app;
    this.id = c.id;
    this.s = c.s;
    this.e = c.e;
    this.missing = false; // セルが消された（元に戻すまで、最後の範囲のまま）
    this.loop = true;
    this.muted = false;
    this.player = null;
    this.ready = false;
    this.closed = false;
    this.holdUntil = 0;
    this.seekAt = 0;
    this.seekTimer = null;
    this.headKey = '';
    this.paintKey = '';
    this.capKey = '';
    this.x = 0;
    this.y = 0;
    this.resizing = false;
    this.bottomAnchored = true; // 高さが変わっても下の端を動かさない（置いたまま、動かしたり大きさを変えたりしていない間）
    this.lastH = 0;
    this.width = Math.round(clamp(Number(this.app.settings.miniWidth) || 320, MIN_W, Math.max(MIN_W, window.innerWidth - GAP * 2)));

    const el = (this.el = document.createElement('section'));
    el.className = 'mini-win';
    el.style.width = this.width + 'px';
    el.innerHTML = `
      <div class="mw-head">
        ${icon('pip')}<b class="mw-range"></b><span class="mw-memo"></span>
        <button type="button" class="mw-btn" data-mw="main" title="${tr('本体の再生位置を、この小窓の位置へ移す（すばやく2回押すと、本体で再生）')}">${tr('本体へ')}</button>
        <button type="button" class="mw-btn" data-mw="close" title="${tr('小窓を閉じる')}" aria-label="${tr('小窓を閉じる')}">${icon('x')}</button>
      </div>
      <div class="mw-stage">
        <div class="mw-media"></div>
        <div class="mw-cover" hidden>${icon('music')}</div>
      </div>
      <div class="mw-msg">${tr('読み込み中…')}</div>
      <div class="mw-cap" hidden></div>
      <div class="mw-bar" title="${tr('クリック・ドラッグで、セルの中を移動')}"><div class="mw-played"></div><div class="mw-knob"></div></div>
      <div class="mw-ctl">
        <button type="button" class="mw-btn" data-mw="play"></button>
        <button type="button" class="mw-btn" data-mw="restart" title="${tr('セルの頭から再生')}" aria-label="${tr('セルの頭から再生')}">${icon('back')}</button>
        <span class="mw-time"></span>
        <span class="spacer"></span>
        <button type="button" class="mw-btn" data-mw="loop"></button>
        <select class="mw-rate" title="${tr('この小窓の速度')}" aria-label="${tr('この小窓の速度')}"><option value="1">1x</option></select>
        <button type="button" class="mw-btn" data-mw="mute"></button>
      </div>
      <div class="mw-resize" title="${tr('ドラッグで大きさを変える')}"></div>`;
    this.q = (sel) => el.querySelector(sel);
    this.renderCtl();
    this.render();

    // どこを押しても手前に出す
    el.addEventListener('pointerdown', () => this.mgr.front(this), true);
    el.addEventListener('click', (e) => this.onClick(e));
    this.q('.mw-rate').addEventListener('change', (e) => {
      this.player?.setRate(Number(e.target.value));
      e.target.blur();
    });
    this.bindDrag();
    this.bindResize();
    this.bindBar();
    // 高さが変わったら（読み込み終わった・字幕が長い・音声だけと分かった）、置いた下の端に合わせ、画面からはみ出さないよう置き直す
    this.ro = new ResizeObserver(() => {
      if (this.resizing || !this.el.isConnected) return;
      const h = this.el.offsetHeight;
      if (this.bottomAnchored && this.lastH && h !== this.lastH) this.setPos(this.x, this.y + this.lastH - h);
      this.lastH = h;
      this.mgr.fit(this);
    });
    this.ro.observe(el);
  }

  // 音を出しているか（消音にした小窓は、ほかの再生と一緒に動かせる）
  get audible() {
    return this.ready && !this.muted;
  }

  setPos(x, y) {
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.el.style.left = this.x + 'px';
    this.el.style.top = this.y + 'px';
  }

  flash() {
    this.el.classList.remove('is-flash');
    void this.el.offsetWidth; // もう一度光らせる
    this.el.classList.add('is-flash');
    setTimeout(() => this.el.classList.remove('is-flash'), 900);
  }

  // ---- 読み込み ----

  async load() {
    const src = this.app.mediaSrc;
    const box = this.q('.mw-media');
    const p = src.kind === 'youtube' ? new YouTubePlayer(box) : new LocalPlayer(box);
    this.player = p;
    p.on('play', () => {
      this.renderCtl();
      if (!this.muted) this.mgr.solo(this);
    });
    p.on('pause', () => this.renderCtl());
    p.on('ended', () => {
      // セルが動画の最後までのとき: くり返すなら頭へ
      if (this.loop) this.restart();
    });
    p.on('error', (msg) => this.note(msg));
    try {
      await p.load(src.src);
    } catch (err) {
      if (!this.closed) this.note(err.message);
      return;
    }
    if (this.closed) return;
    this.ready = true;
    this.note('');
    this.applyVolume();
    const rates = p.getRates();
    this.q('.mw-rate').innerHTML = rates.map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r}x</option>`).join('');
    const audio = p.isAudioOnly();
    this.el.classList.toggle('is-audio', audio);
    this.q('.mw-cover').hidden = !audio;
    this.restart();
  }

  // 読み込み中・読み込めなかったときの知らせ（動画の上には重ねず、下に出す）
  note(msg) {
    const el = this.q('.mw-msg');
    el.textContent = msg;
    el.hidden = !msg;
  }

  applyVolume() {
    if (this.ready) this.player.setVolume(this.muted ? 0 : this.app.settings.volume);
  }

  destroy() {
    this.closed = true;
    clearTimeout(this.seekTimer);
    this.ro.disconnect();
    try {
      this.player?.destroy();
    } catch {}
    this.el.remove();
  }

  // ---- 再生 ----

  // 区間の中へ移動する（YouTube は続けて移動すると重いので間引く。移動し終わるまで、古い再生位置は見ない）
  seek(t) {
    if (!this.ready) return;
    t = clamp(t, this.s, Math.max(this.s, this.e - 0.05));
    const p = this.player;
    clearTimeout(this.seekTimer);
    if (p.kind !== 'youtube') {
      p.seek(t);
      return;
    }
    this.holdUntil = performance.now() + HOLD;
    const wait = YT_SEEK_GAP - (performance.now() - this.seekAt);
    const go = () => {
      this.seekAt = performance.now();
      this.holdUntil = performance.now() + HOLD;
      p.seek(t);
    };
    if (wait <= 0) go();
    else this.seekTimer = setTimeout(go, wait);
  }

  play() {
    if (!this.ready) return;
    const t = this.player.getTime();
    // 終わりで止まっていた・区間の外にいるときは、頭から
    if (t < this.s - 0.05 || t >= this.e - 0.05) this.seek(this.s);
    this.player.play();
  }

  restart() {
    this.seek(this.s);
    this.player.play();
  }

  togglePlay() {
    if (!this.ready) return;
    if (this.player.paused) this.play();
    else this.player.pause();
  }

  setMuted(v) {
    this.muted = v;
    this.applyVolume();
    // 音を出すようにしたら、ほかに鳴っているものを止める
    if (!v && this.ready && !this.player.paused) this.mgr.solo(this);
    this.renderCtl();
  }

  // 本体の再生位置を、この小窓の位置へ（すばやく2回で、本体で再生する）
  toMain() {
    const { app } = this;
    const t = this.ready ? clamp(this.player.getTime(), this.s, this.e) : this.s;
    app.seek(t);
    app.noteJump(`mini:${this.id}`);
    app.hint(tr('本体を {time} へ移しました（すばやく2回押すと、本体で再生します）', { time: fmt(t, true) }));
  }

  // 監視から毎回呼ぶ: セルに合わせる・区間の終わりで頭へ戻す（くり返さないなら止める）・表示を動かす
  tick() {
    this.render();
    if (!this.ready) return;
    const p = this.player;
    const t = p.getTime();
    if (!p.paused && performance.now() > this.holdUntil) {
      if (t >= this.e - 0.02) {
        if (this.loop) this.seek(this.s);
        else p.pause();
      } else if (t < this.s - 0.3) {
        this.seek(this.s);
      }
    }
    this.paint(t);
  }

  // ---- 描き直し ----

  // 見出し（範囲・メモ・色）。セルの範囲が変わったら、その範囲に合わせる
  render() {
    const { store, settings } = this.app;
    const c = store.getCell(this.id);
    if (c) {
      this.s = c.s;
      this.e = c.e;
    }
    this.missing = !c;
    const memo = c ? cellLabel(c, 40) : '';
    const cc = c && !store.shareOf(c) ? cellColorOf(settings, c) : null;
    const key = [this.s, this.e, memo, cc, this.missing].join('|');
    if (key === this.headKey) return;
    this.headKey = key;
    const range = `${fmt(this.s)}–${fmt(this.e)}`;
    this.q('.mw-range').textContent = range;
    const m = this.q('.mw-memo');
    m.textContent = this.missing ? tr('（このセルは削除されました）') : memo || fmtLen(this.e - this.s);
    m.classList.toggle('is-missing', this.missing);
    this.q('.mw-head').title = `${fmt(this.s, true)} – ${fmt(this.e, true)}${memo ? `  ${memo}` : ''}\n${tr('ドラッグで動かす')}`;
    this.el.setAttribute('aria-label', tr('セルの小窓 {range}', { range }));
    this.el.classList.toggle('has-color', !!cc);
    if (cc) this.el.style.setProperty('--cc', cc);
  }

  // 再生・くり返し・消音のボタン
  renderCtl() {
    const playing = this.ready && !this.player.paused;
    const pb = this.q('[data-mw="play"]');
    pb.innerHTML = icon(playing ? 'pause' : 'play');
    pb.title = playing ? tr('一時停止') : tr('再生');
    pb.setAttribute('aria-label', pb.title);
    const lb = this.q('[data-mw="loop"]');
    lb.innerHTML = icon('repeat');
    lb.classList.toggle('on', this.loop);
    lb.setAttribute('aria-pressed', String(this.loop));
    lb.title = this.loop ? tr('くり返す（オン）: 終わりまで来たら頭へ戻ります') : tr('くり返す（オフ）: 終わりで止まります');
    lb.setAttribute('aria-label', tr('くり返す'));
    const mb = this.q('[data-mw="mute"]');
    mb.innerHTML = icon(this.muted ? 'mute' : 'volume');
    mb.classList.toggle('on', this.muted);
    mb.setAttribute('aria-pressed', String(this.muted));
    mb.title = this.muted
      ? tr('消音中（本体やほかの小窓と一緒に再生できます）。押すと音を出します')
      : tr('消音にする（消音にした小窓は、本体やほかの小窓と一緒に再生できます）');
    mb.setAttribute('aria-label', tr('消音'));
  }

  // セルの中の帯・時刻・字幕
  paint(t) {
    const len = Math.max(0.01, this.e - this.s);
    const pct = Math.round(clamp((t - this.s) / len, 0, 1) * 1000) / 10;
    const time = `${fmt(clamp(t, this.s, this.e), true)} / ${fmt(this.e, true)}`;
    const key = `${pct}|${time}`;
    if (key !== this.paintKey) {
      this.paintKey = key;
      this.q('.mw-played').style.width = pct + '%';
      this.q('.mw-knob').style.left = pct + '%';
      this.q('.mw-time').textContent = time;
    }
    this.paintCaption(t);
  }

  // 小窓の再生位置の字幕（設定で字幕を出しているときだけ。2つあるときは、本体と同じ出し方で）
  paintCaption(t) {
    const { store, settings } = this.app;
    const el = this.q('.mw-cap');
    const cues = store.cues;
    if (!settings.captions || !cues.length) {
      el.hidden = true;
      this.capKey = '';
      return;
    }
    const cues2 = store.cues2;
    const mode = cues2.length ? settings.capMode || 'both' : 'main';
    const at = (list) => {
      const i = cueIndexAt(list, t);
      return i >= 0 && t < list[i].e ? list[i].text : '';
    };
    const a = mode === 'sub' ? '' : at(cues);
    const b = mode === 'main' ? '' : at(cues2);
    const key = `${mode}\u0001${a}\u0001${b}`;
    if (key === this.capKey) return;
    this.capKey = key;
    const line = (s, cls) => (s ? `<span class="cap-line ${cls}">${escapeHtml(s)}</span>` : '');
    el.hidden = false;
    el.classList.toggle('is-dual', mode === 'both' || mode === 'swap');
    el.innerHTML = mode === 'swap' ? line(b, 'cap-sub') + line(a, 'cap-main') : line(a, 'cap-main') + line(b, 'cap-sub');
  }

  // ---- 操作 ----

  onClick(e) {
    const b = e.target.closest('button[data-mw]');
    if (!b) return;
    switch (b.dataset.mw) {
      case 'close':
        this.mgr.close(this);
        break;
      case 'play':
        this.togglePlay();
        break;
      case 'restart':
        if (this.ready) this.restart();
        break;
      case 'loop':
        this.loop = !this.loop;
        this.renderCtl();
        break;
      case 'mute':
        this.setMuted(!this.muted);
        break;
      case 'main':
        this.toMain();
        break;
    }
  }

  // 押したまま動かしている間 move を呼び、離したら end を呼ぶ（YouTube の埋め込みの上でも、押した要素で受け取る）
  drag(target, e, move, end) {
    target.setPointerCapture(e.pointerId);
    document.body.classList.add('mw-dragging');
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('mw-dragging');
      end?.();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  // 見出しをドラッグして動かす
  bindDrag() {
    const head = this.q('.mw-head');
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, select')) return;
      e.preventDefault();
      const ox = e.clientX - this.x;
      const oy = e.clientY - this.y;
      this.bottomAnchored = false;
      this.el.classList.add('is-dragging');
      this.drag(head, e, (ev) => this.mgr.moveWin(this, ev.clientX - ox, ev.clientY - oy), () => this.el.classList.remove('is-dragging'));
    });
  }

  // 右下の角をドラッグして大きさを変える（高さは動画の形に合わせて決まる）。離したら次の小窓もこの幅にする
  bindResize() {
    const grip = this.q('.mw-resize');
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const sx = e.clientX;
      const sw = this.width;
      this.resizing = true;
      this.bottomAnchored = false;
      this.drag(grip, e, (ev) => this.setWidth(sw + ev.clientX - sx), () => {
        this.resizing = false;
        this.lastH = this.el.offsetHeight;
        this.app.settings.miniWidth = this.width;
        saveSettings(this.app.settings);
        this.mgr.fit(this);
      });
    });
  }

  // 幅を変える。画面の下からはみ出すなら上へずらし、よける物（YouTube のとき）に重なるなら変えない
  setWidth(w) {
    const prev = { width: this.width, y: this.y };
    this.width = Math.round(clamp(w, MIN_W, Math.max(MIN_W, window.innerWidth - this.x - GAP)));
    this.el.style.width = this.width + 'px';
    const h = this.el.offsetHeight;
    const over = this.y + h - (window.innerHeight - GAP);
    if (over > 0) this.setPos(this.x, Math.max(GAP, this.y - over));
    const r = this.el.getBoundingClientRect();
    if (this.mgr.obstacles(this).some((o) => hit(r.left, r.top, r.width, r.height, o))) {
      this.width = prev.width;
      this.el.style.width = this.width + 'px';
      this.setPos(this.x, prev.y);
    }
  }

  // セルの中の帯: クリック・ドラッグでその位置へ
  bindBar() {
    const bar = this.q('.mw-bar');
    const at = (ev) => {
      const r = bar.getBoundingClientRect();
      return this.s + clamp((ev.clientX - r.left) / r.width, 0, 1) * (this.e - this.s);
    };
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.ready) return;
      e.preventDefault();
      this.seek(at(e));
      this.drag(bar, e, (ev) => this.seek(at(ev)));
    });
  }
}
