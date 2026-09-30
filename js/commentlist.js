import { $, fmt, escapeHtml, icon, whoColor, viaBadges } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// 右サイドバーの下の一覧。「瞬間のコメント」（目印のコメントと定型コメント）と「文字起こし」（字幕の行）を
// 切り替えて、時間順に小さく並べる。
// 連動: 再生位置に合わせてスクロールし、いまの行を強調する。連動しない: 自由にスクロールできる。
// 行をクリックすると選択され、「ここに移動」「少し前から」「コメント」などができる。
// 文字起こしでは、行の編集・削除・単語帳への追加と、Shift+クリックで選んだ範囲をセルにすることもできる
export class CommentList {
  constructor(app) {
    this.app = app;
    this.root = $('#momentList');
    this.body = $('#mlistBody');
    this.toggleBtn = $('#mlistToggle');
    this.syncBtns = [...this.root.querySelectorAll('[data-sync]')];
    this.tabBtns = [...this.root.querySelectorAll('[data-mode]')];
    this.countEls = [...this.root.querySelectorAll('[data-count]')];
    this.rows = [];
    this.key = '';
    this.cur = -2;
    this.sel = null;      // 選択中の行の key（範囲選択の起点）
    this.selEnd = null;   // Shift+クリックで選んだ範囲の終わり
    this.adding = false;  // 選択中の行にコメントを書いているか
    this.editing = null;  // 文字起こしの行を直しているときの key
    this.selText = '';    // 単語帳に入れるために選んでいた文字
    this.pauseUntil = 0;  // 手でスクロールしたら、しばらく追いかけない

    this.toggleBtn.addEventListener('click', () => {
      app.settings.momentListOpen = !app.settings.momentListOpen;
      saveSettings(app.settings);
      this.applyState();
      this.cur = -2;
    });
    for (const b of this.tabBtns) b.addEventListener('click', () => this.setMode(b.dataset.mode));
    for (const b of this.syncBtns) {
      b.addEventListener('click', () => {
        app.settings.momentListSync = b.dataset.sync === '1';
        saveSettings(app.settings);
        this.pauseUntil = 0;
        this.applyState();
        this.cur = -2; // 連動に戻したら、すぐにいまの位置へスクロールする
      });
    }
    $('#mlistTools').addEventListener('click', (e) => {
      const a = e.target.closest('[data-tool]')?.dataset.tool;
      if (a === 'shadow' || a === 'dictation') app.startPractice(a);
      else if (a === 'tools') app.openTxTools();
    });
    const pause = () => {
      if (app.settings.momentListSync) this.pauseUntil = performance.now() + 4000;
    };
    this.body.addEventListener('wheel', pause, { passive: true });
    this.body.addEventListener('touchstart', pause, { passive: true });
    this.body.addEventListener('pointerdown', (e) => {
      // スクロールバーをつかんだときも止める
      if (e.target === this.body) pause();
      // 「単語帳」を押す前に選んでいた文字を覚えておく（押すと選択が外れることがあるため）
      if (e.target.closest('[data-mact="word"]')) this.selText = String(window.getSelection?.() || '').trim();
    });
    this.body.addEventListener('click', (e) => this.onClick(e));
    this.body.addEventListener('keydown', (e) => this.onKeydown(e));
    this.body.addEventListener('focusout', (e) => {
      // 行を直している途中で外をクリックしたら保存する（描き直しで消えたときは何もしない）
      if (e.target.classList.contains('medit') && e.target.isConnected && this.editing) this.saveEdit(e.target);
    });
    this.applyState();
  }

  get mode() {
    return this.app.settings.momentListMode === 'transcript' ? 'transcript' : 'comments';
  }

  // 一覧を「瞬間のコメント」か「文字起こし」に切り替える（閉じていたら開く）
  setMode(mode) {
    const s = this.app.settings;
    s.momentListMode = mode;
    s.momentListOpen = true;
    saveSettings(s);
    this.clearSelection();
    this.key = '';
    this.applyState();
    this.render();
  }

  applyState() {
    const { momentListOpen, momentListSync } = this.app.settings;
    this.root.classList.toggle('is-closed', !momentListOpen);
    this.root.classList.toggle('mode-transcript', this.mode === 'transcript');
    this.toggleBtn.setAttribute('aria-expanded', String(momentListOpen));
    for (const b of this.syncBtns) b.classList.toggle('on', (b.dataset.sync === '1') === momentListSync);
    for (const b of this.tabBtns) {
      b.classList.toggle('on', b.dataset.mode === this.mode);
      b.setAttribute('aria-selected', String(b.dataset.mode === this.mode));
    }
  }

  // 瞬間のコメント: コメントごとに1行。コメントのない目印は、定型コメント（タグ）だけの行にする
  collectComments() {
    const rows = [];
    const { store } = this.app;
    for (const m of store.markers) {
      const sh = store.shareOf(m);
      if (m.comments.length) {
        m.comments.forEach((c, i) =>
          rows.push({ key: c.id, id: m.id, t: m.t, text: c.text, tags: i === 0 ? m.tags : [], sh, by: c.by, via: c.via }),
        );
      } else if (m.tags.length) {
        rows.push({ key: 'm:' + m.id, id: m.id, t: m.t, text: '', tags: m.tags, sh });
      }
    }
    return rows.sort((a, b) => a.t - b.t);
  }

  // 文字起こし: 字幕の行ごとに1行（目印ではないので id はなく、行の id を cueId に持つ）
  collectTranscript() {
    return this.app.store.cues.map((c) => ({ key: 'tx:' + c.id, id: null, cueId: c.id, t: c.s, e: c.e, text: c.text, tags: [] }));
  }

  render() {
    const { store } = this.app;
    const comments = store.doc ? this.collectComments() : [];
    const transcript = store.doc ? this.collectTranscript() : [];
    for (const el of this.countEls) {
      const n = el.dataset.count === 'transcript' ? transcript.length : comments.length;
      el.textContent = n ? String(n) : '';
    }
    const rows = this.mode === 'transcript' ? transcript : comments;
    const key = this.mode + '\u0003' + rows.map((r) => `${r.key}:${r.t}:${r.tags.join('\u0001')}:${r.text}:${r.sh?.id || ''}:${r.sh?.color ?? ''}:${r.via || ''}`).join('\u0002');
    if (key === this.key && this.body.childElementCount) {
      this.tick(this.app.now());
      return;
    }
    this.key = key;
    this.rows = rows;
    if (this.sel && !rows.some((r) => r.key === this.sel)) this.clearSelection();
    if (this.selEnd && !rows.some((r) => r.key === this.selEnd)) this.selEnd = null;
    if (this.editing && !rows.some((r) => r.key === this.editing)) this.editing = null;
    this.paint();
  }

  clearSelection() {
    this.sel = null;
    this.selEnd = null;
    this.adding = false;
    this.editing = null;
  }

  // 選ばれている行の範囲 [lo, hi]（選んでいなければ null）
  range() {
    const a = this.rows.findIndex((r) => r.key === this.sel);
    if (a < 0) return null;
    const b = this.selEnd ? this.rows.findIndex((r) => r.key === this.selEnd) : a;
    return b < 0 ? [a, a] : [Math.min(a, b), Math.max(a, b)];
  }

  paint() {
    // 書きかけの入力とスクロール位置は描き直しても残す
    const input = this.body.querySelector('.madd-input, .medit');
    const draft = input ? { cls: input.className, value: input.value, focused: document.activeElement === input } : null;
    const scroll = this.body.scrollTop;
    if (!this.app.store.doc) {
      this.body.innerHTML = '';
    } else if (!this.rows.length) {
      this.body.innerHTML =
        this.mode === 'transcript'
          ? `<div class="mlist-empty">${tr('文字起こしはまだありません。「字幕を読み込む」「貼り付け」「音声認識」で追加できます')}</div>`
          : `<div class="mlist-empty">${tr('まだありません。C キーで、いまの瞬間にコメントを書けます')}</div>`;
    } else {
      const rg = this.range();
      this.body.innerHTML = this.rows.map((r, i) => this.rowHtml(r, i, rg)).join('');
    }
    this.body.scrollTop = scroll;
    if (draft) {
      const next = this.body.querySelector(draft.cls.includes('medit') ? '.medit' : '.madd-input');
      if (next) {
        next.value = draft.value;
        if (draft.focused) next.focus();
      }
    }
    this.cur = -2;
    this.tick(this.app.now());
  }

  rowHtml(r, i, rg) {
    const inRange = rg && i >= rg[0] && i <= rg[1];
    const last = rg && i === rg[1];
    const full = `${fmt(r.t, true)}  ${r.tags.map((t) => tr('［{tag}］', { tag: t })).join('')}${r.text}`;
    let html;
    if (r.key === this.editing) {
      html = `<div class="mrow is-selected is-editing" data-key="${escapeHtml(r.key)}"><span class="mt">${fmt(r.t)}</span>
        <textarea class="medit" rows="1" spellcheck="false">${escapeHtml(r.text)}</textarea></div>
        <div class="medit-hint">${tr('Enter で保存・Shift+Enter で改行・Esc でやめる')}</div>`;
      return html;
    }
    const tags = r.tags.map((t) => `<span class="mtag">${escapeHtml(t)}</span>`).join('');
    const text = r.text.replace(/\s*\n\s*/g, ' ');
    // 共有で読み込んだコメント・取り込んだコメントには、書いた人の名前を付ける
    const whoName = r.by || r.sh?.by;
    const who = whoName ? `<span class="mwho"${r.sh ? ` style="--who:${whoColor(r.sh)}"` : ''}>${escapeHtml(whoName)}</span>` : '';
    const viaX = viaBadges(r.via);
    html = `<div class="mrow${inRange ? ' is-selected' : ''}" data-key="${escapeHtml(r.key)}" title="${escapeHtml(full)}"><span class="mt">${fmt(r.t)}</span>${who}${viaX}${tags}<span class="mx">${escapeHtml(text)}</span></div>`;
    if (!last) return html;

    // 選んだ範囲の最後の行の下に、操作のボタンを出す
    if (rg[1] > rg[0]) {
      const n = rg[1] - rg[0] + 1;
      return html + `<div class="macts">
        <span class="macts-note">${tr('{n} 行を選んでいます', { n })}</span>
        <button data-mact="cell" title="${tr('選んだ行の最初から最後までを1つのセルにする')}">${icon('cell')}${tr('セルにする')}</button>
        <span class="spacer"></span>
        <button data-mact="close" title="${tr('選択をやめる (Esc)')}" aria-label="${tr('閉じる')}">${icon('x')}</button>
      </div>`;
    }
    const lead = this.app.settings.leadIn;
    const tx = !r.id;
    html += `<div class="macts">
      <button data-mact="go" title="${tr('クリックで移動・ダブルクリックでそこから再生')}">${icon('play')}${tr('移動')}</button>
      <button data-mact="lead" title="${tr('{s}秒前へ移動・ダブルクリックでそこから再生', { s: lead })}">${icon('back')}${tr('{s}秒前から', { s: lead })}</button>
      <button data-mact="add"${this.adding ? ' class="on"' : ''} title="${tx ? tr('この時刻の目印にコメントする') : tr('この目印にコメントを追加する')}">${icon('comment')}${tr('コメント')}</button>
      <span class="spacer"></span>
      <button data-mact="close" title="${tr('閉じる (Esc)')}" aria-label="${tr('閉じる')}">${icon('x')}</button>
    </div>`;
    // 文字起こしの行は、2段目に行そのものの操作を出す
    if (tx) {
      html += `<div class="macts macts-2">
        <button data-mact="edit" title="${tr('この行の文字を直す')}">${icon('pencil')}${tr('編集')}</button>
        <button data-mact="word" title="${tr('この行の言葉を単語帳に入れる（先に行の中の言葉をドラッグで選んでおくと、その言葉が入ります）')}">${tr('単語帳')}</button>
        <button data-mact="del" title="${tr('この行を消す')}" aria-label="${tr('この行を消す')}">${icon('trash')}</button>
        <span class="mtip" title="${tr('Shift を押しながら別の行をクリックすると、範囲を選んでセルにできます')}">${tr('Shift+クリックで範囲を選んでセルに')}</span>
      </div>`;
    }
    if (this.adding) {
      const where = r.id ? tr('{time} の目印にコメント', { time: fmt(r.t) }) : tr('{time} にコメント（目印ができます）', { time: fmt(r.t) });
      html += `<div class="madd"><input class="madd-input" type="text" placeholder="${where}${tr('（Enter で追加・Esc でやめる）')}" autocomplete="off"></div>`;
    }
    return html;
  }

  select(key, repaint = true) {
    this.sel = key;
    this.selEnd = null;
    this.adding = false;
    this.editing = null;
    if (repaint) this.paint();
  }

  selectedRow() {
    return this.rows.find((r) => r.key === this.sel) || null;
  }

  onClick(e) {
    const act = e.target.closest('[data-mact]')?.dataset.mact;
    const r = this.selectedRow();
    const { app } = this;
    if (act === 'go' || act === 'lead') {
      if (!r) return;
      const lead = act === 'lead';
      if (r.id) app.focusMarker(r.id, lead);
      else app.seek(lead ? app.leadTime(r.t) : r.t);
      app.noteJump(`list:${r.key}:${act}`); // ダブルクリックなら再生も始める
    } else if (act === 'add' && r) {
      this.adding = !this.adding;
      this.paint();
      this.body.querySelector('.madd-input')?.focus();
    } else if (act === 'edit' && r) {
      this.editing = r.key;
      this.adding = false;
      this.paint();
      const ta = this.body.querySelector('.medit');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    } else if (act === 'word' && r) {
      const inRow = this.selText && r.text.includes(this.selText) ? this.selText : '';
      app.openWordAdd({ word: inRow, context: r.text, t: r.t });
      this.selText = '';
    } else if (act === 'del' && r) {
      const key = r.cueId;
      this.clearSelection();
      app.deleteCue(key);
    } else if (act === 'cell') {
      const rg = this.range();
      if (!rg) return;
      const first = this.rows[rg[0]];
      const lastRow = this.rows[rg[1]];
      this.clearSelection();
      app.createCell(first.t, lastRow.e ?? lastRow.t + 2);
    } else if (act === 'close') {
      this.select(null);
    } else if (!act) {
      if (e.target.closest('.medit, .madd')) return;
      const row = e.target.closest('.mrow');
      if (!row) return;
      // 文字起こしでは Shift+クリックで範囲を選ぶ
      if (e.shiftKey && this.mode === 'transcript' && this.sel && row.dataset.key !== this.sel) {
        this.selEnd = row.dataset.key;
        this.adding = false;
        this.editing = null;
        window.getSelection?.().removeAllRanges();
        this.paint();
        return;
      }
      // 選んだ行の文字をドラッグで選んでいる最中は、選択を外さない（単語帳に入れる言葉を選ぶため）
      if (row.dataset.key === this.sel && String(window.getSelection?.() || '').trim()) return;
      this.select(row.dataset.key === this.sel && !this.selEnd ? null : row.dataset.key);
    }
  }

  saveEdit(ta) {
    const r = this.rows.find((x) => x.key === this.editing);
    this.editing = null;
    const text = ta.value.trim();
    if (r && text && text !== r.text) this.app.editCue(r.cueId, text);
    else this.paint();
  }

  onKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.target.classList.contains('medit')) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.editing = null;
        this.paint();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.saveEdit(e.target);
      }
      return;
    }
    if (!e.target.classList.contains('madd-input')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.adding = false;
      this.paint();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const r = this.selectedRow();
    const text = e.target.value.trim();
    if (!r || !text) return;
    e.target.value = '';
    this.adding = false;
    if (r.id && !r.sh) {
      this.app.store.addComment('marker', r.id, text, r.t);
      this.app.hint(tr('{time} の目印にコメントしました', { time: fmt(r.t, true) }));
    } else {
      // 文字起こしの行: その時刻の目印（近くにあればそれ）にコメントする
      this.app.commentAt(text, { markerId: null, t: r.t, fromTarget: false });
    }
  }

  tick(now) {
    if (!this.rows.length || !this.app.settings.momentListOpen) return;
    // いまの位置までで一番新しい行
    let lo = 0;
    let hi = this.rows.length - 1;
    let cur = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid].t <= now + 0.05) {
        cur = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (cur === this.cur) return;
    this.cur = cur;
    const els = this.body.querySelectorAll('.mrow');
    for (let i = 0; i < els.length; i++) {
      els[i].classList.toggle('is-cur', i === cur);
      els[i].classList.toggle('is-future', i > cur);
    }
    // 行を選んでいる間や、手でスクロールした直後は追いかけない
    if (!this.app.settings.momentListSync || this.sel || performance.now() < this.pauseUntil) return;
    // いまの行が下から少し上に来るようにスクロールする
    const el = els[Math.max(cur, 0)];
    if (!el) return;
    const target = cur < 0 ? 0 : el.offsetTop - this.body.clientHeight * 0.65;
    this.body.scrollTop = Math.max(0, target);
  }
}
