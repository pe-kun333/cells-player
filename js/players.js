import { tr } from './i18n.js';

// ローカルファイル／URL と YouTube を同じ操作で扱うためのプレイヤー

class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(ev, fn) {
    (this.handlers[ev] ||= []).push(fn);
  }
  emit(ev, ...args) {
    for (const fn of this.handlers[ev] || []) fn(...args);
  }
}

function mediaErrorMessage(err) {
  switch (err && err.code) {
    case 2: return tr('ネットワークエラーで読み込めませんでした');
    case 3: return tr('ファイルのデコードに失敗しました');
    case 4: return tr('この形式は再生できません（ブラウザが対応していないコーデックの可能性があります）');
    default: return tr('ファイルを読み込めませんでした');
  }
}

export class LocalPlayer extends Emitter {
  constructor(container) {
    super();
    this.kind = 'local';
    this.canFrameStep = true;
    const v = (this.video = document.createElement('video'));
    v.preload = 'auto';
    v.playsInline = true;
    container.appendChild(v);
    for (const ev of ['play', 'pause', 'ended', 'durationchange']) {
      v.addEventListener(ev, () => this.emit(ev));
    }
    v.addEventListener('click', () => (v.paused ? this.play() : this.pause()));
  }

  load(src) {
    const v = this.video;
    return new Promise((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const ng = () => {
        cleanup();
        reject(new Error(mediaErrorMessage(v.error)));
      };
      const cleanup = () => {
        v.removeEventListener('loadedmetadata', ok);
        v.removeEventListener('error', ng);
      };
      v.addEventListener('loadedmetadata', ok);
      v.addEventListener('error', ng);
      v.src = src;
    });
  }

  play() {
    this.video.play().catch(() => {});
  }
  pause() {
    this.video.pause();
  }
  get paused() {
    return this.video.paused;
  }
  getTime() {
    return this.video.currentTime || 0;
  }
  getDuration() {
    const d = this.video.duration;
    return Number.isFinite(d) ? d : 0;
  }
  seek(t) {
    this.video.currentTime = t;
  }
  setRate(r) {
    this.video.playbackRate = r;
  }
  getRates() {
    return [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  }
  setVolume(v) {
    this.video.volume = v;
  }
  isAudioOnly() {
    return this.video.videoWidth === 0;
  }
  destroy() {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}

// ---- YouTube ----

let ytApiPromise = null;

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!ytApiPromise) {
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (prev) prev();
        resolve(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => {
        ytApiPromise = null;
        reject(new Error(tr('YouTube の読み込みに失敗しました（ネットワークを確認してください）')));
      };
      document.head.appendChild(s);
    });
  }
  return ytApiPromise;
}

const YT_ERRORS = {
  2: tr('動画 ID が正しくありません'),
  5: tr('この動画はこのプレイヤーで再生できません'),
  100: tr('動画が見つかりません（削除済みか非公開です）'),
  101: tr('この動画は埋め込み再生が許可されていません'),
  150: tr('この動画は埋め込み再生が許可されていません'),
  153: tr('YouTube を再生できません（公開ページか、start.bat から起動したページで開いてください）'),
};

export function parseYouTubeId(input) {
  const str = input.trim();
  try {
    const u = new URL(str);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return /^[\w-]{11}$/.test(str) ? str : null;
  }
}

export class YouTubePlayer extends Emitter {
  constructor(container) {
    super();
    this.kind = 'youtube';
    this.canFrameStep = false;
    this.container = container;
    this.host = document.createElement('div');
    container.appendChild(this.host);
    this.p = null;
    this._paused = true;
  }

  async load(videoId) {
    const YT = await loadYouTubeApi();
    await new Promise((resolve, reject) => {
      let settled = false;
      this.p = new YT.Player(this.host, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,
          disablekb: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            settled = true;
            resolve();
          },
          onStateChange: (e) => {
            const S = YT.PlayerState;
            if (e.data === S.PLAYING) {
              this._paused = false;
              this.emit('play');
            } else if (e.data === S.PAUSED || e.data === S.ENDED || e.data === S.CUED) {
              this._paused = true;
              this.emit('pause');
            }
            if (e.data === S.ENDED) this.emit('ended');
            this.emit('durationchange');
          },
          onError: (e) => {
            const msg = YT_ERRORS[e.data] || tr('YouTube でエラーが発生しました（コード {code}）', { code: e.data });
            if (!settled) {
              settled = true;
              reject(new Error(msg));
            } else {
              this.emit('error', msg);
            }
          },
        },
      });
    });
  }

  play() {
    this.p?.playVideo();
  }
  pause() {
    this.p?.pauseVideo();
  }
  get paused() {
    return this._paused;
  }
  getTime() {
    return this.p?.getCurrentTime?.() || 0;
  }
  getDuration() {
    return this.p?.getDuration?.() || 0;
  }
  seek(t) {
    this.p?.seekTo(t, true);
  }
  setRate(r) {
    this.p?.setPlaybackRate(r);
  }
  getRates() {
    const rates = this.p?.getAvailablePlaybackRates?.();
    return rates && rates.length ? rates : [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  }
  setVolume(v) {
    this.p?.setVolume?.(Math.round(v * 100));
  }
  getTitle() {
    return this.p?.getVideoData?.().title || '';
  }
  isAudioOnly() {
    return false;
  }
  destroy() {
    try {
      this.p?.destroy();
    } catch {}
    this.container.innerHTML = '';
  }
}
