// 動画のまわりを動画の色にする（設定の「アンビエント」）。
// 動画を 30×17 に縮めて描き、左右の3分の1ずつの色（鮮やかな所を重く）を <html> の --amb-l・--amb-r に入れて、
// data-ambient を付ける（見た目は css/style.css の .stage。動画の黒い余白と動画の下に、うすくにじむ）。
// 手元のファイルと、絵を読める URL の動画は、再生に合わせて色が変わる。
// YouTube はプレーヤーの中の絵を読めないので、サムネイルの色にする（サムネイルも読めないときは出さない）
const W = 30;
const H = 17;

// x0〜x1 の列の平均の色（鮮やかな所ほど重くする。灰色ばかりの所はそのまま灰色になる）
function averageColor(px, x0, x1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let y = 0; y < H; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const max = Math.max(px[i], px[i + 1], px[i + 2]);
      const min = Math.min(px[i], px[i + 1], px[i + 2]);
      const k = 0.1 + ((max - min) / 255) ** 2 * 3;
      r += px[i] * k;
      g += px[i + 1] * k;
      b += px[i + 2] * k;
      w += k;
    }
  }
  return [r / w, g / w, b / w].map(Math.round).join(' ');
}

export class Ambient {
  constructor(app) {
    this.app = app;
    this.on = false;
    this.timer = 0;
    this.newCanvas();
    this.badSrc = ''; // 絵を読めなかった動画（別のサイトの動画など）。同じ動画では読み直さない
    this.last = null; // 最後に描いた動画の位置（止まっている間は描き直さない）
    this.thumb = { id: '', data: null, failed: false };
  }

  // 別のサイトの絵を一度でも描いた canvas は、ずっと読めなくなる。読めなかったら作り直す
  newCanvas() {
    this.cv = document.createElement('canvas');
    this.cv.width = W;
    this.cv.height = H;
    this.cx = this.cv.getContext('2d', { willReadFrequently: true });
  }

  // 設定に合わせて動かす・止める（設定の画面で試しているときは、その値を渡す）
  sync(on = !!this.app.settings.ambient) {
    this.on = on;
    clearInterval(this.timer);
    this.timer = 0;
    this.last = null;
    if (!on) {
      this.clear();
      return;
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), 500);
  }

  tick() {
    if (document.hidden) return;
    const v = document.querySelector('#stageMedia video');
    if (v && v.videoWidth > 0 && v.readyState >= 2) {
      // 別のサイトの URL の動画は、絵を読めない（描くと canvas が読めなくなるので、描かない）
      const src = v.currentSrc || '';
      if ((src && src === this.badSrc) || (/^https?:/i.test(src) && new URL(src).origin !== location.origin)) {
        this.clear();
        return;
      }
      if (this.last && this.last.src === v.currentSrc && this.last.t === v.currentTime) return;
      try {
        this.cx.drawImage(v, 0, 0, W, H);
        this.paint(this.cx.getImageData(0, 0, W, H).data);
        this.last = { src: v.currentSrc, t: v.currentTime };
      } catch {
        // 絵を読めないとき（リダイレクトで別のサイトになったときなど）
        this.badSrc = v.currentSrc;
        this.newCanvas();
        this.clear();
      }
      return;
    }
    const id = /^yt:([\w-]{11})$/.exec(this.app.store.doc?.id || '')?.[1];
    if (id && this.app.player?.kind === 'youtube') this.fromThumb(id);
    else this.clear();
  }

  // YouTube: サムネイルを1回だけ読んで、その色にする
  fromThumb(id) {
    const t = this.thumb;
    if (t.id === id) {
      if (t.data) this.paint(t.data);
      else if (t.failed) this.clear();
      return;
    }
    this.thumb = { id, data: null, failed: false };
    this.clear();
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.thumb.id !== id) return;
      try {
        this.cx.drawImage(img, 0, 0, W, H);
        this.thumb.data = this.cx.getImageData(0, 0, W, H).data;
        // 読み終わるまでに別の動画を開いていたら、色は付けない（次にこの動画を開いたときに使う）
        if (this.on && this.app.player?.kind === 'youtube' && this.app.store.doc?.id === 'yt:' + id) this.paint(this.thumb.data);
      } catch {
        this.thumb.failed = true;
        this.newCanvas();
      }
    };
    img.onerror = () => {
      if (this.thumb.id === id) this.thumb.failed = true;
    };
    img.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  }

  paint(px) {
    const root = document.documentElement;
    root.style.setProperty('--amb-l', `rgb(${averageColor(px, 0, 10)})`);
    root.style.setProperty('--amb-r', `rgb(${averageColor(px, W - 10, W)})`);
    root.setAttribute('data-ambient', '');
  }

  clear() {
    const root = document.documentElement;
    if (!root.hasAttribute('data-ambient')) return;
    root.removeAttribute('data-ambient');
    root.style.removeProperty('--amb-l');
    root.style.removeProperty('--amb-r');
  }
}
