import { tr } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round2 = (t) => Math.round(t * 100) / 100;

export function fmt(t, tenths = false) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  // 2.8 が 2.7999… になって「2.7」と出ないよう、0.1 秒単位の整数にしてから分解する
  const d10 = Math.floor(t * 10 + 1e-6);
  const whole = Math.floor(d10 / 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base = h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  return tenths ? `${base}.${d10 % 10}` : base;
}

// セルの長さ: 「14秒」「2分05秒」
export function fmtLen(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? tr('{m}分{s}秒', { m, s: String(s % 60).padStart(2, '0') }) : tr('{s}秒', { s });
}

// 書いた日時: 「9/29 14:05」
export function fmtDate(at) {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// セルの見出しとして使う、メモの最初の行（なければ空）
export function cellLabel(c, max = 30) {
  const line = (c.memo || '').split('\n').find((l) => l.trim()) || '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function icon(name, cls = '') {
  return `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// 3段階いいねの表示（塗りつぶしのハート数 = 段階）
export function hearts(lv) {
  let html = '<span class="hearts">';
  for (let i = 1; i <= 3; i++) {
    html += `<svg class="i h ${i <= lv ? 'on' : 'off'}" aria-hidden="true"><use href="#i-heart"/></svg>`;
  }
  return html + '</span>';
}

// 目印に付いたよく使うコメント（タグ）の表示
export function tagChips(tags) {
  if (!tags || !tags.length) return '';
  const chips = tags.map((t) => `<span class="tag-chip" title="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join('');
  return `<span class="tag-chips">${chips}</span>`;
}

export function commentSummary(comments) {
  if (!comments.length) return '';
  const first = comments[0].text;
  return comments.length > 1 ? tr('{first}（他 {n} 件）', { first, n: comments.length - 1 }) : first;
}

// 共有で読み込んだ人ごとの色（明るい画面でも暗い画面でも見分けやすい中間の色）
export const WHO_COLORS = ['#d9822b', '#2f9e8f', '#8f5bd6', '#d6457a', '#4f86d9', '#7a9a2c'];
export const whoColor = (sh) => WHO_COLORS[(sh?.color ?? 0) % WHO_COLORS.length];
