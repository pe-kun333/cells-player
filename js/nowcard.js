import { $, $$, fmt, fmtLen, escapeHtml, icon, cellLabel, clamp, round2 } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// いまのカード（右のサイドバーの先頭）: いま見ている場面の操作を1か所にまとめる。
// ・上: 再生の操作（再生・±5秒・移動する前に戻る）と時刻、たたむ
// ・いまのセル: 範囲・メモ（その場で編集）・最近のコメント・セルの中の小さな帯（クリックで移動、Shift+クリックで分割）、
//   始まり／終わり・リピート・いいね・ブックマーク、右端に分割
// ・この瞬間: 目印・少し前に目印・いいね・ブックマーク・よく使うコメント
// ・コメント: 書いてから「この瞬間に」か「このセルに」を押す（Enter は このセルに）。書き始めた時刻に固定する。
//   書いている間の一時停止は、選んだときだけ（設定）
// 一覧をスクロールしたら自動でたたむかどうかも、設定で選べる
export class NowCard {
  constructor(app) {
    this.app = app;
    this.el = $('#nowCard');
    this.cellEl = $('#ncCell');
    this.targetEl = $('#ncTarget');
    this.input = $('#ncInput');
    this.pinEl = $('#ncPin');
    this.folded = false;
    this.autoFolded = false;
    this.editing = null; // メモを編集しているセルの id
    this.cellKey = '';
    this.momentKey = '';
    this.pinKey = '';
    this.pin = null; // { t, markerId, fromTarget, cellId, resume }

    this.el.addEventListener('click', (e) => this.onClick(e));
    $('#ncSet').addEventListener('change', (e) => {
      app.setPresetSet(e.target.value);
      e.target.blur();
    });
    $('#ncPause').addEventListener('change', (e) => {
      app.settings.pauseOnComment = e.target.checked;
      saveSettings(app.settings);
    });
    this.bindComment();
    this.bindStrip();
    // 一覧をスクロールしたら、設定に合わせて自動でたたむ（先頭に戻ると開く）
    $('#sideList').addEventListener('scroll', (e) => {
      if (!app.settings.cardAutoFold) return;
      const top = e.target.scrollTop;
      if (top > 60 && !this.folded) {
        this.autoFolded = true;
        this.setFolded(true);
      } else if (top < 8 && this.folded && this.autoFolded) {
        this.autoFolded = false;
        this.setFolded(false);
      }
    }, { passive: true });
  }

  get on() {
    return document.body.classList.contains('ops-card');
  }

  setFolded(v) {
    this.folded = v;
    this.el.classList.toggle('is-folded', v);
    const b = $('#ncFold');
    b.setAttribute('aria-expanded', String(!v));
    b.title = v ? tr('ひらく') : tr('たたむ');
    this.cellKey = '';
    this.tick(this.app.now());
  }

  // ---- 描き直し ----

  // メモが変わったとき・設定を変えたとき（renderAll から）
  render() {
    const { app } = this;
    this.el.hidden = !(this.on && app.player && app.store.doc);
    if (this.el.hidden) return;
    $('#ncPause').checked = !!app.settings.pauseOnComment;
    this.renderMomentButtons();
    this.cellKey = '';
    this.momentKey = '';
    this.pinKey = '';
    this.tick(app.now());
  }

  renderMomentButtons() {
    const { app } = this;
    $('#ncOffsets').innerHTML = app.settings.offsets
      .map((s) => `<button type="button" class="nc-btn nc-off" data-nc="off" data-off="${s}" title="${tr('{s}秒前に目印', { s })}">−${s}</button>`)
      .join('');
    const set = app.activePresetSet();
    const sel = $('#ncSet');
    sel.innerHTML = app.settings.presetSets.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    sel.value = set.id;
    $('#ncTags').innerHTML = set.items
      .map((name, i) =>
        name
          ? `<button type="button" class="nc-tag" data-nc="tag" data-qi="${i}" title="${escapeHtml(tr('{name}（{key} キー）', { name, key: i + 4 }))}"><span>${escapeHtml(name)}</span><kbd>${i + 4}</kbd></button>`
          : '',
      )
      .join('');
  }

  // 監視から毎回呼ぶ（変わったところだけ描き直す）
  tick(now) {
    const { app } = this;
    if (this.el.hidden) return;
    $('#ncTime').textContent = fmt(now, true);
    const c = app.cellAt(now);
    this.renderCell(c, now);
    this.renderSummary(c);
    if (this.folded) return;
    this.renderMoment(now);
    this.renderPin(now, c);
  }

  // たたんだときに上の行に出す、いまのセルの一言
  renderSummary(c) {
    const el = $('#ncSummary');
    const text = this.folded && c ? `${fmt(c.s)}–${fmt(c.e)} ${cellLabel(c, 16)}` : '';
    if (el.textContent !== text) el.textContent = text;
  }

  renderCell(c, now) {
    const { app } = this;
    if (this.folded) return;
    // セルの中の帯: 再生位置だけ毎回動かす
    if (c) {
      const p = clamp((now - c.s) / (c.e - c.s), 0, 1) * 100;
      const played = this.cellEl.querySelector('.nc-played');
      const head = this.cellEl.querySelector('.nc-playhead');
      if (played) played.style.width = p + '%';
      if (head) head.style.left = p + '%';
    }
    if (this.editing) return; // メモを書いている間は描き直さない
    const list = c ? app.cellsAt(now) : [];
    const inPl = c ? app.playlist.has(app.store.doc?.id, c.id) : false;
    const last = c?.comments[c.comments.length - 1];
    const key = c
      ? [c.id, c.s, c.e, c.lv, c.bm, c.memo, c.comments.length, last?.text, app.ui.repeatId === c.id, list.length, list.indexOf(c), inPl].join('|')
      : 'none';
    if (key === this.cellKey) return;
    this.cellKey = key;
    if (!c) {
      this.cellEl.innerHTML = `<div class="nc-empty">${tr('再生位置にセルはありません')}</div>
        <div class="nc-row">
          <button type="button" class="nc-btn" data-nc="make" title="${tr('いまいる区間（前後の目印の間）をセルにする (Enter)')}">${icon('cell')}${tr('区間をセル化')}<kbd>Enter</kbd></button>
          <button type="button" class="nc-btn" data-nc="makeLeft" title="${tr('いま付けた目印（目印を選んでいなければ、再生位置の直前の目印）の左の区間を、セルにする (Shift+Enter)')}">${tr('左の区間をセル化')}<kbd>Shift+Enter</kbd></button>
        </div>`;
      return;
    }
    const memo = c.memo.trim();
    const rep = app.ui.repeatId === c.id;
    const pips = [1, 2, 3].map((n) => `<i class="${n <= c.lv ? 'on' : ''}"></i>`).join('');
    const recent = last ? `<div class="nc-cm">${icon('comment')}<span>${escapeHtml(last.text)}</span>${c.comments.length > 1 ? `<span class="nc-cm-more">${tr('ほか {n} 件のコメント', { n: c.comments.length - 1 })}</span>` : ''}</div>` : '';
    const cycle = list.length > 1
      ? `<button type="button" class="nc-btn nc-cycle" data-nc="cycle" title="${tr('重なっているセルのうち、操作するセルを切り替える')}">${list.indexOf(c) + 1}/${list.length} ⇄</button>`
      : '';
    const plTitle = inPl ? tr('プレイリストから外す') : tr('プレイリストに入れる');
    this.cellEl.innerHTML = `
      <div class="nc-row nc-cell-head">
        ${icon('cell')}<b class="nc-range">${fmt(c.s, true)}–${fmt(c.e, true)}</b><span class="nc-len">${fmtLen(c.e - c.s)}</span>
        ${cycle}
        <span class="spacer"></span>
        <button type="button" class="nc-btn${inPl ? ' on' : ''}" data-nc="pl" title="${plTitle}" aria-label="${plTitle}">${icon(inPl ? 'check' : 'list-add')}</button>
      </div>
      <button type="button" class="nc-memo${memo ? '' : ' is-empty'}" data-nc="memo" title="${tr('クリックで編集')}">${memo ? escapeHtml(memo) : tr('メモを書く…')}</button>
      ${recent}
      <div class="nc-strip" title="${tr('クリックでその位置へ・Shift+クリックでそこで分割')}"><div class="nc-played"></div><div class="nc-playhead"></div><div class="nc-guide" hidden></div></div>
      <div class="nc-row">
        <button type="button" class="nc-btn" data-nc="start" title="${tr('セルの始まりを再生位置にする（となりのセルとの境目も一緒に動きます）')}">${tr('⇤ 始まり')}</button>
        <button type="button" class="nc-btn" data-nc="end" title="${tr('セルの終わりを再生位置にする（となりのセルとの境目も一緒に動きます）')}">${tr('終わり ⇥')}</button>
        <button type="button" class="nc-btn${rep ? ' on' : ''}" data-nc="repeat" title="${tr('リピート再生（同時に1つだけ）')} (R)" aria-label="${tr('リピート')}">${icon('repeat')}</button>
        <button type="button" class="nc-btn nc-like-cycle" data-nc="like" data-lv="${c.lv}" title="${tr('いいね（押すたびに 1 → 2 → 3 → 解除）')}">${icon('heart', c.lv ? 'fill' : '')}<span class="pips">${pips}</span></button>
        <button type="button" class="nc-btn${c.bm ? ' on' : ''}" data-nc="bm" title="${tr('ブックマーク')}" aria-pressed="${c.bm}">${icon('bookmark', c.bm ? 'fill' : '')}</button>
        <button type="button" class="nc-btn primary" data-nc="split" title="${tr('再生位置で2つに分ける（メモ・いいね・コメントは前のセルに残ります） (S)')}">${icon('scissors')}${tr('分割')}<kbd>S</kbd></button>
      </div>`;
    // 帯の再生位置をすぐに合わせる
    const p = clamp((now - c.s) / (c.e - c.s), 0, 1) * 100;
    this.cellEl.querySelector('.nc-played').style.width = p + '%';
    this.cellEl.querySelector('.nc-playhead').style.left = p + '%';
  }

  // この瞬間: いいね・ブックマーク・定型コメントがどこに付くかの表示と、押したときに外れるものの強調
  renderMoment(now) {
    const { app } = this;
    const eff = app.effectiveMarker(now);
    const m = eff?.marker;
    const likeM = app.likeMarker(now);
    const bmM = app.bookmarkMarker(now);
    const names = app.activePresetSet().items;
    const tagOn = names.map((n) => {
      const d = n ? app.tagMarker(n, now) : null;
      return !!d && d.tags.includes(n);
    });
    const sig = (x) => (x ? `${x.id}:${x.t}:${x.lv}:${x.bm}:${x.tags.join('\u0001')}` : '-');
    const key = `${eff?.kind}:${sig(m)}:${sig(likeM)}:${sig(bmM)}:${tagOn.join('')}:${m ? '' : Math.floor(now)}`;
    if (key === this.momentKey) return;
    this.momentKey = key;
    if (eff?.kind === 'target') {
      this.targetEl.innerHTML = `<span class="chip is-target">${icon('pin')} ${tr('対象: {time} の目印', { time: fmt(m.t, true) })}<button type="button" data-nc="release" title="${tr('対象から外す (Esc)')}" aria-label="${tr('対象から外す')}">${icon('x')}</button></span>`;
    } else if (eff) {
      this.targetEl.innerHTML = `<span class="chip is-new">${icon('pin')} ${tr('対象: 近くの目印 {time}', { time: fmt(m.t, true) })}</span>`;
    } else {
      this.targetEl.innerHTML = '';
    }
    for (const b of $$('#nowCard [data-nc="mlike"]')) b.classList.toggle('on', !!likeM && likeM.lv === Number(b.dataset.lv));
    $('#ncBm').classList.toggle('on', !!bmM && bmM.bm);
    for (const b of $$('#ncTags [data-qi]')) b.classList.toggle('on', tagOn[Number(b.dataset.qi)]);
  }

  // コメントの行: どこに付くか（書き始めたら、その時刻とセルに固定）
  renderPin(now, c) {
    const { app } = this;
    const p = this.pin;
    const t = p ? p.t : now;
    const cell = p ? (p.cellId && app.store.getCell(p.cellId)) : c;
    const key = p ? `pin:${p.t}:${p.markerId}:${cell?.id}` : `now:${Math.floor(now * 10)}:${c?.id}`;
    if (key === this.pinKey) return;
    this.pinKey = key;
    const where = p
      ? tr('{time} に固定', { time: fmt(t, true) })
      : tr('いま {time}', { time: fmt(t, true) });
    this.pinEl.innerHTML = `${icon('pin')}<span>${where}</span>${p ? `<button type="button" data-nc="unpin" title="${tr('取り消す (Esc)')}" aria-label="${tr('取り消す')}">${icon('x')}</button>` : ''}`;
    this.pinEl.classList.toggle('is-pinned', !!p);
    const toCell = $('#ncToCell');
    toCell.disabled = !cell;
    toCell.querySelector('span').textContent = cell ? tr('このセルに（{range}）', { range: `${fmt(cell.s)}–${fmt(cell.e)}` }) : tr('このセルに');
  }

  // ---- コメント ----

  // 書き始め（C キー・入力欄に書き始めたとき・前後の目印の 💬）。その時刻と、そのときのセルに固定する
  startComment({ markerId = null, focus = true } = {}) {
    const { app } = this;
    if (!app.player) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    if (this.folded) this.setFolded(false);
    if (!this.pin || markerId) this.setPin(markerId);
    if (focus) this.input.focus();
  }

  setPin(markerId) {
    const { app } = this;
    const p = app.player;
    const now = app.now();
    let resume = !!this.pin?.resume;
    // 一時停止は、選んだときだけ
    if (app.settings.pauseOnComment && p && !p.paused) {
      p.pause();
      resume = true;
    }
    let m = markerId ? app.store.getMarker(markerId) : null;
    let fromTarget = false;
    let t = now;
    if (!m) {
      const d = app.commentDest(now);
      m = d.marker;
      fromTarget = d.fromTarget;
      t = d.t ?? now;
    }
    const at = m ? m.t : round2(t);
    this.pin = { t: at, markerId: m?.id || null, fromTarget, cellId: app.cellAt(at)?.id || app.cellAt(now)?.id || null, resume };
    // 目印のほうはタイムラインにも出す（点線の目印）
    app.ui.commentPin = { markerId: this.pin.markerId, t: at, fromTarget, resume };
    app.onPinChange();
  }

  finishComment() {
    const { app } = this;
    const pin = this.pin;
    this.pin = null;
    app.ui.commentPin = null;
    this.input.value = '';
    this.input.blur();
    if (pin?.resume && app.settings.resumeAfterComment) app.player?.play();
    app.onPinChange();
  }

  // dest: 'moment'（この瞬間に）か 'cell'（このセルに）
  post(dest) {
    const { app } = this;
    const text = this.input.value.trim();
    if (!text) {
      this.input.focus();
      return;
    }
    if (!this.pin) this.setPin(null);
    const pin = this.pin;
    if (dest === 'cell') {
      const c = pin.cellId && app.store.getCell(pin.cellId);
      if (!c) {
        app.hint(tr('この時刻にセルがないので、この瞬間（目印）にコメントしました'));
        dest = 'moment';
      } else {
        app.store.addComment('cell', c.id, text, clamp(pin.t, c.s, c.e));
        app.hint(tr('セル（{range}）にコメントしました', { range: `${fmt(c.s)}–${fmt(c.e)}` }));
      }
    }
    if (dest === 'moment') app.commentAt(text, { markerId: pin.markerId, t: pin.t, fromTarget: pin.fromTarget });
    this.finishComment();
  }

  bindComment() {
    const inp = this.input;
    // 書き始めた瞬間に固定する
    const autoPin = () => {
      if (!this.pin && this.app.player) this.setPin(null);
    };
    inp.addEventListener('compositionstart', autoPin);
    inp.addEventListener('input', () => {
      if (inp.value) autoPin();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        this.finishComment();
        return;
      }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      // Enter は このセルに（Shift+Enter は この瞬間に）
      this.post(e.shiftKey ? 'moment' : 'cell');
    });
    $('#ncToMoment').addEventListener('click', () => this.post('moment'));
    $('#ncToCell').addEventListener('click', () => this.post('cell'));
    // ボタンを押しても入力欄から離れない（書いた文が残る）
    for (const b of [$('#ncToMoment'), $('#ncToCell')]) b.addEventListener('mousedown', (e) => e.preventDefault());
  }

  // ---- セルの中の帯 ----

  bindStrip() {
    const timeAt = (strip, x) => {
      const c = this.app.cellAt();
      if (!c) return null;
      const r = strip.getBoundingClientRect();
      return { c, t: c.s + clamp((x - r.left) / r.width, 0, 1) * (c.e - c.s) };
    };
    this.cellEl.addEventListener('click', (e) => {
      const strip = e.target.closest('.nc-strip');
      if (!strip) return;
      const hit = timeAt(strip, e.clientX);
      if (!hit) return;
      if (e.shiftKey) this.app.splitCellAt(hit.c.id, hit.t);
      else this.app.seek(hit.t);
    });
    this.cellEl.addEventListener('pointermove', (e) => {
      const strip = e.target.closest('.nc-strip');
      const guide = this.cellEl.querySelector('.nc-guide');
      if (!guide) return;
      const hit = strip && timeAt(strip, e.clientX);
      if (!hit) {
        guide.hidden = true;
        return;
      }
      const r = strip.getBoundingClientRect();
      guide.hidden = false;
      guide.style.left = clamp(e.clientX - r.left, 0, r.width) + 'px';
      guide.classList.toggle('is-cut', e.shiftKey);
      guide.dataset.t = (e.shiftKey ? '✂ ' : '') + fmt(hit.t, true);
    });
    this.cellEl.addEventListener('pointerleave', () => {
      const guide = this.cellEl.querySelector('.nc-guide');
      if (guide) guide.hidden = true;
    });
  }

  // ---- メモの編集 ----

  editMemo(c) {
    this.editing = c.id;
    const btn = this.cellEl.querySelector('[data-nc="memo"]');
    const ta = document.createElement('textarea');
    ta.className = 'field nc-memo-edit';
    ta.rows = 2;
    ta.value = c.memo;
    ta.placeholder = tr('このセルのメモ');
    btn.replaceWith(ta);
    ta.focus();
    const done = (save) => {
      if (this.editing !== c.id) return;
      this.editing = null;
      if (save && ta.value !== c.memo) this.app.store.updateCell(c.id, { memo: ta.value.trim() });
      this.cellKey = '';
      this.tick(this.app.now());
    };
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        done(false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        done(true);
      }
    });
    ta.addEventListener('blur', () => done(true));
  }

  // ---- ボタン ----

  onClick(e) {
    const b = e.target.closest('[data-nc]');
    if (!b) return;
    const { app } = this;
    const act = b.dataset.nc;
    const now = app.now();
    switch (act) {
      case 'play':
        return app.togglePlay();
      case 'back5':
        return app.seek(now - 5);
      case 'fwd5':
        return app.seek(now + 5);
      case 'jump':
        return app.jumpBack();
      case 'fold':
        this.autoFolded = false;
        return this.setFolded(!this.folded);
      case 'mark':
        return app.markAt(now);
      case 'off': {
        const off = Number(b.dataset.off);
        return app.markAt(now - off, { offset: off });
      }
      case 'mlike':
        return app.rateMoment(Number(b.dataset.lv));
      case 'mbm':
        return app.toggleMomentBookmark();
      case 'tag':
        return app.toggleQuickTag(Number(b.dataset.qi));
      case 'editTags':
        return app.openPresets();
      case 'release':
        return app.releaseTarget();
      case 'unpin':
        return this.finishComment();
      case 'make':
        return app.makeCellHere();
      case 'makeLeft':
        return app.makeCellLeft();
      case 'cycle':
        return app.cycleCellTarget();
    }
    const c = app.cellAt(now);
    if (!c) return;
    switch (act) {
      case 'memo':
        return this.editMemo(c);
      case 'pl':
        app.playlist.toggle(app.store.doc, 'cell', c);
        return;
      case 'start':
        return app.setCellEdge(c.id, 's');
      case 'end':
        return app.setCellEdge(c.id, 'e');
      case 'repeat':
        return app.toggleRepeat(c.id);
      case 'like':
        return app.store.updateCell(c.id, { lv: (c.lv + 1) % 4 });
      case 'bm':
        return app.store.updateCell(c.id, { bm: !c.bm });
      case 'split':
        return app.splitCellAt(c.id);
    }
  }
}
