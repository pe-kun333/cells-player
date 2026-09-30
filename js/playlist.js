import { $, fmt, fmtLen, uid, escapeHtml, icon, cellLabel } from './util.js';
import { tr } from './i18n.js';

// プレイリスト: すべてのメディアのセル・目印を好きな順に並べて、動画をまたいで続けて再生する。
// 1件は元のセル・目印を指し（mediaId + ref）、範囲・メモ・題名の写しも持つ（元が消えても、写しの範囲で再生できる）。
// 並べ替え・再生はライブラリの右側で行い、再生そのものは連続再生（digest.js）が受け持つ。
// YouTube・URL のメディアは自動で開き、手元のファイルはそこで止まって開いてもらう。
// ファイル（.playlist.json）に保存・読み込みでき、いくつものプレイリストを使い分けたり、別の PC へ持っていったりできる

const cellText = (c) => cellLabel(c, 60) || (c.comments?.[0]?.text || '').slice(0, 60);
const markerText = (m) => [(m.tags || []).join(tr('・')), m.comments?.[0]?.text].filter(Boolean).join('　').slice(0, 80);

const MAX_ITEMS = 5000;
const NOTE_MS = 5000;

// プレイリストのファイルか
export function isPlaylistJson(data) {
  return !!data && typeof data === 'object' && data.app === 'cells-player' && data.kind === 'playlist' && Array.isArray(data.items);
}

// メディアの id から、種類と開く URL を決める（ファイルに書かれた URL は使わない）
function mediaOf(mediaId) {
  const yt = /^yt:([\w-]{11})$/.exec(mediaId);
  if (yt) return { source: 'youtube', url: `https://www.youtube.com/watch?v=${yt[1]}` };
  if (mediaId.startsWith('u:')) {
    const url = mediaId.slice(2);
    return /^https?:\/\//i.test(url) ? { source: 'url', url } : null;
  }
  if (/^[fn]:/.test(mediaId)) return { source: 'local', url: '' };
  return null;
}

// ファイルの1件を確かめて、使える形にする（おかしなものは null）
function cleanItem(x) {
  if (!x || typeof x !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const mediaId = str(x.mediaId, 2100);
  const ref = str(x.ref, 100);
  const media = mediaId && ref && mediaOf(mediaId);
  if (!media) return null;
  const base = { id: uid(), mediaId, title: str(x.title, 300), ...media, ref, label: str(x.label, 200), at: Date.now() };
  if (x.kind === 'cell') {
    const s = num(x.s);
    const e = num(x.e);
    return s !== null && e !== null && e > s ? { ...base, kind: 'cell', s, e } : null;
  }
  if (x.kind === 'marker') {
    const t = num(x.t);
    return t !== null ? { ...base, kind: 'marker', t } : null;
  }
  return null;
}

// ファイル名に使えない文字を置き換える
const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '_').trim();

export class Playlist {
  constructor(app) {
    this.app = app;
    this.dialog = $('#libraryDialog');
    this.panel = $('#plPanel');
    this.dragFrom = -1;
    this.pending = null; // 読み込んだファイル（いまのリストと置き換えるか、後ろに足すかを選んでもらう）
    this.note = '';      // パネルの中に出すお知らせ（ダイアログの上では、下のヒントが見えないため）
    this.noteTimer = null;
    this.fileInput = $('#playlistInput');
    this.fileInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.importFile(f);
    });
    this.panel.addEventListener('click', (e) => this.onClick(e));
    this.panel.addEventListener('keydown', (e) => this.onKeydown(e));
    this.panel.addEventListener('change', (e) => {
      if (e.target.id === 'plName') this.setName(e.target.value);
    });
    this.panel.addEventListener('dragstart', (e) => this.onDragStart(e));
    this.panel.addEventListener('dragover', (e) => this.onDragOver(e));
    this.panel.addEventListener('drop', (e) => this.onDrop(e));
    this.panel.addEventListener('dragend', () => this.endDrag());
  }

  get items() {
    return this.app.store.playlist.items;
  }

  get name() {
    return this.app.store.playlist.name || '';
  }

  setName(v) {
    const name = String(v).trim().slice(0, 80);
    if (name === this.name) return;
    this.app.store.playlist.name = name;
    this.save();
  }

  // パネルの中に少しの間お知らせを出す
  flash(msg) {
    this.note = msg;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note = '';
      this.renderIfOpen();
    }, NOTE_MS);
    this.renderIfOpen();
  }

  // ---- ファイルに保存・読み込み ----

  // 元のセル・目印の id と、範囲・メモ・題名の写しを書く（写しがあるので、メモのない別の PC でも YouTube の分は再生できる）
  exportData() {
    return {
      app: 'cells-player',
      kind: 'playlist',
      version: 1,
      name: this.name,
      exportedAt: new Date().toISOString(),
      items: this.items.map((it) => ({
        mediaId: it.mediaId,
        title: it.title,
        source: it.source,
        url: it.url,
        kind: it.kind,
        ref: it.ref,
        ...(it.kind === 'cell' ? { s: it.s, e: it.e } : { t: it.t }),
        label: it.label,
      })),
    };
  }

  exportFile() {
    if (!this.items.length) return;
    const file = `${safeName(this.name) || tr('プレイリスト')}.playlist.json`;
    const blob = new Blob([JSON.stringify(this.exportData(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.flash(tr('「{file}」として保存しました', { file }));
  }

  async importFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      data = null;
    }
    if (!isPlaylistJson(data)) {
      this.app.openLibrary();
      this.flash(tr('プレイリストのファイルとして読み込めませんでした'));
      return;
    }
    this.load(data, file.name);
  }

  // 読み込んだ中身: いまのリストが空ならそのまま使い、あれば置き換えるか後ろに足すかを選んでもらう
  load(data, fileName = '') {
    const seen = new Set();
    const items = [];
    let skipped = 0; // 読めなかったもの（同じものが2つあったときは数えない）
    for (const x of data.items.slice(0, MAX_ITEMS)) {
      const it = cleanItem(x);
      if (!it) {
        skipped++;
        continue;
      }
      const key = `${it.mediaId}|${it.ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
    const name = (typeof data.name === 'string' && data.name.trim()) || fileName.replace(/(\.playlist)?\.json$/i, '');
    this.pending = { name: name.slice(0, 80), items, skipped };
    if (!this.dialog.open) this.app.openLibrary();
    if (!this.items.length) this.applyPending('replace');
    else this.render();
  }

  applyPending(mode) {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    if (mode === 'replace') {
      this.items.splice(0, this.items.length, ...p.items);
      this.app.store.playlist.name = p.name;
      this.save();
      this.flash(
        tr('「{name}」を読み込みました（{n} 件）', { name: p.name || tr('プレイリスト'), n: p.items.length }) +
          (p.skipped ? tr('（読めなかった {n} 件は飛ばしました）', { n: p.skipped }) : ''),
      );
      return;
    }
    let n = 0;
    for (const it of p.items) {
      if (this.has(it.mediaId, it.ref)) continue;
      this.items.push(it);
      n++;
    }
    if (n) this.save();
    this.flash(tr('「{name}」から {n} 件を後ろに足しました（入っていたものは飛ばしました）', { name: p.name || tr('プレイリスト'), n }));
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
    const p = this.pending;
    const load = p
      ? `<div class="pl-load">
          <div>${escapeHtml(tr('「{name}」（{n} 件）を読み込みます。いまのリスト（{m} 件）をどうしますか？', { name: p.name || tr('プレイリスト'), n: p.items.length, m: items.length }))}</div>
          <div class="pl-tools">
            <button type="button" class="btn small primary" data-pl="load-replace">${tr('置き換える')}</button>
            <button type="button" class="btn small" data-pl="load-append">${tr('後ろに足す')}</button>
            <button type="button" class="btn small" data-pl="load-cancel">${tr('キャンセル')}</button>
          </div>
        </div>`
      : '';
    this.panel.innerHTML = `
      <div class="pl-head">
        <h3>${tr('プレイリスト')}</h3>
        <span class="count">${items.length ? tr('{n} 件・{len}', { n: items.length, len: fmtLen(total) }) : ''}</span>
      </div>
      <input id="plName" type="text" class="field pl-name" value="${escapeHtml(this.name)}" maxlength="80" placeholder="${tr('プレイリストの名前（保存するときのファイル名になります）')}" autocomplete="off">
      <div class="pl-tools">
        <button type="button" class="btn small primary" data-pl="play"${none}>${icon('play')} ${tr('最初から再生')}</button>
        <button type="button" class="btn small" data-pl="group"${none} title="${tr('同じ動画のものを続けて並べます（動画の切り替えが減ります）')}">${tr('同じ動画をまとめる')}</button>
      </div>
      <div class="pl-tools">
        <button type="button" class="btn small" data-pl="save"${none} title="${tr('このプレイリストをファイル（.playlist.json）に保存します。読み込むと、また使えます')}">${icon('file')} ${tr('ファイルに保存')}</button>
        <button type="button" class="btn small" data-pl="open" title="${tr('保存したプレイリストのファイルを読み込みます')}">${tr('ファイルから読み込む')}</button>
        <span class="spacer"></span>
        <button type="button" class="btn small" data-pl="clear"${none}>${tr('すべて外す')}</button>
      </div>
      ${load}
      ${this.note ? `<div class="pl-note" role="status">${escapeHtml(this.note)}</div>` : ''}
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
      this.flash(tr('同じ動画のものをまとめました'));
      return;
    }
    if (act === 'clear') {
      if (confirm(tr('プレイリストの {n} 件をすべて外しますか？（セル・目印そのものは消えません）', { n: this.items.length }))) {
        this.items.splice(0);
        this.app.store.playlist.name = '';
        this.save();
      }
      return;
    }
    if (act === 'save') {
      this.setName(this.panel.querySelector('#plName')?.value ?? this.name);
      this.exportFile();
      return;
    }
    if (act === 'open') {
      this.fileInput.click();
      return;
    }
    if (act?.startsWith('load-')) {
      if (act === 'load-cancel') {
        this.pending = null;
        this.render();
      } else this.applyPending(act === 'load-replace' ? 'replace' : 'append');
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
    // 名前の欄の Enter でダイアログを閉じない（決めるだけ）
    if (e.target.id === 'plName' && e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      this.setName(e.target.value);
      return;
    }
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
