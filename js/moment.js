import { $, $$, fmt, escapeHtml, hearts, icon, commentSummary, tagChips } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// 動画の下の「この瞬間」パネル。いいね・コメントは常に目印（瞬間）に付く
export class Moment {
  constructor(app) {
    this.app = app;
    this.timeEl = $('#momentTime');
    this.chipEl = $('#targetChip');
    this.hintEl = $('#momentHint');
    this.hintEl2 = $('#ncHint'); // いまのカードにも同じお知らせを出す
    this.feedEl = $('#feed');
    this.input = $('#commentInput');
    this.offsetsEl = $('#offsetButtons');
    this.likeBtns = $$('#likeButtons [data-lv]');
    this.bmBtn = $('#btnMomentBm');
    this.quickEl = $('#quickButtons');
    this.setSel = $('#presetSetSelect');

    this.markBtn = $('#btnCommentMark');
    this.pinEl = $('#pinChip');
    this.timeText = '';
    this.effKey = '';
    this.feedKey = '';
    this.pinKey = '';
    this.hintTimer = null;
    // 前後の目印の一覧
    this.feedSyncBtns = $$('#feedSync [data-sync]');
    this.feedList = [];
    this.feedSel = null;      // 選んだ目印（行の下に「移動」「{s}秒前に移動」「コメントする」を出す）
    this.feedAdding = false;  // 選んだ目印にコメントを書いているか
    this.feedResume = false;  // コメントを書くために一時停止したか
    this.feedNowKey = '';     // いまの目印の強調（描き直したら付け直す）
    this.feedCur = undefined; // 連動で最後に合わせた目印
    this.feedPause = 0;       // 手でスクロールしたり押したりしたら、しばらく追いかけない
    this.feedPointerAt = 0;   // 一覧の上でマウスを動かした時刻（動かしている間はスクロールしない）
    this.feedMarks = '';      // 対象・固定の目印の印（変わったら作り直さずに付け直す）
    this.feedComposing = false; // コメント欄で日本語を変換している途中か（その間は作り直さない）
    this.feedDirty = false;   // 変換の途中に作り直しを待たせたか

    this.renderOffsets();
    this.renderQuick();
    this.quickEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-qi]');
      if (b) app.toggleQuickTag(Number(b.dataset.qi));
    });
    $('#btnMarkNow').addEventListener('click', () => app.markAt(app.now()));
    this.offsetsEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-off]');
      if (!b) return;
      const off = Number(b.dataset.off);
      app.markAt(app.now() - off, { offset: off });
    });
    for (const b of this.likeBtns) b.addEventListener('click', () => app.rateMoment(Number(b.dataset.lv)));
    this.bmBtn.addEventListener('click', () => app.toggleMomentBookmark());
    $('#btnMakeCell').addEventListener('click', () => app.makeCellHere());
    $('#btnMakeCellLeft').addEventListener('click', () => app.makeCellLeft());
    this.chipEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="release"]')) app.releaseTarget();
    });
    this.bindComment();
    this.bindFeed();
  }

  renderOffsets() {
    this.offsetsEl.innerHTML = this.app.settings.offsets
      .map((s) => `<button class="btn small" data-off="${s}" title="${tr('{s}秒前に目印', { s })}">${tr('−{s}秒', { s })}</button>`)
      .join('');
  }

  // よく使うコメントのボタン（いま選んでいるセットの6つ）
  renderQuick() {
    const set = this.app.activePresetSet();
    this.setSel.innerHTML = this.app.settings.presetSets
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`)
      .join('');
    this.setSel.value = set.id;
    this.quickEl.innerHTML = set.items
      .map((name, i) =>
        name
          ? `<button class="quick-btn" data-qi="${i}" title="${escapeHtml(tr('{name}（{key} キー）', { name, key: i + 4 }))}"><span class="qb-name">${escapeHtml(name)}</span><kbd>${i + 4}</kbd></button>`
          : `<button class="quick-btn empty" data-qi="${i}" title="${tr('空き（鉛筆ボタンから登録できます）')}"><span class="qb-name">${tr('空き')}</span><kbd>${i + 4}</kbd></button>`,
      )
      .join('');
    this.effKey = '';
  }

  hint(msg, sticky = false) {
    clearTimeout(this.hintTimer);
    this.hintEl.textContent = msg;
    if (this.hintEl2) this.hintEl2.textContent = msg;
    if (msg && !sticky) {
      this.hintTimer = setTimeout(() => {
        this.hintEl.textContent = '';
        if (this.hintEl2) this.hintEl2.textContent = '';
      }, 4000);
    }
  }

  // ---- コメントマーク ----
  // 先にコメントを付ける位置を固定し（app.ui.commentPin）、送信した時点で目印を作る。
  // 固定は送信か取り消しまで続くので、書くのに時間がかかっても位置はずれない

  // C キー／「ここにコメント」ボタン。書きかけがなければ、いまの瞬間を固定し直す
  startMark() {
    if (!this.app.player) {
      this.app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    if (!this.app.ui.commentPin || !this.input.value.trim()) this.setPin(true);
    this.input.focus();
  }

  // byMark: コメントマークで固定したか（入力欄に直接書き始めたときは false）
  setPin(byMark) {
    const app = this.app;
    const p = app.player;
    const now = app.now();
    const prev = app.ui.commentPin;
    let resume = !!prev?.resume;
    if (byMark && app.settings.pauseOnComment && p && !p.paused) {
      p.pause();
      resume = true;
    }
    // M や −9秒 の直後・近くの目印があるときは、その目印を固定する
    const { marker: m, fromTarget, t } = app.commentDest(now);
    app.ui.commentPin = m
      ? { markerId: m.id, t: m.t, fromTarget, resume }
      : { markerId: null, t: Math.round((t ?? now) * 100) / 100, fromTarget: false, resume };
    app.onPinChange();
  }

  nudgePin(d) {
    const pin = this.app.ui.commentPin;
    if (!pin || pin.markerId) return;
    pin.t = Math.round(Math.min(this.app.duration(), Math.max(0, pin.t + d)) * 100) / 100;
    this.app.onPinChange();
  }

  // 送信・取り消しのあと: 固定を外し、コメントマークで止めていたなら再生を戻す
  finishPin() {
    const app = this.app;
    const pin = app.ui.commentPin;
    app.ui.commentPin = null;
    this.input.value = '';
    this.input.blur();
    if (pin?.resume && app.settings.resumeAfterComment) app.player?.play();
    app.onPinChange();
  }

  bindComment() {
    const inp = this.input;
    this.markBtn.addEventListener('click', () => this.startMark());
    // ±1秒・取り消しボタンを押しても入力欄から離れないようにする
    this.pinEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    this.pinEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pin]');
      if (!b) return;
      if (b.dataset.pin === 'cancel') this.finishPin();
      else this.nudgePin(Number(b.dataset.pin));
    });
    // 入力欄に直接書き始めた場合は、書き始めた瞬間を固定する（再生は止めない）
    const autoPin = () => {
      if (!this.app.ui.commentPin && this.app.player) this.setPin(false);
    };
    inp.addEventListener('compositionstart', autoPin);
    inp.addEventListener('input', () => {
      if (inp.value) autoPin();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.finishPin();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = inp.value.trim();
      if (!text) return;
      if (!this.app.ui.commentPin) this.setPin(false);
      this.app.commentAt(text, this.app.ui.commentPin);
      this.finishPin();
    });
  }

  // 入力欄の左の表示: コメントマークのボタン、または固定した位置（±1秒・取り消し付き）
  renderPin() {
    const { ui, store, settings } = this.app;
    const pin = ui.commentPin;
    let label = '';
    let free = false;
    if (pin) {
      const pinned = pin.markerId && store.getMarker(pin.markerId);
      const near = !pinned && store.nearestMarker(pin.t, settings.mergeWindow);
      free = !pinned;
      if (pinned) label = tr('{time} の目印へ', { time: fmt(pinned.t, true) });
      else if (near) label = tr('近くの目印 {time} へ', { time: fmt(near.t, true) });
      else label = tr('{time} に新しい目印', { time: fmt(pin.t, true) });
    }
    const key = `${label}|${free}`;
    if (key === this.pinKey) return;
    this.pinKey = key;
    this.markBtn.hidden = !!pin;
    this.pinEl.hidden = !pin;
    if (!pin) return;
    const nudges = free
      ? `<button data-pin="-1" title="${tr('1秒前へ')}">${tr('−1秒')}</button><button data-pin="1" title="${tr('1秒後へ')}">${tr('+1秒')}</button>`
      : '';
    this.pinEl.innerHTML = `${icon('pin')}<span class="pin-label">${label}</span>${nudges}<button data-pin="cancel" title="${tr('取り消す (Esc)')}" aria-label="${tr('取り消す')}">${icon('x')}</button>`;
  }

  // ---- 前後の目印（この瞬間の下の一覧） ----
  // 自分の目印を時間順にすべて並べる。連動: 再生位置に合わせてスクロールし、いまの目印を強調する。
  // 連動しない: 自由にスクロールできる。行をクリックすると選ばれ、その下に「移動」「{s}秒前に移動」
  // 「コメントする」が出る（行を押しただけでは再生位置は動かさない）

  bindFeed() {
    const app = this.app;
    for (const b of this.feedSyncBtns) {
      b.addEventListener('click', () => {
        app.settings.feedSync = b.dataset.sync === '1';
        saveSettings(app.settings);
        this.feedPause = 0;
        this.applyFeedSync();
        this.feedCur = undefined; // 連動に戻したら、すぐにいまの目印へスクロールする
        this.tickFeed(app.now());
      });
    }
    // 手でスクロールしたり、行やボタンを押したりしたら、しばらく追いかけない
    // （押した行が動いて、ダブルクリックの2回目が別の行に当たらないように）
    const pause = () => {
      if (app.settings.feedSync) this.feedPause = performance.now() + 4000;
    };
    this.feedEl.addEventListener('wheel', pause, { passive: true });
    this.feedEl.addEventListener('touchstart', pause, { passive: true });
    this.feedEl.addEventListener('pointerdown', pause);
    this.feedEl.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.feedPointerAt = performance.now();
    }, { passive: true });
    this.feedEl.addEventListener('click', (e) => this.onFeedClick(e));
    this.feedEl.addEventListener('keydown', (e) => this.onFeedKeydown(e));
    this.feedEl.addEventListener('compositionstart', () => {
      this.feedComposing = true;
    });
    this.feedEl.addEventListener('compositionend', () => {
      this.feedComposing = false;
      if (this.feedDirty) {
        this.feedDirty = false;
        this.renderFeed();
      }
    });
    this.applyFeedSync();
  }

  applyFeedSync() {
    const on = !!this.app.settings.feedSync;
    for (const b of this.feedSyncBtns) {
      const me = (b.dataset.sync === '1') === on;
      b.classList.toggle('on', me);
      b.setAttribute('aria-pressed', String(me));
    }
  }

  onFeedClick(e) {
    const { app } = this;
    const { store } = app;
    // 選んだ行の下の操作
    const fa = e.target.closest('[data-fact]')?.dataset.fact;
    if (fa) {
      const m = this.feedSel && store.getMarker(this.feedSel);
      if (!m) return;
      if (fa === 'go' || fa === 'lead') {
        app.focusMarker(m.id, fa === 'lead');
        app.noteJump(`feed:${m.id}:${fa}`); // すばやく2回押すと再生も始める
      } else if (fa === 'add') this.setFeedAdding(!this.feedAdding);
      else if (fa === 'close') this.selectFeed(null);
      return;
    }
    if (e.target.closest('.feed-add')) return;
    const row = e.target.closest('.feed-item[data-id]');
    if (!row) return;
    const m = store.getMarker(row.dataset.id);
    if (!m) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cycle') store.updateMarker(m.id, { lv: (m.lv + 1) % 4 });
    else if (act === 'bm') store.updateMarker(m.id, { bm: !m.bm });
    else if (act === 'talk') {
      // コメントの印・コメントの文: その目印を選んで、すぐ書けるようにする
      if (this.feedAdding) {
        // 書いている途中なら、欄をそのまま別の目印へ移す（止めたまま。書きかけは前の目印のものなので持ち越さない）
        this.feedSel = m.id;
        this.paintFeed();
        this.focusFeedInput();
      } else {
        this.selectFeed(m.id, false);
        this.setFeedAdding(true);
      }
    } else if (act === 'del') {
      if (this.feedSel === m.id) this.selectFeed(null, false);
      store.deleteMarker(m.id);
      this.hint(tr('目印を削除しました（Ctrl+Z で元に戻せます）'));
    } else if (act === 'lead') {
      // −3秒（少し前へ）。すばやく2回押すと再生も始める
      app.focusMarker(m.id, true);
      app.noteJump(`feed:${m.id}:lead`);
    } else {
      // 行: 選ぶ（もう一度押すと外す）。再生位置は動かさない
      this.selectFeed(this.feedSel === m.id ? null : m.id);
    }
  }

  // 目印を選ぶ（null で外す）。別の目印に移ったら、書きかけのコメント欄は閉じる
  selectFeed(id, repaint = true) {
    if (id !== this.feedSel) this.endFeedAdding();
    this.feedSel = id;
    if (!repaint) return;
    this.paintFeed();
    if (id) this.revealFeedActs();
  }

  // 選んだ行の下の操作（とコメント欄）が、一覧の枠の中に見えるようにする（左の列はスクロールさせない）
  revealFeedActs() {
    const el = this.feedEl;
    const last = el.querySelector('.feed-add') || el.querySelector('.feed-acts');
    if (!last) return;
    const bottom = last.offsetTop + last.offsetHeight + 4;
    if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }

  focusFeedInput() {
    this.feedEl.querySelector('.feed-add-input')?.focus({ preventScroll: true });
    this.revealFeedActs();
  }

  // メディアを閉じるとき: 選んだ行・書きかけの欄を片付ける（次のメディアで勝手に再生しないよう、再生は戻さない）
  resetFeed() {
    this.feedSel = null;
    this.feedAdding = false;
    this.feedResume = false;
    this.feedCur = undefined;
    this.feedPause = 0;
    this.feedKey = '';
    this.feedMarks = '';
    this.feedList = [];
    this.feedComposing = false;
    this.feedDirty = false;
  }

  // 選んだ目印にコメントを書く欄を開く・閉じる。書いている間の一時停止は、C と同じ設定に従う
  setFeedAdding(on) {
    if (on === this.feedAdding) {
      if (on) this.focusFeedInput();
      return;
    }
    if (on) {
      const p = this.app.player;
      if (!this.feedAdding && this.app.settings.pauseOnComment && p && !p.paused) {
        p.pause();
        this.feedResume = true;
      }
      this.feedAdding = true;
    } else {
      this.endFeedAdding();
    }
    this.paintFeed();
    if (on) this.focusFeedInput();
  }

  // コメント欄を閉じる（書くために止めていたなら、設定に合わせて再生を戻す）。描き直しはしない
  endFeedAdding() {
    if (!this.feedAdding) return;
    this.feedAdding = false;
    if (this.feedResume && this.app.settings.resumeAfterComment) this.app.player?.play();
    this.feedResume = false;
  }

  onFeedKeydown(e) {
    if (!e.target.classList.contains('feed-add-input') || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.setFeedAdding(false);
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const { store } = this.app;
    const m = this.feedSel && store.getMarker(this.feedSel);
    const text = e.target.value.trim();
    if (!m || !text) return;
    e.target.value = '';
    this.setFeedAdding(false);
    store.addComment('marker', m.id, text, m.t);
    this.hint(tr('{time} の目印にコメントしました', { time: fmt(m.t, true) }));
  }

  render() {
    this.effKey = '';
    this.renderPin();
    this.renderFeed();
    this.tick(this.app.now());
  }

  tick(now) {
    const app = this.app;
    const t = fmt(now, true);
    if (t !== this.timeText) {
      this.timeText = t;
      this.timeEl.textContent = t;
    }

    // いま操作するとどの目印に付くか（コメントは eff、いいね・ブックマークはそれぞれの付け先）
    const on = !!app.player;
    const eff = on ? app.effectiveMarker(now) : null;
    const m = eff?.marker;
    const likeM = on ? app.likeMarker(now) : null;
    const bmM = on ? app.bookmarkMarker(now) : null;
    // 定型ボタンは、押すとその名前が外れる（付け先にもう付いている）ときに強調する
    const names = app.activePresetSet().items;
    const tagOn = names.map((n) => {
      const d = on && n ? app.tagMarker(n, now) : null;
      return !!d && d.tags.includes(n);
    });
    const sig = (x) => (x ? `${x.id}:${x.t}:${x.lv}:${x.bm}:${x.tags.join('\u0001')}` : '-');
    const effKey = `${on}:${eff?.kind}:${sig(m)}:${sig(likeM)}:${sig(bmM)}:${tagOn.join('')}:${likeM ? '' : Math.floor(now)}`;
    if (effKey !== this.effKey) {
      this.effKey = effKey;
      // 対象の目印とは別の場所に次のいいねが付くときは、それも書いておく
      const likeNote = m && likeM !== m
        ? `<span class="chip-sub">${tr('次のいいね → {where}', { where: likeM ? tr('近くの目印 {time}', { time: fmt(likeM.t, true) }) : tr('{time} に新しい目印', { time: fmt(now) }) })}</span>`
        : '';
      if (!on) this.chipEl.innerHTML = '';
      else if (eff?.kind === 'target') {
        this.chipEl.innerHTML = `<span class="chip is-target">${icon('pin')} ${tr('対象: {time} の目印', { time: fmt(m.t, true) })}${likeNote}<button data-act="release" title="${tr('対象から外す (Esc)')}" aria-label="${tr('対象から外す')}">${icon('x')}</button></span>`;
      } else if (eff) {
        this.chipEl.innerHTML = `<span class="chip is-new">${icon('pin')} ${tr('対象: 近くの目印 {time}', { time: fmt(m.t, true) })}${likeNote}</span>`;
      } else {
        this.chipEl.innerHTML = `<span class="chip is-new">${tr('いいね・コメントすると {time} に目印ができます', { time: fmt(now) })}</span>`;
      }
      for (const b of this.likeBtns) b.classList.toggle('on', !!likeM && likeM.lv === Number(b.dataset.lv));
      this.bmBtn.classList.toggle('on', !!bmM && bmM.bm);
      for (const b of this.quickEl.children) b.classList.toggle('on', tagOn[Number(b.dataset.qi)]);
    }

    this.tickFeed(now);
  }

  // 一覧の中身の印（目印・秒数・選んだ行）。対象・固定の目印は feedMarkKey で別に見る
  feedDataKey(list) {
    return (
      list.map((m) => `${m.id}:${m.t}:${m.lv}:${m.bm}:${m.tags.join('\u0001')}:${m.comments.length}:${commentSummary(m.comments)}`).join('\u0002') +
      `|${!!this.app.player}|${this.app.settings.leadIn}|${this.feedSel}|${this.feedAdding}`
    );
  }

  feedMarkKey() {
    const { ui } = this.app;
    return `${ui.target?.id || ''}|${ui.commentPin?.markerId || ''}`;
  }

  // 目印の一覧を作り直す（中身が変わったときだけ。対象・固定が変わっただけなら印を付け直す。
  // いまの目印の強調とスクロールは tickFeed）
  renderFeed() {
    const { store } = this.app;
    const list = this.app.player ? [...store.ownMarkers].sort((a, b) => a.t - b.t) : [];
    if (this.feedSel && !list.some((m) => m.id === this.feedSel)) this.selectFeed(null, false);
    // コメント欄で日本語を変換している途中は作り直さない（変換が切れないように）。変換が終わったら作り直す
    if (this.feedComposing) {
      this.feedDirty = true;
      return;
    }
    if (this.feedDataKey(list) !== this.feedKey) {
      this.feedList = list;
      this.paintFeed();
    } else if (this.feedMarkKey() !== this.feedMarks) {
      this.applyFeedMarks();
    }
  }

  // 対象・固定の目印の印だけを付け直す（書いているコメント欄はそのまま）
  applyFeedMarks() {
    const { ui } = this.app;
    this.feedMarks = this.feedMarkKey();
    const tid = ui.target?.id;
    const pinId = ui.commentPin?.markerId || '';
    for (const r of this.feedEl.querySelectorAll('.feed-item')) {
      r.classList.toggle('is-target', r.dataset.id === tid);
      r.classList.toggle('is-pinned', r.dataset.id === pinId);
    }
  }

  paintFeed() {
    const el = this.feedEl;
    const { ui, settings } = this.app;
    const list = this.feedList;
    this.feedKey = this.feedDataKey(list);
    this.feedMarks = this.feedMarkKey();
    // 書きかけのコメント（同じ目印の欄のときだけ）とスクロール位置は、描き直しても残す
    const inp = el.querySelector('.feed-add-input');
    const draft = inp ? { id: inp.dataset.for, value: inp.value, focused: document.activeElement === inp } : null;
    const scroll = el.scrollTop;
    this.feedNowKey = '';
    if (!this.app.player) {
      el.innerHTML = '';
      return;
    }
    if (!list.length) {
      el.innerHTML = `<div class="feed-empty">${tr('目印はまだありません。M キーか「目印」ボタンで、再生を止めずに付けられます')}</div>`;
      return;
    }
    const tid = ui.target?.id;
    const pinId = ui.commentPin?.markerId || '';
    const lead = settings.leadIn;
    const talkTip = tr('クリックでこの目印にコメントを書く');
    el.innerHTML = list
      .map((m) => {
        const sel = m.id === this.feedSel;
        const cls = (m.id === tid ? ' is-target' : '') + (m.id === pinId ? ' is-pinned' : '') + (sel ? ' is-selected' : '');
        // コメントの文を押しても、その目印にコメントを書ける
        let text = `<span class="fi-text muted" data-act="talk" title="${talkTip}">${tr('コメントなし')}</span>`;
        if (m.comments.length) text = `<span class="fi-text" data-act="talk" title="${talkTip}">${escapeHtml(commentSummary(m.comments))}</span>`;
        else if (m.tags.length) text = '<span class="fi-text"></span>';
        const n = m.comments.length;
        let html = `<div class="feed-item${cls}" data-id="${m.id}" title="${escapeHtml(tr('クリックで「移動」「{s}秒前に移動」「コメントする」を出す', { s: lead }))}">
          <span class="fi-time">${fmt(m.t, true)}</span>
          <button class="lead-btn" data-act="lead" title="${tr('{s}秒前へ移動（ダブルクリックでそこから再生）', { s: lead })}">${tr('−{s}秒', { s: lead })}</button>
          <button class="fi-like" data-act="cycle" title="${tr('いいね（クリックで 0→1→2→3→0）')}">${hearts(m.lv)}</button>
          <button class="fi-bm${m.bm ? ' on' : ''}" data-act="bm" title="${tr('ブックマーク')}">${icon('bookmark', m.bm ? 'fill' : '')}</button>
          <button class="fi-talk" data-act="talk" title="${talkTip}" aria-label="${talkTip}">${icon('comment')}${n ? `<span class="n">${n}</span>` : ''}</button>
          ${tagChips(m.tags)}
          ${text}
          <button class="fi-del" data-act="del" title="${tr('目印を削除')}">${icon('x')}</button>
        </div>`;
        if (!sel) return html;
        // 選んだ行の下に、移動・少し前に移動・コメントするを出す
        html += `<div class="feed-acts">
          <button type="button" data-fact="go" title="${tr('クリックで移動・ダブルクリックでそこから再生')}">${icon('play')}${tr('移動')}</button>
          <button type="button" data-fact="lead" title="${tr('{s}秒前へ移動・ダブルクリックでそこから再生', { s: lead })}">${icon('back')}${tr('{s}秒前に移動', { s: lead })}</button>
          <button type="button" data-fact="add"${this.feedAdding ? ' class="on"' : ''} title="${tr('この目印にコメントを追加する')}">${icon('comment')}${tr('コメントする')}</button>
          <span class="spacer"></span>
          <button type="button" data-fact="close" title="${tr('閉じる')}" aria-label="${tr('閉じる')}">${icon('x')}</button>
        </div>`;
        if (this.feedAdding) {
          html += `<div class="feed-add"><input class="field feed-add-input" type="text" data-for="${m.id}" placeholder="${tr('{time} の目印にコメント', { time: fmt(m.t, true) })}${tr('（Enter で追加・Esc でやめる）')}" autocomplete="off" aria-label="${tr('コメント')}"></div>`;
        }
        return html;
      })
      .join('');
    el.scrollTop = scroll;
    if (draft) {
      const next = el.querySelector('.feed-add-input');
      if (next && draft.id === next.dataset.for) {
        next.value = draft.value;
        if (draft.focused) next.focus({ preventScroll: true });
      }
    }
    this.tickFeed(this.app.now());
  }

  // 毎フレーム: いまの目印（近くの目印）を強調し、連動ならスクロールする
  tickFeed(now) {
    const list = this.feedList;
    if (!list || !list.length) return;
    // t 以下の一番後ろの目印の番号（なければ -1）
    const idx = (t) => {
      let lo = 0;
      let hi = list.length - 1;
      let r = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].t <= t) {
          r = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return r;
    };
    const win = this.app.settings.mergeWindow;
    const cur = idx(now + 0.05);
    const a = idx(now - win - 1e-6) + 1; // 近くの目印（前後 win 秒）の範囲
    const b = idx(now + win);
    const rows = this.feedEl.querySelectorAll('.feed-item');
    const nowKey = `${a}:${b}:${rows.length}`;
    if (nowKey !== this.feedNowKey) {
      this.feedNowKey = nowKey;
      rows.forEach((r, i) => r.classList.toggle('is-now', i >= a && i <= b));
    }
    const id = list[Math.max(cur, 0)].id;
    if (id === this.feedCur) return;
    const t = performance.now();
    const follow = this.app.settings.feedSync && !this.feedSel;
    // 一覧の上でマウスを動かしている間は待つ（押し間違えないように。止まったら合わせる）
    if (follow && t - this.feedPointerAt < 1200) return;
    this.feedCur = id;
    // 行を選んでいる間や、手でスクロール・操作した直後は追いかけない
    if (!follow || t < this.feedPause) return;
    // いまの目印の前に2行見えるようにする（前後の目印）
    const top = cur < 0 ? null : rows[Math.max(cur - 2, 0)];
    this.feedEl.scrollTop = top ? Math.max(0, top.offsetTop - 2) : 0;
  }
}
