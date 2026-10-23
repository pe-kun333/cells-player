// 配色を、画面を描く前に <html> に付ける（開いた瞬間に白→黒とちらつかないように、<head> で読み込む）。
// 設定（localStorage の cellsplayer:settings）の配色・時間帯の切り替え・アクセントの色を読んで、
// <html data-theme="…">・data-accent・--accent-pick を入れる。js/theme.js も、ここの関数（window.cellsTheme）を使う。
// ES モジュールにすると読み込みが後になるので、ふつうのスクリプトにしている
(function () {
  var KEY = 'cellsplayer:settings';
  var THEMES = ['auto', 'light', 'dark', 'white', 'paper', 'mint', 'sakura', 'fog', 'contrast', 'theater', 'midnight'];
  var DARK = { dark: true, midnight: true };
  // light-dark() が使えないブラウザでは、アクセントの色は選べない（色が作れないので、配色の色のまま）
  var canMix = !!(window.CSS && CSS.supports && CSS.supports('color', 'light-dark(#000, #fff)'));

  function mq(q) {
    try {
      return window.matchMedia(q).matches;
    } catch (e) {
      return false;
    }
  }

  // 'HH:MM' → 0時からの分（読めなければ fallback）
  function minutes(v, fallback) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(v || '');
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  // いま使う配色。'auto' は OS に合わせる（data-theme を付けない）。
  // OS で「コントラストを上げる」にしていてライトのときは、OS に合わせるでもハイコントラストにする
  function resolve(s, now) {
    s = s || {};
    var t = THEMES.indexOf(s.theme) >= 0 ? s.theme : 'auto';
    if (s.themeSchedule) {
      var m = now.getHours() * 60 + now.getMinutes();
      var day = minutes(s.dayStart, 7 * 60);
      var night = minutes(s.nightStart, 19 * 60);
      var isDay = day <= night ? m >= day && m < night : m >= day || m < night;
      var pick = isDay ? s.themeDay : s.themeNight;
      if (THEMES.indexOf(pick) >= 0) t = pick;
    }
    if (t === 'auto' && mq('(prefers-contrast: more)') && !mq('(prefers-color-scheme: dark)')) t = 'contrast';
    return t;
  }

  // その配色の、上のバーなどの土台がダークか（シアターは土台がライト）
  function isDark(t) {
    return t === 'auto' ? mq('(prefers-color-scheme: dark)') : !!DARK[t];
  }

  // 設定の配色を <html> に付けて、使った配色を返す
  function apply(s, now) {
    var root = document.documentElement;
    var t = resolve(s, now || new Date());
    if (t === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
    var a = s && typeof s.accent === 'string' && /^#[0-9a-f]{6}$/i.test(s.accent) && canMix ? s.accent : '';
    if (a) {
      root.setAttribute('data-accent', '');
      root.style.setProperty('--accent-pick', a);
    } else {
      root.removeAttribute('data-accent');
      root.style.removeProperty('--accent-pick');
    }
    return t;
  }

  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch (e) {}
  window.cellsTheme = { THEMES: THEMES, resolve: resolve, isDark: isDark, apply: apply, canMix: canMix };
  apply(saved);
})();
