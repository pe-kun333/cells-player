import { escapeHtml } from './util.js';
import { tr } from './i18n.js';

// 配色（設定の「配色」・時間帯の切り替え・アクセントの色）。
// <html> に付ける処理は js/theme-boot.js（<head> で先に読み込む）にあり、ここではそれを呼んで、
// 設定の画面の選択肢・試しに当てて見る（キャンセルで戻す）・OS の設定や時刻が変わったときの見直し・theme-color の書きかえをする

// 配色の一覧。m は設定の「配色」に出す小さなアプリの絵の色（css/style.css の各配色と同じ）
export const THEMES = [
  { id: 'auto', name: 'OSに合わせる' },
  { id: 'light', name: 'ライト', m: { bg: '#f5f5f3', panel: '#ffffff', line: '#e3e2de', accent: '#2b6cd4', heart: '#d24b7e', text: '#1d1d1b' } },
  { id: 'dark', name: 'ダーク', m: { bg: '#181817', panel: '#222221', line: '#33332f', accent: '#6aa2f0', heart: '#f07aa8', text: '#ebeae5' } },
  { id: 'white', name: 'ホワイト', m: { bg: '#f4f6f9', panel: '#ffffff', line: '#e1e5eb', accent: '#1f6feb', heart: '#d6457a', text: '#121820' } },
  { id: 'paper', name: 'ペーパー', m: { bg: '#eee7d8', panel: '#fbf7ee', line: '#e3d9c6', accent: '#2e4a7d', heart: '#bf4f3c', text: '#2a241c' } },
  { id: 'mint', name: 'ミント', m: { bg: '#ebf3ef', panel: '#fbfdfc', line: '#d6e5dd', accent: '#0d7a60', heart: '#cf5079', text: '#13201b' } },
  { id: 'sakura', name: 'サクラ', m: { bg: '#f7eff2', panel: '#fffbfc', line: '#ebdce1', accent: '#963b6b', heart: '#d43f4d', text: '#2a1c22' } },
  { id: 'fog', name: 'うす曇り', m: { bg: '#dcdfe4', panel: '#e9ecef', line: '#ccd1d7', accent: '#2c5fb3', heart: '#bb416c', text: '#171a1f' } },
  { id: 'contrast', name: 'ハイコントラスト', m: { bg: '#ffffff', panel: '#ffffff', line: '#1a1a1a', accent: '#0040b0', heart: '#c2185b', text: '#000000' } },
  { id: 'theater', name: 'シアター', m: { bg: '#f5f5f3', panel: '#ffffff', line: '#e3e2de', accent: '#2b6cd4', heart: '#d24b7e', text: '#1d1d1b', deck: '#222221' } },
  { id: 'midnight', name: 'ミッドナイト', m: { bg: '#0e1320', panel: '#151b2b', line: '#252e45', accent: '#6ea8ff', heart: '#f08cbf', text: '#e6eaf2' } },
];

// アクセントの色（'' は配色の色のまま）。どれもライトで白い文字が読める濃さ（ダークでは明るくして使う）
export const ACCENTS = [
  { hex: '', name: '配色の色' },
  { hex: '#2b6cd4', name: '青' },
  { hex: '#4f46e5', name: '藍' },
  { hex: '#0d7a60', name: '緑' },
  { hex: '#963b6b', name: '梅紫' },
  { hex: '#c2410c', name: '橙' },
  { hex: '#475569', name: '青灰' },
];

export const themeName = (id) => tr((THEMES.find((t) => t.id === id) || THEMES[0]).name);

export class Theme {
  constructor(app) {
    this.app = app;
    this.boot = window.cellsTheme || null;
    this.previewing = null; // 設定の画面で試しに当てている設定（保存かキャンセルまで）
    this.current = '';
    this.dark = false;
    this.listeners = [];
    this.metas = [...document.querySelectorAll('meta[name="theme-color"]')].map((el) => ({ el, orig: el.content }));
    // OS のライト／ダーク・コントラストの設定が変わったら見直す
    for (const q of ['(prefers-color-scheme: dark)', '(prefers-contrast: more)']) {
      window.matchMedia?.(q).addEventListener?.('change', () => this.apply());
    }
    // 時間帯の切り替え: 1分ごとに見直す（別のタブから戻ったときも）
    setInterval(() => this.shown().themeSchedule && this.apply(), 60 * 1000);
    document.addEventListener('visibilitychange', () => !document.hidden && this.shown().themeSchedule && this.apply());
  }

  shown() {
    return this.previewing || this.app.settings;
  }

  // 配色が変わったときに呼ぶ（{ theme, dark, darkChanged }）
  onChange(fn) {
    this.listeners.push(fn);
  }

  apply() {
    const s = this.shown();
    const t = this.boot ? this.boot.apply(s) : 'auto';
    const dark = this.boot ? this.boot.isDark(t) : !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const darkChanged = dark !== this.dark;
    const changed = t !== this.current || darkChanged;
    this.current = t;
    this.dark = dark;
    this.syncMeta();
    if (changed) this.listeners.forEach((fn) => fn({ theme: t, dark, darkChanged }));
  }

  // 設定の画面で選んでいる間だけ当てる（保存しなければ endPreview で戻す）
  preview(patch) {
    this.previewing = { ...this.app.settings, ...patch };
    this.apply();
  }

  endPreview() {
    if (!this.previewing) return;
    this.previewing = null;
    this.apply();
  }

  // ブラウザの上の部分・インストールしたアプリのタイトルバーの色を、上のバーの色に合わせる（OS に合わせるときは元の2つに戻す）
  syncMeta() {
    if (this.current === 'auto') {
      this.metas.forEach((m) => (m.el.content = m.orig));
      return;
    }
    const bar = document.querySelector('.topbar');
    const c = bar ? getComputedStyle(bar).backgroundColor : '';
    if (c) this.metas.forEach((m) => (m.el.content = c));
  }

  // ---- 設定の画面の選択肢 ----

  // 配色: 小さなアプリの絵（上のバー・動画・タイムライン・右のサイドバー）を並べたラジオボタン
  pickerHtml(value) {
    return THEMES.map((t) => {
      const st = t.m
        ? Object.entries(t.m).map(([k, v]) => `--m-${k}:${v}`).join(';')
        : '';
      return `<label class="theme-opt${t.m ? '' : ' is-auto'}">
        <input type="radio" name="theme" value="${t.id}"${t.id === value ? ' checked' : ''}>
        <span class="theme-mini" style="${st}" aria-hidden="true"><i class="v"></i><i class="t"></i><i class="s"></i></span>
        <span class="theme-name">${escapeHtml(tr(t.name))}</span>
      </label>`;
    }).join('');
  }

  // アクセントの色: 丸いラジオボタン
  accentHtml(value) {
    return ACCENTS.map((a) => {
      const name = tr(a.name);
      return `<label class="accent-opt${a.hex ? '' : ' is-theme'}" title="${escapeHtml(name)}">
        <input type="radio" name="accent" value="${a.hex}"${a.hex === (value || '') ? ' checked' : ''} aria-label="${escapeHtml(name)}">
        <span class="accent-dot"${a.hex ? ` style="--sw:${a.hex}"` : ''} aria-hidden="true"></span>
      </label>`;
    }).join('');
  }

  // 時間帯で切り替えるときの、昼・夜の配色（「OSに合わせる」は除く）
  optionsHtml(value) {
    return THEMES.filter((t) => t.id !== 'auto')
      .map((t) => `<option value="${t.id}"${t.id === value ? ' selected' : ''}>${escapeHtml(tr(t.name))}</option>`)
      .join('');
  }
}
