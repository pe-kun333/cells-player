import { $, fmt, escapeHtml, icon, round2 } from './util.js';
import { saveSettings } from './store.js';
import { tr, locale } from './i18n.js';

// ライブ配信（YouTube）。
// ライブ中: 「ライブ」ボタン（最新の場面からどれだけ遅れているかを出し、押すと最新へ戻る）。
//   付けた目印・セル・字幕の行には fromLive が付く（store）。
// 配信が終わってアーカイブになったら: ライブ中の記録の時刻がアーカイブとずれていないかを確かめ、
//   ずれていれば、ライブ中に付けた目印を1つ選んでアーカイブの同じ場面に合わせると、全体（またはそれより後ろ）がずれる
// ライブチャット: YouTube が用意しているチャットの埋め込み（live_chat?v=…&embed_domain=…）を左の列に出す。
//   書き込みは YouTube の画面の中で、その人の YouTube アカウントで行われ、このアプリは中身を受け取らない
export class Broadcast {
  constructor(app) {
    this.app = app;
    this.edgeBtn = $('#btnLiveEdge');
    this.syncBtn = $('#btnLiveSync');
    this.card = $('#liveSyncCard');
    this.edgeBtn.addEventListener('click', () => this.goLive());
    this.syncBtn.addEventListener('click', () => this.toggleCard());
    this.card.addEventListener('click', (e) => this.onCardClick(e));
    this.chatCol = $('#chatCol');
    this.chatFrame = $('#chatFrame');
    this.chatBtn = $('#btnLiveChat');
    this.chatBtn.addEventListener('click', () => this.setChat(!this.chatOpen, true));
    $('#btnChatClose').addEventListener('click', () => this.setChat(false, true));
    $('#btnChatReload').addEventListener('click', () => this.loadChat());
    $('#btnChatPopout').addEventListener('click', () => this.popoutChat());
    this.reset();
  }

  get store() {
    return this.app.store;
  }

  // メディアを閉じた・開き直したとき
  reset() {
    this.wasLive = false;
    this.sawLive = false;     // この回にライブとして再生したか
    this.announced = false;
    this.archiveSeen = false; // アーカイブ（ライブではない）と分かったか
    this.records = false;     // ライブ中の記録があるか（アーカイブと分かったときに数える）
    this.cardOpen = false;
    this.pickId = null;       // 合わせるのに使う、ライブ中に付けた目印
    this.edgeKey = '';
    this.statusKey = '';
    this.edgeBtn.hidden = true;
    this.syncBtn.hidden = true;
    this.chatBtn.hidden = true;
    this.chatAuto = false;    // この回に、設定に合わせてチャットを開いたか
    this.setChat(false);
    this.render();
  }

  // ライブ中の記録があって、まだ確かめていないか
  needsCheck() {
    const doc = this.store.doc;
    if (!doc?.live || doc.live.checked) return false;
    const n = this.store.liveCounts();
    return n.markers + n.cells + n.cues > 0;
  }

  hasRecords() {
    const n = this.store.liveCounts();
    return n.markers + n.cells + n.cues > 0;
  }

  // main の監視から呼ぶ
  tick(now) {
    const p = this.app.player;
    const doc = this.store.doc;
    if (!p || !doc) return;
    const live = p.isLive();
    if (live) {
      this.sawLive = true;
      if (p.liveBase !== null && (!doc.live || Math.abs(doc.live.base - p.liveBase) > 1)) this.store.markLive(p.liveBase);
      // ライブと分かったら、設定に合わせてチャットを開く（その回に一度だけ）
      if (!this.chatAuto) {
        this.chatAuto = true;
        if (this.app.settings.liveChat) this.setChat(true);
      }
      if (!this.announced && p.liveBase !== null) {
        this.announced = true;
        this.app.hint(tr('ライブ配信です。付けた目印・セル・コメントは、配信が終わってアーカイブになったあとも、同じ URL で開けば使えます'), true);
      }
    } else if (this.wasLive) {
      this.app.hint(tr('ライブ配信が終わりました。アーカイブが公開されたら、同じ URL で開くと目印を見返せます（時刻がずれていたら合わせられます）'), true);
    }
    this.wasLive = live;

    // アーカイブと分かったら、ライブ中の記録を確かめる案内を出す（同じ回にライブで見ていたときは出さない）
    if (!live && p.liveKnown && doc.live && !this.archiveSeen && !this.sawLive) {
      this.archiveSeen = true;
      this.records = this.hasRecords();
      if (this.needsCheck()) {
        this.cardOpen = true;
        this.render();
      }
    }

    this.updateButtons(now, live);
    if (this.cardOpen) this.updateStatus(now);
  }

  updateButtons(now, live) {
    const p = this.app.player;
    this.syncBtn.hidden = live || !this.archiveSeen || !this.store.doc?.live || !this.records;
    this.syncBtn.classList.toggle('on', this.cardOpen);
    this.edgeBtn.hidden = !live;
    // チャットのボタンは、この回にライブとして見ていたあいだ出す（配信が終わっても、閉じるまでは残す）
    this.chatBtn.hidden = !this.sawLive;
    if (!live) return;
    const edge = p.liveEdge();
    const behind = edge ? Math.max(0, edge - now) : 0;
    const atEdge = behind < 5;
    const key = atEdge ? 'edge' : fmt(behind);
    if (key === this.edgeKey) return;
    this.edgeKey = key;
    this.edgeBtn.classList.toggle('is-edge', atEdge);
    this.edgeBtn.querySelector('span').textContent = atEdge ? tr('ライブ') : tr('ライブ −{time}', { time: fmt(behind) });
    this.edgeBtn.title = atEdge
      ? tr('ライブの最新の場面を再生しています')
      : tr('最新の場面より {time} 遅れています。クリックで最新へ', { time: fmt(behind) });
  }

  // 目印が対象になったとき（main の setTarget から呼ぶ）。
  // ライブ中に付けた目印なら、合わせるのに使う目印として覚えておく
  // （対象は、アーカイブで場面を探して離れると外れてしまうので、ここで別に持つ）
  notePick(id) {
    if (!this.cardOpen || id === this.pickId || !this.store.getMarker(id)?.fromLive) return;
    this.pickId = id;
    this.statusKey = '';
  }

  // ---- ライブチャット ----

  videoId() {
    const id = this.store.doc?.id || '';
    return /^yt:[\w-]{11}$/.test(id) ? id.slice(3) : null;
  }

  // byUser: ボタンで切り替えたとき（次のライブ配信でも同じにするため、設定に覚える）
  setChat(open, byUser = false) {
    const id = open ? this.videoId() : null;
    this.chatOpen = !!id;
    if (byUser) {
      this.app.settings.liveChat = this.chatOpen;
      saveSettings(this.app.settings);
    }
    this.chatCol.hidden = !this.chatOpen;
    document.body.classList.toggle('has-chat', this.chatOpen);
    this.chatBtn.classList.toggle('on', this.chatOpen);
    if (!this.chatOpen) {
      this.chatFrame.innerHTML = '';
      this.chatId = null;
      return;
    }
    if (this.chatId !== id) this.loadChat();
  }

  // 設定を保存したとき（main から呼ぶ）
  applyChatSetting() {
    if (!this.sawLive) return;
    if (this.app.settings.liveChat !== this.chatOpen) this.setChat(this.app.settings.liveChat);
  }

  loadChat() {
    const id = this.videoId();
    if (!id) return;
    this.chatId = id;
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const f = document.createElement('iframe');
    f.src = `https://www.youtube.com/live_chat?v=${id}&embed_domain=${encodeURIComponent(location.hostname)}${dark ? '&dark_theme=1' : ''}`;
    f.title = tr('YouTube のライブチャット');
    this.chatFrame.replaceChildren(f);
  }

  // 埋め込みで出ないときや、書き込めないとき（ブラウザがログイン情報を渡さない設定など）は、YouTube の別ウィンドウで
  popoutChat() {
    const id = this.videoId();
    if (!id) return;
    const w = window.open(`https://www.youtube.com/live_chat?is_popout=1&v=${id}`, 'cellsplayer-chat', 'popup,width=420,height=720');
    if (w) w.opener = null;
  }

  goLive() {
    const p = this.app.player;
    if (!p?.isLive()) return;
    p.seekLive();
    this.app.hint(tr('ライブの最新の場面に戻りました'));
  }

  toggleCard() {
    this.cardOpen = !this.cardOpen;
    this.render();
  }

  render() {
    const card = this.card;
    const doc = this.store.doc;
    card.hidden = !this.cardOpen || !doc?.live;
    this.syncBtn.classList.toggle('on', this.cardOpen);
    if (card.hidden) {
      card.innerHTML = '';
      return;
    }
    // 開く前にライブ中の目印を選んでいたら、それを使う
    if (!this.pickId && this.app.ui.target) this.notePick(this.app.ui.target.id);
    const n = this.store.liveCounts();
    const counts = [
      n.markers ? tr('目印 {n}', { n: n.markers }) : '',
      n.cells ? tr('セル {n}', { n: n.cells }) : '',
      n.cues ? tr('字幕 {n} 行', { n: n.cues }) : '',
    ].filter(Boolean).join(tr('・'));
    const started = doc.live.base
      ? tr('配信の開始: {date}', {
        date: new Date(doc.live.base * 1000).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      })
      : '';
    card.innerHTML = `
      <div class="ls-head">
        <span class="ls-title">${icon('pin')}${tr('ライブ中に付けた記録をアーカイブに合わせる')}</span>
        <span class="ls-count">${escapeHtml(counts)}</span>
        <span class="spacer"></span>
        <button class="btn tiny" data-ls="close" title="${tr('閉じる（あとで「ライブの記録を合わせる」から開けます）')}" aria-label="${tr('閉じる')}">${icon('x')}</button>
      </div>
      <p class="ls-lead">${tr('アーカイブで冒頭や途中がカットされていると、ライブ中に付けた目印の時刻がずれます。ずれていたら、次の順に合わせてください。')}</p>
      <ol class="ls-steps">
        <li>${tr('ライブ中に付けた目印をクリックして選ぶ')}</li>
        <li>${tr('アーカイブでその場面まで移動する')}</li>
        <li>${tr('「すべて合わせる」を押す（途中がカットされていたときは、カットの後ろの目印で「ここから後ろだけ」）')}</li>
      </ol>
      <div class="ls-status"></div>
      <div class="ls-actions">
        <button class="btn small primary" data-ls="all" title="${tr('ライブ中に付けた記録を、すべて同じだけずらす')}">${tr('すべて合わせる')}</button>
        <button class="btn small" data-ls="after" title="${tr('選んだ目印と、それより後ろにあるライブ中の記録だけをずらす')}">${tr('ここから後ろだけ')}</button>
        <span class="ls-sep"></span>
        <button class="btn small" data-ls="nudge" data-d="-1" title="${tr('ライブ中の記録を、すべて 1 秒前へ')}">${tr('全部 −1秒')}</button>
        <button class="btn small" data-ls="nudge" data-d="1" title="${tr('ライブ中の記録を、すべて 1 秒後ろへ')}">${tr('全部 +1秒')}</button>
        <span class="spacer"></span>
        <button class="btn small" data-ls="done" title="${tr('この案内を出さないようにする')}">${tr('ずれていない（完了）')}</button>
      </div>
      ${started ? `<div class="ls-note">${escapeHtml(started)}</div>` : ''}`;
    this.statusKey = '';
    this.updateStatus(this.app.now());
  }

  pick() {
    const m = this.pickId && this.store.getMarker(this.pickId);
    return m && m.fromLive ? m : null;
  }

  updateStatus(now) {
    const el = this.card.querySelector('.ls-status');
    if (!el) return;
    const m = this.pick();
    const d = m ? round2(now - m.t) : 0;
    const key = m ? `${m.id}:${m.t}:${d}` : '-';
    if (key === this.statusKey) return;
    this.statusKey = key;
    if (!m) {
      el.innerHTML = `<span class="muted">${tr('まだ目印を選んでいません（タイムラインや右の一覧で、ライブ中に付けた目印をクリック）')}</span>`;
      return;
    }
    const label = m.comments[0]?.text || m.tags.join(tr('・'));
    el.innerHTML = tr('選んだ目印 {mark} → いまの位置 {now}（{delta}）', {
      mark: `<b>${fmt(m.t, true)}</b>${label ? ` <span class="muted">${escapeHtml(label.slice(0, 24))}</span>` : ''}`,
      now: `<b>${fmt(now, true)}</b>`,
      delta: `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(1)}${tr('秒')}`,
    });
  }

  onCardClick(e) {
    const b = e.target.closest('[data-ls]');
    if (!b) return;
    const a = b.dataset.ls;
    const { app, store } = this;
    if (a === 'close') {
      this.cardOpen = false;
      this.render();
    } else if (a === 'done') {
      store.setLiveChecked(true);
      this.cardOpen = false;
      this.render();
      app.hint(tr('ライブ中の記録を確かめました。あとで直したいときは「ライブの記録を合わせる」から開けます'));
    } else if (a === 'nudge') {
      this.shift(Number(b.dataset.d));
    } else if (a === 'all' || a === 'after') {
      const m = this.pick();
      if (!m) {
        app.hint(tr('先に、ライブ中に付けた目印をクリックして選んでください'));
        return;
      }
      const delta = round2(app.now() - m.t);
      if (Math.abs(delta) < 0.05) {
        app.hint(tr('選んだ目印はいまの位置と同じです。アーカイブで同じ場面まで移動してから押してください'));
        return;
      }
      this.shift(delta, a === 'after' ? m.t : -Infinity);
    }
  }

  shift(delta, from = -Infinity) {
    const n = this.store.shiftLive(delta, from);
    const d = `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(1)}`;
    this.app.hint(
      Number.isFinite(from)
        ? tr('{time} から後ろのライブ中の記録 {n} 件を {d} 秒ずらしました（Ctrl+Z で戻せます）', { time: fmt(from), n, d })
        : tr('ライブ中の記録 {n} 件を {d} 秒ずらしました（Ctrl+Z で戻せます）', { n, d }),
    );
    this.render();
  }
}
