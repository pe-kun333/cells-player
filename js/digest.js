import { $, fmt, icon, escapeHtml, cellLabel } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// 連続再生: 区切り（セル・目印）を順に続けて再生する。使い方は2つ
// ・一覧（ダイジェスト）: サイドバーにいま並んでいるセル・目印を、上から順に（いまのメディアの中だけ）
// ・プレイリスト: ライブラリで作ったリスト。区切りごとにメディアが違ってよく、YouTube・URL のメディアは自動で開く。
//   手元のファイルはブラウザから勝手に開けないので、そこで止まって開いてもらう
// セルはその区間を、目印は「少し前から」〜設定の秒数あと までを1つの区切りとして再生する
export class Digest {
  constructor(app) {
    this.app = app;
    this.clips = [];
    this.i = -1;
    this.active = false;
    this.mode = 'list';   // 'list'（一覧）か 'playlist'
    this.wait = false;    // プレイリストで、次のメディアが開くのを待っている
    this.fails = 0;       // 続けて開けなかったメディアの数
    this.lastT = 0;
    this.settleUntil = 0; // 自分で移動した直後は「手で動かした」と判定しない
    this.arriveBy = 0;    // 別のメディアを開いた直後: 区切りの位置に着くまで待つ期限（広告などで遅れることがある）
    this.reseekAt = 0;
    this.stallAt = 0;     // 開いたメディアの再生が始まらないときに案内を出す時刻
    this.stalled = false; // その案内を出している
    this.startBtn = $('#btnDigest');
    this.bar = $('#digestBar');
    this.startBtn.addEventListener('click', () => this.start());
    this.bar.addEventListener('click', (e) => {
      const a = e.target.closest('[data-dg]')?.dataset.dg;
      if (a === 'prev') this.go(this.i - 1, true);
      else if (a === 'next') this.go(this.i + 1, true);
      else if (a === 'loop') this.toggleLoop();
      else if (a === 'file') $('#fileInput').click();
      else if (a === 'list') this.app.openLibrary();
      else if (a === 'stop') this.stop(this.mode === 'playlist' ? tr('プレイリストの再生をやめました') : tr('連続再生をやめました'));
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
    if (this.active) this.stop();
    this.mode = 'list';
    this.clips = clips;
    this.active = true;
    this.go(0, true);
    app.player.play();
    app.hint(tr('{n} 件を続けて再生します', { n: clips.length }));
  }

  // プレイリストを i 番目から再生する（clips には mediaId・source・url・title が付く）
  startPlaylist(clips, i = 0) {
    const { app } = this;
    if (!clips.length) return;
    app.stopModes('digest');
    if (this.active) this.stop();
    this.mode = 'playlist';
    this.clips = clips;
    this.active = true;
    this.fails = 0;
    this.resolve();
    app.hint(tr('プレイリストの {n} 件を続けて再生します', { n: clips.length }));
    this.go(i, true);
    if (this.active && !this.wait) app.player?.play();
  }

  // i 番目の区切りへ。force: 前へ・次へボタンなどで、再生位置が近くても必ず頭から
  go(i, force = false) {
    if (!this.active) return;
    const { app } = this;
    if (i < 0) i = 0;
    if (i >= this.clips.length) {
      if (!app.settings.digestLoop) {
        app.player?.pause();
        this.stop(this.mode === 'playlist' ? tr('プレイリストの再生が終わりました') : tr('連続再生が終わりました'));
        return;
      }
      i = 0;
    }
    this.i = i;
    const c = this.clips[i];
    app.ui.digestId = c.id;
    this.arriveBy = 0;
    this.stallAt = 0;
    if (this.stalled) {
      this.stalled = false;
      app.hint('');
    }
    // プレイリストで別のメディアの区切り: そのメディアを開いてから続ける（開き終わると onMediaOpened）
    if (c.mediaId && c.mediaId !== app.store.doc?.id) {
      this.wait = true;
      this.render();
      app.onDigestClip(null);
      if (c.source === 'local') {
        app.player?.pause();
        const msg = tr('次は手元のファイル「{title}」です。「ファイルを開く」から同じファイルを開くと続きを再生します（飛ばすときは「次へ」）', { title: c.title });
        if (app.player) app.hint(msg, true);
        else app.toast(msg);
      } else if (c.url) {
        app.openMediaUrl(c.url);
      } else {
        this.onMediaOpened(false);
      }
      return;
    }
    if (this.wait) {
      this.wait = false;
      app.hint(''); // 手元のファイルを待っていたときの案内を消す
    }
    // 前の区切りの終わりと次の頭がつながっているときは、音が途切れないよう移動しない
    if (force || Math.abs(app.now() - c.s) > 0.15) app.seek(c.s);
    this.lastT = c.s;
    this.settleUntil = performance.now() + 500;
    this.render();
    app.onDigestClip(c.id);
  }

  // main.js でメディアを開き終えた（ok）・開けなかったとき
  onMediaOpened(ok) {
    if (!this.active || !this.wait) return;
    const { app } = this;
    const c = this.clips[this.i];
    this.wait = false;
    if (!ok) {
      this.skipBroken(c);
      return;
    }
    if (app.store.doc?.id !== c.mediaId) {
      this.stop(tr('別のメディアを開いたので、プレイリストの再生をやめました'));
      return;
    }
    this.fails = 0;
    this.resolve();
    this.go(this.i, true);
    this.arriveBy = performance.now() + 60000;
    this.reseekAt = performance.now() + 3000;
    this.stallAt = performance.now() + 10000;
    app.player.play();
    app.hint(tr('プレイリスト {i} / {n}：{title}', { i: this.i + 1, n: this.clips.length, title: c.title }));
  }

  // 開いたあとで YouTube がエラーを出した（埋め込みが許可されていない動画など）: 区切りに着く前なら飛ばす
  onPlayerError() {
    if (!this.active || this.mode !== 'playlist' || this.wait || !this.arriveBy) return;
    this.skipBroken(this.clips[this.i]);
  }

  // 開けなかった・再生できないメディア: そのメディアの区切りをまとめて飛ばして次へ（どれも開けなければやめる）
  skipBroken(c) {
    if (++this.fails >= this.clips.length) {
      this.stop(tr('プレイリストの動画を開けなかったので、再生をやめました'));
      return;
    }
    this.app.hint(tr('「{title}」を開けなかったので、次へ進みます', { title: c.title }));
    let j = this.i + 1;
    while (j < this.clips.length && this.clips[j].mediaId === c.mediaId) j++;
    this.go(j, true);
  }

  // いま開いているメディアの区切りを、元のセル・目印の今の範囲に合わせる（プレイリストに入れたあとで直していることがある）
  resolve() {
    const { app } = this;
    const doc = app.store.doc;
    if (this.mode !== 'playlist' || !doc) return;
    const dur = app.duration() || Infinity;
    for (const c of this.clips) {
      if (c.mediaId !== doc.id) continue;
      if (c.kind === 'cell') {
        const x = app.store.getCell(c.id);
        if (x) {
          c.s = x.s;
          c.e = x.e;
        }
        continue;
      }
      const m = app.store.getMarker(c.id);
      const t = m ? m.t : c.t;
      c.s = app.leadTime(t);
      c.e = Math.min(dur, t + app.settings.momentClip);
    }
  }

  stop(message) {
    this.active = false;
    this.clips = [];
    this.i = -1;
    this.wait = false;
    this.arriveBy = 0;
    this.stallAt = 0;
    this.stalled = false;
    this.mode = 'list';
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
    // 開いたメディアの再生が始まらない（動画によっては止まったままになる）ときは、どうすればよいかを出す
    if (this.stallAt && (playing || !this.active)) this.stallAt = 0;
    if (this.stallAt && performance.now() > this.stallAt) {
      this.stallAt = 0;
      this.stalled = true;
      const c = this.clips[this.i];
      this.app.hint(tr('「{title}」の再生が始まりません。▶（Space）で再生するか、「次へ」で飛ばせます', { title: c?.title || '' }), true);
    }
    if (this.stalled && playing) {
      this.stalled = false;
      this.app.hint('');
    }
    if (!this.active || this.wait || !playing) {
      this.lastT = now;
      return;
    }
    const c = this.clips[this.i];
    if (!c) return;
    if (performance.now() < this.settleUntil) {
      this.lastT = now;
      return;
    }
    // 別のメディアを開いた直後は、区切りの位置に着くまで待つ（広告のあとに頭から始まったときは、もう一度移動する）
    if (this.arriveBy) {
      if (now >= c.s - 1 && now <= c.e + 1) this.arriveBy = 0;
      else if (performance.now() < this.arriveBy) {
        if (performance.now() > this.reseekAt) {
          this.app.seek(c.s);
          this.reseekAt = performance.now() + 3000;
        }
        this.lastT = now;
        return;
      } else this.arriveBy = 0;
    }
    if (this.lastT < c.e && now >= c.e - 0.03 && now < c.e + 1) {
      this.go(this.i + 1);
      return;
    }
    // 手で別の場所へ動かしたとき: そこを含む区切り（いまのメディアの中）があればそこから続け、なければやめる
    if (now < c.s - 1 || now > c.e + 1) {
      const here = this.app.store.doc?.id;
      const j = this.clips.findIndex((x) => (!x.mediaId || x.mediaId === here) && now >= x.s && now < x.e);
      if (j >= 0) {
        this.i = j;
        this.app.ui.digestId = this.clips[j].id;
        this.render();
        this.app.onDigestClip(this.clips[j].id);
      } else {
        this.stop(
          this.mode === 'playlist'
            ? tr('区切りの外へ移動したので、プレイリストの再生をやめました')
            : tr('区切りの外へ移動したので、連続再生をやめました'),
        );
      }
    }
    this.lastT = now;
  }

  // 最後の区切りが動画の終わりまでだったとき（ended）
  onEnded() {
    if (!this.active) return false;
    this.go(this.i + 1, true);
    if (this.active && !this.wait) this.app.player.play();
    return true;
  }

  // いまの区切りの説明（プレイリストでは、メディアの題名も付ける）
  labelOf(c) {
    if (!c) return '';
    if (this.mode !== 'playlist') return c.label;
    if (this.wait) {
      return c.source === 'local'
        ? tr('手元のファイル「{title}」を開くと続きを再生します', { title: c.title })
        : tr('「{title}」を開いています…', { title: c.title });
    }
    return `${c.title}　${fmt(c.s)} – ${fmt(c.e)}  ${c.text || ''}`;
  }

  render() {
    const on = this.active;
    this.startBtn.hidden = on;
    this.bar.hidden = !on;
    if (!on) return;
    const c = this.clips[this.i];
    const pl = this.mode === 'playlist';
    const loop = this.app.settings.digestLoop;
    const label = escapeHtml(this.labelOf(c));
    const state = pl ? tr('プレイリスト {i} / {n}', { i: this.i + 1, n: this.clips.length }) : tr('連続再生 {i} / {n}', { i: this.i + 1, n: this.clips.length });
    this.bar.innerHTML = `
      <span class="dg-state">${icon(pl ? 'list' : 'play')}${state}</span>
      <span class="dg-label" title="${label}">${label}</span>
      ${pl && this.wait && c?.source === 'local' ? `<button data-dg="file" class="on" title="${tr('手元のファイルを開く')}">${icon('file')}${tr('ファイルを開く')}</button>` : ''}
      <button data-dg="prev" title="${tr('前へ')}" aria-label="${tr('前へ')}">${icon('back')}</button>
      <button data-dg="next" title="${tr('次へ')}" aria-label="${tr('次へ')}">${icon('next')}</button>
      <button data-dg="loop" class="${loop ? 'on' : ''}" title="${tr('最後まで行ったら最初から繰り返す')}" aria-label="${tr('繰り返し')}" aria-pressed="${loop}">${icon('repeat')}</button>
      ${pl ? `<button data-dg="list" title="${tr('プレイリストを見る（ライブラリ）')}" aria-label="${tr('プレイリストを見る（ライブラリ）')}">${icon('list')}</button>` : ''}
      <button data-dg="stop" title="${pl ? tr('プレイリストの再生をやめる') : tr('連続再生をやめる')}">${icon('x')}${tr('停止')}</button>`;
  }
}
