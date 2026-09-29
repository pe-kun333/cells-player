import { EN, EN_HTML } from './i18n-en.js';

// 画面の言葉の切り替え（日本語 / English）。
// 日本語の文をそのままキーにして、英語の辞書（i18n-en.js）で引く。辞書にない文は日本語のまま出す。
// 言語は ?lang=en / ?lang=ja → 設定 → ブラウザの言語 の順で決める（切り替えたらページを読み込み直す）
const SETTINGS_KEY = 'cellsplayer:settings';
const JA = /[぀-ヿ㐀-鿿！-｠]/;

function detect() {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'ja' || q === 'en') return q;
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (s && (s.lang === 'ja' || s.lang === 'en')) return s.lang;
  } catch {}
  const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'ja';
  return /^ja\b/i.test(nav) ? 'ja' : 'en';
}

export const lang = detect();
export const isEn = lang === 'en';
// 日付や数字の表し方
export const locale = isEn ? 'en-US' : 'ja-JP';

// 訳がない文（動作確認用。開発者ツールで window.__i18nMissing を見る）
const missingSet = new Set();
window.__i18nMissing = missingSet;
function missing(key) {
  if (missingSet.has(key)) return;
  missingSet.add(key);
  console.warn('[i18n] 訳がありません:', key);
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s);

// tr('{n} 行', { n: 3 }) → 「3 行」/「3 lines」
// （時刻を t という名前で使っている所が多いので、訳す関数は tr にしている）
export function tr(ja, vars) {
  if (isEn) {
    const v = EN[ja];
    if (typeof v === 'function') return v(vars || {});
    if (typeof v === 'string') return fill(v, vars);
    if (JA.test(ja)) missing(ja);
  }
  return fill(ja, vars);
}

// 保存しているデータの名前（字幕の名前など）。決まった名前のときだけ訳し、ファイル名などはそのまま出す
export function trMaybe(s) {
  return isEn && typeof EN[s] === 'string' ? EN[s] : s;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

// index.html に書いてある文を訳す（起動時に1回）。
// 文の途中にタグがある所は、要素に data-i18n-html="名前" を付けて、中身ごと EN_HTML の訳に置き換える。
// 同じ日本語で訳を変えたい所は data-i18n="キー" で辞書のキーを指定する（中の文字を置き換える）
export function translatePage() {
  document.documentElement.lang = lang;
  if (!isEn) return;
  document.title = tr(norm(document.title));
  const desc = document.querySelector('meta[name="description"]');
  if (desc) desc.content = tr(norm(desc.content));

  for (const el of document.querySelectorAll('[data-i18n]')) {
    const v = EN[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
    else missing(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    const v = EN_HTML[el.dataset.i18nHtml];
    if (typeof v === 'string') el.innerHTML = v;
    else missing('html:' + el.dataset.i18nHtml);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest('[data-i18n], [data-i18n-html], [data-i18n-skip], script, style, svg')) continue;
    const raw = n.nodeValue;
    const key = norm(raw);
    if (!JA.test(key)) continue;
    const v = EN[key];
    if (typeof v !== 'string') {
      missing(key);
      continue;
    }
    n.nodeValue = raw.match(/^\s*/)[0] + v + raw.match(/\s*$/)[0];
  }
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('[data-i18n-html], [data-i18n-skip]')) continue;
    for (const a of ATTRS) {
      const val = el.getAttribute(a);
      if (!val || !JA.test(val)) continue;
      const v = EN[norm(val)];
      if (typeof v === 'string') el.setAttribute(a, v);
      else missing(norm(val));
    }
  }
}
