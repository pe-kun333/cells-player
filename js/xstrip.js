import { $, fmt, escapeHtml } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// ライブチャットの下の帯（チャットと X に書く）。
// 1行目: 動画ごとに登録したハッシュタグと「X で見る」（X のそのハッシュタグの最新の投稿を、画面の左端に縦長の別ウィンドウで開く）
// 2・3行目: 共通の書く欄と送り先のボタン
//   チャット用にコピー: 文をコピーする（埋め込んだ YouTube のチャットには、ブラウザの安全の仕組みでアプリから書き込めないため、
//               チャットの入力欄をクリックして貼り付けてもらう）
//   X へ:      ハッシュタグ入りの X の投稿画面を開く（投稿するかどうかは X の画面で本人が決める）
//   両方:      その両方
//   書いた内容は、書き始めた時刻の「瞬間のコメント」としてアプリにも残し、送った先の印（via）を付ける。
//   Enter は、最後に使った送り先で送る
// X のページはほかのサイトに埋め込めないので、投稿の一覧はアプリの中には出さない
const MAX_TAGS = 5;
const SEND_LABELS = { chat: 'チャット用にコピー', x: 'X へ', both: '両方' };

// クリップボードにコピーする（使えないときは古い方法で）
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  return ok;
}

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
    this.sendBtns = [...this.form.querySelectorAll('[data-send]')];
    this.chatFrame = $('#chatFrame');
    this.noteEl = $('#xsNote');
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
      this.showNote('');
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
      this.send(this.sendTo);
    });
    for (const b of this.sendBtns) b.addEventListener('click', () => this.send(b.dataset.send));
    this.linkBtn.addEventListener('click', () => {
      app.settings.xLink = !app.settings.xLink;
      saveSettings(app.settings);
      this.renderLink();
    });
    this.renderLink();
    this.renderSend();
  }

  // Enter で送る先（最後に使った送り先）
  get sendTo() {
    const s = this.app.settings.sendTo;
    return s === 'x' || s === 'both' ? s : 'chat';
  }

  renderSend() {
    const to = this.sendTo;
    for (const b of this.sendBtns) b.classList.toggle('primary', b.dataset.send === to);
    this.input.placeholder = tr('書く（Enter で「{dest}」）', { dest: tr(SEND_LABELS[to]) });
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

  // dest: 'chat'（コピーして貼ってもらう）/ 'x'（X の投稿画面を開く）/ 'both'
  async send(dest) {
    const { app } = this;
    if (!app.player || !app.store.doc) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    const text = this.input.value.trim();
    const tags = this.tags;
    const toChat = dest !== 'x';
    const toX = dest !== 'chat';
    // X へはハッシュタグだけでも送れる。チャット用には書いた文が要る
    if (!text && (toChat || !tags.length)) {
      app.hint(toChat ? tr('先に書く欄に書いてください') : tr('X に書く内容か、ハッシュタグを入れてください'));
      this.input.focus();
      return;
    }
    if (app.settings.sendTo !== dest) {
      app.settings.sendTo = dest;
      saveSettings(app.settings);
      this.renderSend();
    }
    const t = this.pinT ?? app.now();
    // 先にコピーしてから X の画面を開く（開くと、このページが選ばれていない状態になりコピーできないため）
    const copied = toChat ? await copyText(text) : false;
    if (toX) this.openX(text, tags, t);
    this.input.value = '';
    this.setPin(null);
    const m = text ? app.commentAt(text, { markerId: null, t, fromTarget: false }, { via: toChat && toX ? 'chat+x' : toChat ? 'chat' : 'x' }) : null;
    const saved = m ? tr('（{time} の瞬間のコメントにも残しました）', { time: fmt(m.t, true) }) : '';
    if (toChat) {
      // 案内は、チャットの入力欄のすぐ下（帯の一番上）に出す
      this.flashChat();
      if (!copied) {
        this.showNote(tr('コピーできませんでした。上のチャットの入力欄に直接書いてください'), true);
      } else {
        this.showNote(tr('コピーしました。↑ チャットの入力欄をクリック → Ctrl+V → Enter で送信'));
        if (toX) app.hint(tr('X の投稿画面も開きました（投稿は X の画面で）') + saved);
        else if (m) app.hint(tr('{time} の瞬間のコメントにも残しました', { time: fmt(m.t, true) }));
      }
    } else {
      app.hint(tr('X の投稿画面を開きました（投稿は X の画面で）') + saved);
    }
  }

  // ハッシュタグ入りの X の投稿画面を、アプリが隠れないよう小さな別ウィンドウで開く
  openX(text, tags, t) {
    const id = this.videoId();
    let url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`;
    if (tags.length) url += `&hashtags=${encodeURIComponent(tags.join(','))}`;
    // その時刻の動画へのリンク（ライブ中の再生位置は、アーカイブの時刻とふつう同じ）
    if (this.app.settings.xLink && id) url += `&url=${encodeURIComponent(`https://youtu.be/${id}?t=${Math.floor(t)}`)}`;
    const w = window.open(url, 'cellsplayer-xpost', 'popup,width=600,height=520');
    if (w) w.opener = null;
  }

  // 帯の一番上の案内（空文字で消す）
  showNote(msg, isError = false) {
    clearTimeout(this.noteTimer);
    this.noteEl.hidden = !msg;
    this.noteEl.textContent = msg;
    this.noteEl.classList.toggle('is-error', isError);
    if (msg) this.noteTimer = setTimeout(() => this.showNote(''), 15000);
  }

  // 貼り付ける先（チャット欄）を少しのあいだ目立たせる
  flashChat() {
    this.chatFrame.classList.add('is-paste');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.chatFrame.classList.remove('is-paste'), 2500);
  }
}
