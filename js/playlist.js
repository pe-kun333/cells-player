import { $, fmt, fmtLen, uid, escapeHtml, icon, cellLabel } from './util.js';
import { tr } from './i18n.js';

// プレイリスト: すべてのメディアのセル・目印を好きな順に並べて、動画をまたいで続けて再生する。
// 1件は元のセル・目印を指し（mediaId + ref）、範囲・メモ・題名の写しも持つ（元が消えても、写しの範囲で再生できる）。
// 並べ替え・再生はライブラリの右側で行い、再生そのものは連続再生（digest.js）が受け持つ。
// YouTube・URL のメディアは自動で開き、手元のファイルはそこで止まって開いてもらう

const cellText = (c) => cellLabel(c, 60) || (c.comments?.[0]?.text || '').slice(0, 60);
const markerText = (m) => [(m.tags || []).join(tr('・')), m.comments?.[0]?.text].filter(Boolean).join('　').slice(0, 80);

export class Playlist {
  constructor(app) {
    this.app = app;
    this.dialog = $('#libraryDialog');
    this.panel = $('#plPanel');
    this.dragFrom = -1;
    this.panel.addEventListener('click', (e) => this.onClick(e));
    this.panel.addEventListener('keydown', (e) => this.onKeydown(e));
    this.panel.addEventListener('dragstart', (e) => this.onDragStart(e));
    this.panel.addEventListener('dragover', (e) => this.onDragOver(e));
    this.panel.addEventListener('drop', (e) => this.onDrop(e));
    this.panel.addEventListener('dragend', () => this.endDrag());
  }

  get items() {
    return this.app.store.playlist.items;
  }

  save() {
    this.app.store.savePlaylists();
  }

  indexOf(mediaId, ref) {
    return this.items.findIndex((x) => x.mediaId === mediaId && x.ref === ref);
  }

  has(mediaId, ref) {
    return this.indexOf(mediaId, ref) >= 0;
  }

  // doc のセル・目印 o から1件を作る
  makeItem(doc, kind, o) {
    const base = {
      id: uid(),
      mediaId: doc.id,
      title: doc.title || '',
      source: doc.source || 'local',
      url: doc.source !== 'local' ? doc.url || '' : '',
      kind,
      ref: o.id,
      at: Date.now(),
    };
    return kind === 'cell' ? { ...base, s: o.s, e: o.e, label: cellText(o) } : { ...base, t: o.t, label: markerText(o) };
  }

  // まだ入っていないものだけを最後に足す（足した数を返す）
  add(list) {
    let n = 0;
    for (const { doc, kind, o } of list) {
      if (this.has(doc.id, o.id)) continue;
      this.items.push(this.makeItem(doc, kind, o));
      n++;
    }
    if (n) this.save();
    return n;
  }

  // 入っていなければ入れ、入っていれば外す（入れたら true）
  toggle(doc, kind, o) {
    const i = this.indexOf(doc.id, o.id);
    if (i >= 0) {
      this.items.splice(i, 1);
      this.save();
      return false;
    }
    this.items.push(this.makeItem(doc, kind, o));
    this.save();
    return true;
  }

  move(from, to) {
    const items = this.items;
    if (from === to || from < 0 || from >= items.length) return;
    const [it] = items.splice(from, 1);
    items.splice(Math.max(0, Math.min(items.length, to)), 0, it);
    this.save();
  }

  // 同じメディアのものをまとめる（メディアの順は最初に出てきた順、メディアの中は時間順）。切り替えの回数が減る
  groupByMedia() {
    const order = [];
    const groups = new Map();
    for (const it of this.items) {
      if (!groups.has(it.mediaId)) {
        groups.set(it.mediaId, []);
        order.push(it.mediaId);
      }
      groups.get(it.mediaId).push(it);
    }
    const next = order.flatMap((id) => groups.get(id).sort((a, b) => this.range(a)[0] - this.range(b)[0]));
    this.items.splice(0, this.items.length, ...next);
    this.save();
  }

  // ライブラリを開いたとき: 元のセル・目印の今の範囲・メモと、メディアの題名に合わせる
  sync(docs) {
    const byId = new Map(docs.map((d) => [d.id, d]));
    let changed = false;
    const set = (it, k, v) => {
      if (v !== undefined && it[k] !== v) {
        it[k] = v;
        changed = true;
      }
    };
    for (const it of this.items) {
      const d = byId.get(it.mediaId);
      if (!d) continue;
      set(it, 'title', d.title || it.title);
      if (d.source !== 'local' && d.url) set(it, 'url', d.url);
      const o = (it.kind === 'cell' ? d.cells : d.markers).find((x) => x.id === it.ref);
      if (!o) {
        set(it, 'gone', true);
        continue;
      }
      if (it.gone) {
        delete it.gone;
        changed = true;
      }
      if (it.kind === 'cell') {
        set(it, 's', o.s);
        set(it, 'e', o.e);
        set(it, 'label', cellText(o));
      } else {
        set(it, 't', o.t);
        set(it, 'label', markerText(o));
      }
    }
    if (changed) this.save();
  }

  // 再生する範囲（目印は「少し前から」〜設定の秒数あと）
  range(it) {
    if (it.kind === 'cell') return [it.s, it.e];
    const { leadIn, momentClip } = this.app.settings;
    return [Math.max(0, it.t - leadIn), it.t + momentClip];
  }

  // 連続再生に渡す区切り（id は元のセル・目印の id。サイドバーのカードの強調に使う）
  clips() {
    return this.items.map((it) => {
      const [s, e] = this.range(it);
      return { id: it.ref, key: it.id, mediaId: it.mediaId, source: it.source, url: it.url, title: it.title, kind: it.kind, t: it.t, s, e, text: it.label };
    });
  }

  play(i = 0) {
    if (!this.items.length) return;
    this.dialog.close();
    this.app.startPlaylist(this.clips(), i);
  }

  // ---- ライブラリの右側 ----

  renderIfOpen() {
    if (this.dialog.open) this.render();
  }

  render() {
    const items = this.items;
    const total = items.reduce((sum, it) => {
      const [s, e] = this.range(it);
      return sum + Math.max(0, e - s);
    }, 0);
    const now = this.app.playlistNow();
    const none = items.length ? '' : ' disabled';
    this.panel.innerHTML = `
      <div class="pl-head">
        <h3>${tr('プレイリスト')}</h3>
        <span class="count">${items.length ? tr('{n} 件・{len}', { n: items.length, len: fmtLen(total) }) : ''}</span>
      </div>
      <div class="pl-tools">
        <button type="button" class="btn small primary" data-pl="play"${none}>${icon('play')} ${tr('最初から再生')}</button>
        <button type="button" class="btn small" data-pl="group"${none} title="${tr('同じ動画のものを続けて並べます（動画の切り替えが減ります）')}">${tr('同じ動画をまとめる')}</button>
        <span class="spacer"></span>
        <button type="button" class="btn small" data-pl="clear"${none}>${tr('すべて外す')}</button>
      </div>
      ${
        items.length
          ? `<ol class="pl-list">${items.map((it, i) => this.rowHtml(it, i, items[i - 1], now)).join('')}</ol>`
          : `<div class="pl-empty">${tr('左の検索結果の ＋ や、セルのカードの「プレイリストに入れる」で入れると、ここに並びます。動画をまたいで続けて再生できます。')}<br>${tr('「いいね・ブックマークだけ」にして「すべて入れる」を押すと、お気に入りの場面をまとめて入れられます。')}</div>`
      }`;
  }

  rowHtml(it, i, prev, now) {
    const [s, e] = this.range(it);
    const local = it.source === 'local';
    const head = !prev || prev.mediaId !== it.mediaId;
    const media = head
      ? `<div class="pl-media">${local ? `<span class="pl-src">${tr('ファイル')}</span>` : ''}<span class="pl-title">${escapeHtml(it.title || it.mediaId)}</span></div>`
      : '';
    const tip = it.gone
      ? tr('元のセル・目印は削除されています（入れたときの範囲で再生します）')
      : local
        ? tr('手元のファイルです。再生がここに来たら、同じファイルを開くと続きを再生します')
        : tr('クリックでここから再生');
    const label = it.label ? escapeHtml(it.label) : `<span class="muted">${tr('（メモなし）')}</span>`;
    return `<li class="pl-item${now === it.id ? ' is-now' : ''}${it.gone ? ' is-gone' : ''}" draggable="true" data-i="${i}">
      ${media}
      <div class="pl-row">
        <span class="pl-grip" title="${tr('ドラッグで並べ替え（Alt+↑↓ でも）')}">${icon('grip')}</span>
        <button type="button" class="pl-main" data-play="${i}" title="${escapeHtml(tip)}">
          <span class="pl-no">${i + 1}</span>
          <span class="lib-t">${fmt(s)}–${fmt(e)}</span>
          ${it.kind === 'marker' ? `<span class="lib-badge">${tr('目印')}</span>` : ''}
          <span class="pl-label">${label}</span>
        </button>
        <button type="button" class="pl-x" data-del="${i}" title="${tr('プレイリストから外す')}" aria-label="${tr('プレイリストから外す')}">${icon('x')}</button>
      </div>
    </li>`;
  }

  onClick(e) {
    const act = e.target.closest('[data-pl]')?.dataset.pl;
    if (act === 'play') {
      this.play(0);
      return;
    }
    if (act === 'group') {
      this.groupByMedia();
      this.app.hint(tr('同じ動画のものをまとめました'));
      return;
    }
    if (act === 'clear') {
      if (confirm(tr('プレイリストの {n} 件をすべて外しますか？（セル・目印そのものは消えません）', { n: this.items.length }))) {
        this.items.splice(0);
        this.save();
      }
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      this.items.splice(Number(del.dataset.del), 1);
      this.save();
      return;
    }
    const pl = e.target.closest('[data-play]');
    if (pl) this.play(Number(pl.dataset.play));
  }

  // Alt+↑↓ で並べ替え（ドラッグできないとき用）
  onKeydown(e) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const b = e.target.closest('[data-play]');
    if (!b) return;
    e.preventDefault();
    const i = Number(b.dataset.play);
    const to = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= this.items.length) return;
    this.move(i, to);
    this.panel.querySelector(`[data-play="${to}"]`)?.focus();
  }

  // ---- ドラッグで並べ替え ----

  onDragStart(e) {
    const li = e.target.closest?.('.pl-item');
    if (!li) return;
    this.dragFrom = Number(li.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    li.classList.add('is-drag');
  }

  dropSpot(e) {
    const li = e.target.closest?.('.pl-item');
    if (!li) return null;
    const r = li.getBoundingClientRect();
    return { li, after: e.clientY > r.top + r.height / 2 };
  }

  onDragOver(e) {
    if (this.dragFrom < 0) return;
    const spot = this.dropSpot(e);
    if (!spot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    for (const x of this.panel.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after');
    spot.li.classList.add(spot.after ? 'drop-after' : 'drop-before');
  }

  onDrop(e) {
    const spot = this.dragFrom >= 0 && this.dropSpot(e);
    if (!spot) return;
    e.preventDefault();
    const from = this.dragFrom;
    let to = Number(spot.li.dataset.i) + (spot.after ? 1 : 0);
    if (from < to) to--;
    this.endDrag();
    this.move(from, to);
  }

  endDrag() {
    this.dragFrom = -1;
    for (const x of this.panel.querySelectorAll('.is-drag, .drop-before, .drop-after')) x.classList.remove('is-drag', 'drop-before', 'drop-after');
  }
}
