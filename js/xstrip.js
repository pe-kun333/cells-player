import { $, fmt, escapeHtml } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// ライブチャットの下の X の帯。
// 1行目: 動画ごとに登録したハッシュタグと「X で見る」（X のそのハッシュタグの最新の投稿を、画面の左端に縦長の別ウィンドウで開く）
// 2行目: X に書く欄と「X に投稿」（ハッシュタグ入りの X の投稿画面を開く。投稿するかどうかは X の画面で本人が決める）。
//   書いた内容は、書き始めた時刻の「瞬間のコメント」としてアプリにも残す（X に投稿した印 via: 'x' を付ける）。
// X のページはほかのサイトに埋め込めないので、投稿の一覧はアプリの中には出さない
const MAX_TAGS = 5;

// 「#ライブ ＃雑談, test」→ ['ライブ', '雑談', 'test']（X のハッシュタグに使えない記号は除く）
export function parseTags(text) {
  const out = [];
  for (const raw of String(text).split(/[\s,、，]+/)) {
    const t = raw.replace(/^[#＃]+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '').slice(0, 50);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

export class XStrip {
  constructor(app) {
    this.app = app;
    this.tagsEl = $('#xsTags');
    this.form = $('#xsForm');
    this.input = $('#xsInput');
    this.pinEl = $('#xsPin');
    this.linkBtn = $('#xsLink');
    this.editing = false;
    this.pinT = null; // 書き始めた時刻（瞬間のコメントとして残す位置）
    this.key = '';

    this.tagsEl.addEventListener('click', (e) => {
      const a = e.target.closest('[data-xs]')?.dataset.xs;
      if (a === 'edit') this.startEdit();
      else if (a === 'save') this.saveTags();
      else if (a === 'cancel') this.stopEdit();
      else if (a === 'view') this.view();
    });
    this.tagsEl.addEventListener('keydown', (e) => {
      if (!e.target.classList.contains('xs-tags-input') || e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.saveTags();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.stopEdit();
      }
    });
    this.input.addEventListener('input', () => {
      if (this.input.value.trim() && this.pinT === null) this.setPin(this.app.now());
      else if (!this.input.value.trim()) this.setPin(null);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        this.input.value = '';
        this.setPin(null);
        this.input.blur();
      }
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.post();
    });
    this.linkBtn.addEventListener('click', () => {
      app.settings.xLink = !app.settings.xLink;
      saveSettings(app.settings);
      this.renderLink();
    });
    this.renderLink();
  }

  get tags() {
    return this.app.store.doc?.xTags || [];
  }

  videoId() {
    const id = this.app.store.doc?.id || '';
    return /^yt:[\w-]{11}$/.test(id) ? id.slice(3) : null;
  }

  // ---- 1行目: ハッシュタグ ----

  render() {
    const docId = this.app.store.doc?.id || '';
    if (docId !== this.docId) {
      // 別の動画を開いたら、書きかけとハッシュタグの編集をやめる
      this.docId = docId;
      this.editing = false;
      this.input.value = '';
      this.setPin(null);
    }
    const tags = this.tags;
    const editing = this.editing || !tags.length;
    const key = `${docId}:${editing}:${tags.join(' ')}`;
    if (key === this.key) return;
    this.key = key;
    const label = `<span class="xs-label" aria-hidden="true">X</span>`;
    if (editing) {
      this.tagsEl.innerHTML = `${label}
        <input class="field xs-tags-input" type="text" autocomplete="off" spellcheck="false"
          value="${escapeHtml(tags.map((t) => '#' + t).join(' '))}"
          placeholder="${tr('#ハッシュタグ（空白で区切って5つまで）')}" aria-label="${tr('ハッシュタグ')}">
        <button type="button" class="btn tiny" data-xs="save">${tr('登録')}</button>
        ${tags.length ? `<button type="button" class="btn tiny" data-xs="cancel">${tr('キャンセル')}</button>` : ''}`;
      return;
    }
    const chips = tags.map((t) => `<span class="xs-chip">#${escapeHtml(t)}</span>`).join('');
    this.tagsEl.innerHTML = `${label}
      <span class="xs-chips" title="${escapeHtml(tr('クリックで変える'))}" data-xs="edit">${chips}</span>
      <span class="spacer"></span>
      <button type="button" class="btn tiny" data-xs="view" title="${tr('このハッシュタグの X の最新の投稿を、画面の左端に別のウィンドウで開く')}">${tr('X で見る')}</button>`;
  }

  startEdit() {
    this.editing = true;
    this.render();
    const inp = this.tagsEl.querySelector('.xs-tags-input');
    inp?.focus();
    inp?.setSelectionRange(inp.value.length, inp.value.length);
  }

  stopEdit() {
    this.editing = false;
    this.render();
  }

  saveTags() {
    const inp = this.tagsEl.querySelector('.xs-tags-input');
    if (!inp || !this.app.store.doc) return;
    const tags = parseTags(inp.value);
    this.editing = false;
    this.app.store.setXTags(tags);
    this.render();
    this.app.hint(
      tags.length
        ? tr('ハッシュタグ {tags} を登録しました（この動画で使います）', { tags: tags.map((t) => '#' + t).join(' ') })
        : tr('ハッシュタグを外しました'),
    );
  }

  // X の最新の投稿（ハッシュタグの検索）を、画面の左端に縦長の別ウィンドウで開く
  view() {
    const tags = this.tags;
    if (!tags.length) {
      this.startEdit();
      return;
    }
    const q = tags.map((t) => '#' + t).join(' OR ');
    const url = `https://x.com/search?q=${encodeURIComponent(q)}&f=live`;
    const s = window.screen;
    const h = s.availHeight || 900;
    const w = window.open(url, 'cellsplayer-x', `popup,left=${s.availLeft || 0},top=${s.availTop || 0},width=420,height=${h}`);
    if (w) w.opener = null;
  }

  // ---- 2行目: X に書く ----

  setPin(t) {
    this.pinT = t;
    this.pinEl.hidden = t === null;
    if (t !== null) {
      this.pinEl.textContent = fmt(t);
      this.pinEl.title = tr('{time} の瞬間のコメントとしても残ります', { time: fmt(t, true) });
    }
  }

  renderLink() {
    const on = !!this.app.settings.xLink;
    this.linkBtn.classList.toggle('on', on);
    this.linkBtn.setAttribute('aria-pressed', String(on));
  }

  post() {
    const { app } = this;
    if (!app.player || !app.store.doc) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    const text = this.input.value.trim();
    const tags = this.tags;
    if (!text && !tags.length) {
      app.hint(tr('X に書く内容か、ハッシュタグを入れてください'));
      this.input.focus();
      return;
    }
    const t = this.pinT ?? app.now();
    const id = this.videoId();
    let url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
    if (tags.length) url += `&hashtags=${encodeURIComponent(tags.join(','))}`;
    // その時刻の動画へのリンク（ライブ中の再生位置は、アーカイブの時刻とふつう同じ）
    if (app.settings.xLink && id) url += `&url=${encodeURIComponent(`https://youtu.be/${id}?t=${Math.floor(t)}`)}`;
    window.open(url, '_blank', 'noopener');
    this.input.value = '';
    this.setPin(null);
    if (text) {
      const m = app.commentAt(text, { markerId: null, t, fromTarget: false }, { via: 'x' });
      if (m) app.hint(tr('X の投稿画面を開きました（投稿は X の画面で）。書いた内容は {time} の瞬間のコメントにも残しました', { time: fmt(m.t, true) }));
    } else {
      app.hint(tr('X の投稿画面を開きました（投稿は X の画面で）'));
    }
  }
}
