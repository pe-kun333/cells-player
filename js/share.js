import { $, fmt, escapeHtml, whoColor } from './util.js';
import { saveSettings } from './store.js';
import { tr } from './i18n.js';

// 共有リンク: 自分のセル・目印・コメントを、動画の場所と一緒にリンクに詰める。
// 中身はアドレスの # より後ろ（サーバーには送られない部分）に、圧縮して入れる。
// リンクを開いた人のところでは、動画を YouTube から開き、「〇〇さんの共有」として並べる（自分のメモとは分けて持つ）
// 他の人も開けるように、リンクはいつも公開しているサイトのアドレスで作る（手元の PC で起動していても）
const PUBLIC_URL = 'https://pe-kun333.github.io/cells-player/';
const HASH_KEY = 'share=';
const MAX_JSON = 2 * 1024 * 1024; // 開いたときに受け付ける大きさ（圧縮を戻したあと）

// ---- 詰める・取り出す ----

function toB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64u(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      reader.cancel();
      throw new Error('too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const canCompress = typeof CompressionStream === 'function';

// 先頭の1文字で形式を表す（z: 圧縮、j: そのまま）
export async function encodeShare(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (canCompress) return 'z' + toB64u(await pipe(json, new CompressionStream('deflate-raw')));
  return 'j' + toB64u(json);
}

export async function decodeShare(str) {
  const bytes = fromB64u(str.slice(1));
  let raw;
  if (str[0] === 'z') raw = await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_JSON);
  else if (str[0] === 'j' && bytes.length <= MAX_JSON) raw = bytes;
  else throw new Error('unknown format');
  return sanitize(JSON.parse(new TextDecoder().decode(raw)));
}

// 同じ共有を2回読み込まないための id
export async function shareIdOf(str) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
  return 'sh' + [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// アドレス（または貼られた文字）から共有の中身の部分を取り出す
export function shareFromText(text) {
  const i = text.indexOf('#' + HASH_KEY);
  if (i < 0) return null;
  const v = text.slice(i + 1 + HASH_KEY.length).trim();
  return /^[zj][\w-]+$/.test(v) ? v : null;
}

export function shareLink(encoded) {
  const here = location.origin + location.pathname;
  const base = here.startsWith(PUBLIC_URL) ? here : PUBLIC_URL;
  return `${base}#${HASH_KEY}${encoded}`;
}

// 他の人が作ったリンクなので、形と大きさを確かめてから使う（文字はすべて文字として表示する）
function sanitize(p) {
  if (!p || typeof p !== 'object' || p.v !== 1) throw new Error('bad payload');
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7 ? Math.round(v * 100) / 100 : null);
  const lv = (v) => ([1, 2, 3].includes(v) ? v : 0);
  const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const y = typeof p.y === 'string' && /^[\w-]{11}$/.test(p.y) ? p.y : null;
  const u = !y && typeof p.u === 'string' && /^https?:\/\//i.test(p.u) ? p.u.slice(0, 2000) : null;
  if (!y && !u) throw new Error('no media');
  const comments = (v) =>
    list(v, 300)
      .map((c) => (Array.isArray(c) ? { text: str(c[0], 2000), t: num(c[1]) } : null))
      .filter((c) => c && c.text.trim());
  const cells = list(p.c, 3000)
    .map((c) => {
      if (!Array.isArray(c)) return null;
      const s = num(c[0]);
      const e = num(c[1]);
      if (s === null || e === null || e <= s) return null;
      return { s, e, memo: str(c[2], 5000), lv: lv(c[3]), bm: !!c[4], comments: comments(c[5]) };
    })
    .filter(Boolean);
  const markers = list(p.m, 5000)
    .map((m) => {
      if (!Array.isArray(m)) return null;
      const t = num(m[0]);
      if (t === null) return null;
      const tags = list(m[4], 20).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.slice(0, 40));
      return { t, mark: !!m[1], lv: lv(m[2]), bm: !!m[3], tags, comments: comments(m[5]) };
    })
    .filter(Boolean);
  return {
    y,
    u,
    title: str(p.n, 200),
    by: str(p.by, 40).trim() || tr('名前なし'),
    at: num(p.at) || 0,
    st: num(p.st) || 0,
    cells,
    markers,
  };
}

// ---- 共有リンクを作る画面 ----

export class ShareDialog {
  constructor(app) {
    this.app = app;
    this.dialog = $('#shareDialog');
    this.form = $('#shareForm');
    this.preview = $('#sharePreview');
    this.link = '';
    this.seq = 0;
    this.timer = null;
    $('#btnShare').addEventListener('click', () => this.open());
    this.form.addEventListener('input', (e) => {
      if (e.target.name === 'name') {
        app.settings.shareName = e.target.value.trim();
        saveSettings(app.settings);
      }
      if (e.target.name !== 'text') this.schedule();
    });
    this.form.addEventListener('change', () => this.schedule());
    this.form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
    });
    $('#btnShareCopy').addEventListener('click', () => this.copy());
    $('#btnShareX').addEventListener('click', () => this.postX());
  }

  open() {
    const { app } = this;
    const doc = app.store.doc;
    if (!doc || !app.player) {
      app.toast(tr('先に動画か音声を開いてください'));
      return;
    }
    if (doc.source === 'local') {
      app.toast(tr('手元のファイルは共有できません（見る人が同じファイルを持っていないため）。YouTube や、ネット上の動画で使えます'));
      return;
    }
    const f = this.form;
    f.name.value = app.settings.shareName || '';
    const sel = app.ui.selectedCells.size;
    f.scope.innerHTML =
      `<option value="all">${tr('すべて')}</option>` +
      (sel ? `<option value="selected">${tr('選んだセルだけ（{n} 個）', { n: sel })}</option>` : '');
    f.scope.value = sel ? 'selected' : 'all';
    f.start.innerHTML = `
      <option value="zero">${tr('動画の最初から')}</option>
      <option value="now">${tr('いまの位置（{time}）から', { time: fmt(app.now()) })}</option>
      <option value="first">${tr('最初のセル・目印から')}</option>`;
    f.start.value = sel ? 'first' : 'zero';
    const title = doc.title.length > 60 ? doc.title.slice(0, 60) + '…' : doc.title;
    f.text.value = tr('「{title}」をセルに分けてメモしました。区間セルプレイヤーで、セルやコメントと一緒に見られます', { title });
    $('#shareWhere').textContent = here() ? '' : tr('リンクは公開しているサイト（pe-kun333.github.io）のアドレスで作ります');
    this.link = '';
    this.dialog.showModal();
    this.update();
  }

  options() {
    const f = this.form;
    return {
      name: f.name.value.trim(),
      cells: f.cells.checked,
      markers: f.markers.checked,
      comments: f.comments.checked,
      tags: f.tags.checked,
      likes: f.likes.checked,
      scope: f.scope.value,
      start: f.start.value,
    };
  }

  // 自分のメモから、リンクに入れる中身を作る
  payload(o) {
    const { app } = this;
    const { store } = app;
    const doc = store.doc;
    let cells = store.ownCells;
    let markers = store.ownMarkers;
    if (o.scope === 'selected') {
      cells = cells.filter((c) => app.ui.selectedCells.has(c.id));
      markers = markers.filter((m) => cells.some((c) => m.t >= c.s && m.t <= c.e));
    }
    if (!o.cells) cells = [];
    if (!o.markers) markers = [];
    const r1 = (t) => Math.round(t * 10) / 10;
    const cm = (list) => (o.comments ? list.map((c) => [c.text, Number.isFinite(c.t) ? r1(c.t) : null]) : []);
    const c = [...cells]
      .sort((a, b) => a.s - b.s || a.e - b.e)
      .map((x) => [r1(x.s), r1(x.e), x.memo, o.likes ? x.lv : 0, o.likes && x.bm ? 1 : 0, cm(x.comments)]);
    const m = [...markers]
      .sort((a, b) => a.t - b.t)
      // タグもコメントもいいねも入れない目印は、区間の区切りでなければ入れても意味がない
      .filter((x) => x.mark || (o.tags && x.tags.length) || (o.comments && x.comments.length) || (o.likes && (x.lv || x.bm)))
      .map((x) => [r1(x.t), x.mark ? 1 : 0, o.likes ? x.lv : 0, o.likes && x.bm ? 1 : 0, o.tags ? x.tags : [], cm(x.comments)]);
    let st = 0;
    if (o.start === 'now') st = app.now();
    else if (o.start === 'first') st = Math.min(...c.map((x) => x[0]), ...m.map((x) => x[0]), Infinity);
    if (!Number.isFinite(st)) st = 0;
    const media = doc.source === 'youtube' ? { y: doc.id.replace(/^yt:/, '') } : { u: doc.url };
    const counts = {
      cells: c.length,
      markers: m.length,
      comments: c.reduce((n, x) => n + x[5].length, 0) + m.reduce((n, x) => n + x[5].length, 0),
    };
    return { data: { v: 1, ...media, n: doc.title.slice(0, 200), by: o.name, at: Math.floor(Date.now() / 1000), st: r1(st), c, m }, counts };
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(), 120);
  }

  async update() {
    const seq = ++this.seq;
    const o = this.options();
    const { data, counts } = this.payload(o);
    const enc = await encodeShare(data);
    if (seq !== this.seq) return;
    this.link = shareLink(enc);
    this.counts = counts;
    const n = this.link.length;
    const lines = [
      tr('入るもの: セル {c}・目印 {m}・コメント {k}', { c: counts.cells, m: counts.markers, k: counts.comments }),
      tr('リンクの長さ: {n} 文字', { n: n.toLocaleString() }),
    ];
    const warn = [];
    if (!o.name) warn.push(tr('表示名が空です（見る人には「名前なし」と出ます）'));
    if (!counts.cells && !counts.markers) warn.push(tr('入れるものがありません'));
    if (n > 4000) warn.push(tr('リンクが長いので、X などでは使えないことがあります。含めるものを減らすと短くなります'));
    this.preview.innerHTML =
      lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('') +
      warn.map((w) => `<div class="share-warn">${escapeHtml(w)}</div>`).join('');
  }

  async ready() {
    await this.update();
    if (!this.counts?.cells && !this.counts?.markers) {
      this.app.hint(tr('入れるものがありません。含めるものを選んでください'));
      return false;
    }
    return true;
  }

  async copy() {
    if (!(await this.ready())) return;
    try {
      await navigator.clipboard.writeText(this.link);
      this.app.hint(tr('共有リンクをコピーしました。開いた人は、この動画とあなたのメモを一緒に見られます'));
      this.dialog.close();
    } catch {
      this.app.hint(tr('コピーできませんでした'));
    }
  }

  async postX() {
    if (!(await this.ready())) return;
    const text = this.form.text.value.trim();
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(this.link)}`;
    window.open(url, '_blank', 'noopener');
    this.dialog.close();
    this.app.hint(tr('X の投稿画面を開きました。内容を確かめてから投稿してください'));
  }
}

function here() {
  return (location.origin + location.pathname).startsWith(PUBLIC_URL);
}

// ---- 読み込んだ共有の一覧（サイドバーの上）: 人ごとに表示・非表示、取り込む、外す ----

export class ShareLayers {
  constructor(app) {
    this.app = app;
    this.el = $('#shareBar');
    this.key = '';
    this.el.addEventListener('change', (e) => {
      const id = e.target.dataset.show;
      if (id) this.app.store.setShareShown(id, e.target.checked);
    });
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sh]');
      if (!b) return;
      const { store } = this.app;
      const sh = store.shares.find((s) => s.id === b.dataset.id);
      if (!sh) return;
      if (b.dataset.sh === 'adopt') {
        const n = store.adoptShare(sh.id);
        this.app.hint(tr('{name} さんの共有 {n} 件を、自分のメモに取り込みました（Ctrl+Z で戻せます）', { name: sh.by, n }));
      } else if (b.dataset.sh === 'remove') {
        store.removeShare(sh.id);
        this.app.hint(tr('{name} さんの共有を外しました（Ctrl+Z で戻せます）', { name: sh.by }));
      }
    });
  }

  render() {
    const { store } = this.app;
    const shares = store.doc ? store.shares : [];
    const count = (id) => ({
      c: store.doc.cells.filter((x) => x.src === id).length,
      m: store.doc.markers.filter((x) => x.src === id).length,
    });
    const rows = shares.map((s) => ({ s, n: count(s.id) }));
    const key = JSON.stringify(rows.map(({ s, n }) => [s.id, s.by, s.shown, s.color, n.c, n.m]));
    if (key === this.key) return;
    this.key = key;
    this.el.hidden = !shares.length;
    if (!shares.length) {
      this.el.innerHTML = '';
      return;
    }
    this.el.innerHTML =
      `<div class="sb-head">${tr('共有されたメモ（チェックで表示）')}</div>` +
      rows
        .map(
          ({ s, n }) => `<div class="sb-row" style="--who:${whoColor(s)}">
        <label class="sb-layer" title="${escapeHtml(tr('チェックを外すと、画面に出さない'))}">
          <input type="checkbox" data-show="${s.id}"${s.shown !== false ? ' checked' : ''}>
          <i class="sb-dot" aria-hidden="true"></i><span class="sb-name">${escapeHtml(s.by)}</span>
          <span class="sb-count">${escapeHtml(tr('セル {c}・目印 {m}', { c: n.c, m: n.m }))}</span>
        </label>
        <span class="spacer"></span>
        <button class="btn tiny" data-sh="adopt" data-id="${s.id}" title="${escapeHtml(tr('自分のメモとして編集できるようにする'))}">${tr('取り込む')}</button>
        <button class="btn tiny" data-sh="remove" data-id="${s.id}" title="${escapeHtml(tr('この人の共有を消す'))}">${tr('外す')}</button>
      </div>`,
        )
        .join('');
  }
}
