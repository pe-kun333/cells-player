import { $, $$, fmt, escapeHtml, hearts, icon, commentSummary, tagChips } from './util.js';
import { tr } from './i18n.js';

// 動画の下の「この瞬間」パネル。いいね・コメントは常に目印（瞬間）に付く
export class Moment {
  constructor(app) {
    this.app = app;
    this.timeEl = $('#momentTime');
    this.chipEl = $('#targetChip');
    this.hintEl = $('#momentHint');
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
    if (msg && !sticky) {
      this.hintTimer = setTimeout(() => {
        this.hintEl.textContent = '';
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
    if (byMark && app.settings.pauseOnMark && p && !p.paused) {
      p.pause();
      resume = true;
    }
    // M や −9秒 の直後・近くの目印があるときは、その目印を固定する
    const { marker: m, fromTarget } = app.commentDest(now);
    app.ui.commentPin = m
      ? { markerId: m.id, t: m.t, fromTarget, resume }
      : { markerId: null, t: Math.round(now * 100) / 100, fromTarget: false, resume };
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

  bindFeed() {
    this.feedEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const { store } = this.app;
      const m = store.getMarker(row.dataset.id);
      if (!m) return;
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cycle') store.updateMarker(m.id, { lv: (m.lv + 1) % 4 });
      else if (act === 'bm') store.updateMarker(m.id, { bm: !m.bm });
      else if (act === 'del') {
        store.deleteMarker(m.id);
        this.hint(tr('目印を削除しました（Ctrl+Z で元に戻せます）'));
      } else {
        // 行（その瞬間へ）と −3秒（少し前へ）。すばやく2回押すと再生も始める
        this.app.focusMarker(m.id, act === 'lead');
        this.app.noteJump(`feed:${m.id}:${act || 'row'}`);
      }
    });
  }

  render() {
    this.effKey = '';
    this.feedKey = '';
    this.renderPin();
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

    this.renderFeed(now);
  }

  renderFeed(now) {
    const { store, settings, ui } = this.app;
    const win = settings.mergeWindow;
    const near = [...store.markers]
      .sort((a, b) => Math.abs(a.t - now) - Math.abs(b.t - now))
      .slice(0, 6)
      .sort((a, b) => a.t - b.t);
    const tid = ui.target?.id;
    const lead = settings.leadIn;
    const key =
      near.map((m) => `${m.id}:${m.t}:${m.lv}:${m.bm}:${m.tags.join('\u0001')}:${m.comments.length}:${Math.abs(m.t - now) <= win ? 1 : 0}`).join('|') +
      '|' + tid + '|' + !!this.app.player + '|' + lead;
    if (key === this.feedKey) return;
    this.feedKey = key;

    if (!this.app.player) {
      this.feedEl.innerHTML = '';
      return;
    }
    if (!near.length) {
      this.feedEl.innerHTML = `<div class="feed-empty">${tr('目印はまだありません。M キーか「目印」ボタンで、再生を止めずに付けられます')}</div>`;
      return;
    }
    this.feedEl.innerHTML = near
      .map((m) => {
        const cls = (Math.abs(m.t - now) <= win ? ' is-now' : '') + (m.id === tid ? ' is-target' : '');
        let text = `<span class="fi-text muted">${tr('コメントなし')}</span>`;
        if (m.comments.length) text = `<span class="fi-text">${escapeHtml(commentSummary(m.comments))}</span>`;
        else if (m.tags.length) text = '<span class="fi-text"></span>';
        return `<div class="feed-item${cls}" data-id="${m.id}" title="${tr('クリックでこの目印へ移動・ダブルクリックでそこから再生')}">
          <span class="fi-time">${fmt(m.t, true)}</span>
          <button class="lead-btn" data-act="lead" title="${tr('{s}秒前へ移動（ダブルクリックでそこから再生）', { s: lead })}">${tr('−{s}秒', { s: lead })}</button>
          <button class="fi-like" data-act="cycle" title="${tr('いいね（クリックで 0→1→2→3→0）')}">${hearts(m.lv)}</button>
          <button class="fi-bm${m.bm ? ' on' : ''}" data-act="bm" title="${tr('ブックマーク')}">${icon('bookmark', m.bm ? 'fill' : '')}</button>
          ${tagChips(m.tags)}
          ${text}
          <button class="fi-del" data-act="del" title="${tr('目印を削除')}">${icon('x')}</button>
        </div>`;
      })
      .join('');
  }
}
