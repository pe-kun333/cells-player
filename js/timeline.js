import { $, clamp, fmt, round2, cellLabel } from './util.js';

const LANE_H = 10;
const LANE_GAP = 3;

// 重なるセルを段に振り分ける（開始順・長い順に、空いている一番上の段へ）
export function assignLanes(cells) {
  const sorted = [...cells].sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  const ends = [];
  const lanes = new Map();
  for (const c of sorted) {
    let i = ends.findIndex((end) => end <= c.s + 1e-6);
    if (i < 0) {
      i = ends.length;
      ends.push(c.e);
    } else {
      ends[i] = c.e;
    }
    lanes.set(c.id, i);
  }
  return { lanes, count: ends.length };
}

export class Timeline {
  constructor(app) {
    this.app = app;
    this.lanesEl = $('#tlLanes');
    this.mainEl = $('#tlMain');
    this.segsEl = $('#tlSegs');
    this.zoomEl = $('#tlZoom');

    this.mainEl.innerHTML =
      '<div class="tl-played"></div><div class="tl-layer"></div><div class="tl-playhead"></div><div class="tl-hover" hidden></div>';
    this.playedEl = this.mainEl.querySelector('.tl-played');
    this.pinLayer = this.mainEl.querySelector('.tl-layer');
    this.playheadEl = this.mainEl.querySelector('.tl-playhead');
    this.hoverEl = this.mainEl.querySelector('.tl-hover');

    this.zoomEl.innerHTML =
      '<div class="tz-world"><div class="tz-bands"></div><div class="tz-labels"></div><div class="tz-marks"></div></div><div class="tz-playhead"></div><div class="tz-drag" hidden></div>';
    this.world = this.zoomEl.querySelector('.tz-world');
    this.bandsEl = this.zoomEl.querySelector('.tz-bands');
    this.labelsEl = this.zoomEl.querySelector('.tz-labels');
    this.marksEl = this.zoomEl.querySelector('.tz-marks');
    this.dragEl = this.zoomEl.querySelector('.tz-drag');

    this.laneOf = new Map();
    this.segPts = [];
    this.W = 0;
    this.pps = 1;
    this.major = 5;
    this.labelCenter = -Infinity;

    this.bindLanes();
    this.bindMain();
    this.bindSegs();
    this.bindZoom();
    new ResizeObserver(() => this.renderZoom()).observe(this.zoomEl);
  }

  get dur() {
    return this.app.duration();
  }

  get store() {
    return this.app.store;
  }

  render() {
    this.renderLanes();
    this.renderMain();
    this.renderSegs();
    this.renderZoom();
    this.updateActive();
  }

  // セル化に使う区切り: 先頭・M や −N秒 で置いた目印・末尾（いいね・コメントだけの目印は区切りにしない）
  boundaries() {
    const d = this.dur;
    const ts = [...new Set(this.store.markers.filter((m) => m.mark).map((m) => m.t))]
      .filter((t) => t > 0.05 && t < d - 0.05)
      .sort((a, b) => a - b);
    return [0, ...ts, d];
  }

  // ---- セルの段 ----

  renderLanes() {
    const el = this.lanesEl;
    const d = this.dur;
    const cells = this.store.cells;
    const { lanes, count } = assignLanes(cells);
    this.laneOf = lanes;
    el.innerHTML = '';
    el.classList.toggle('is-empty', !count);
    if (!count) {
      el.style.height = '';
      el.textContent = d ? 'まだセルはありません。下の「区間」をクリック（ドラッグで複数区間）するとセルになります' : '';
      return;
    }
    el.style.height = count * (LANE_H + LANE_GAP) - LANE_GAP + 'px';
    if (!d) return;
    const rep = this.app.ui.repeatId;
    const sel = this.app.ui.selectedCells;
    const frag = document.createDocumentFragment();
    for (const c of cells) {
      const b = document.createElement('div');
      b.className = `tl-cell lv${c.lv}` + (c.id === rep ? ' is-repeat' : '') + (sel.has(c.id) ? ' is-selected' : '');
      b.style.left = (c.s / d) * 100 + '%';
      b.style.width = ((c.e - c.s) / d) * 100 + '%';
      b.style.top = lanes.get(c.id) * (LANE_H + LANE_GAP) + 'px';
      b.dataset.id = c.id;
      b.title = `${fmt(c.s)} – ${fmt(c.e)}  ${cellLabel(c) || '（メモなし）'}`;
      frag.appendChild(b);
    }
    el.appendChild(frag);
  }

  bindLanes() {
    this.lanesEl.addEventListener('click', (e) => {
      const b = e.target.closest('.tl-cell');
      const c = b && this.store.getCell(b.dataset.id);
      if (!c) return;
      // Ctrl（Mac は ⌘）を押しながらクリックすると、連結するセルとして選ぶ
      if (e.ctrlKey || e.metaKey) {
        this.app.toggleCellSelect(c.id);
        return;
      }
      this.app.seek(c.s);
      this.app.revealCell(c.id);
    });
  }

  updateActive() {
    const act = this.app.activeCells;
    for (const el of this.lanesEl.children) el.classList.toggle('is-active', act.has(el.dataset.id));
  }

  // ---- 全体のシークバー ----

  renderMain() {
    const layer = this.pinLayer;
    layer.innerHTML = '';
    const d = this.dur;
    if (!d) return;
    const tid = this.app.ui.target?.id;
    const pin = this.app.ui.commentPin;
    const frag = document.createDocumentFragment();
    for (const m of this.store.markers) {
      const p = document.createElement('div');
      const hi = m.id === tid || m.id === pin?.markerId;
      p.className = `tl-pin lv${m.lv}` + (hi ? ' is-target' : '') + (m.bm ? ' is-bm' : '') + (m.mark ? '' : ' is-moment');
      p.style.left = (m.t / d) * 100 + '%';
      p.dataset.id = m.id;
      p.title =
        fmt(m.t, true) +
        (m.tags.length ? '  ' + m.tags.map((t) => `［${t}］`).join('') : '') +
        (m.comments.length ? '  ' + m.comments[0].text : '');
      frag.appendChild(p);
    }
    // コメントマークで固定した、まだ目印になっていない位置（点線）
    if (pin && !pin.markerId) {
      const g = document.createElement('div');
      g.className = 'tl-pin is-ghost';
      g.style.left = (pin.t / d) * 100 + '%';
      g.title = `${fmt(pin.t, true)}  コメントを書いている位置`;
      frag.appendChild(g);
    }
    layer.appendChild(frag);
  }

  bindMain() {
    const el = this.mainEl;
    const timeAt = (x) => {
      const r = el.getBoundingClientRect();
      return clamp((x - r.left) / r.width, 0, 1) * this.dur;
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.dur || e.button !== 0) return;
      const pin = e.target.closest('.tl-pin');
      if (pin) {
        this.app.focusMarker(pin.dataset.id);
        return;
      }
      this.app.seek(timeAt(e.clientX));
      el.setPointerCapture(e.pointerId);
      const move = (ev) => this.app.seek(timeAt(ev.clientX));
      const end = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dur) return;
      const r = el.getBoundingClientRect();
      const x = clamp(e.clientX - r.left, 0, r.width);
      this.hoverEl.hidden = false;
      this.hoverEl.textContent = fmt((x / r.width) * this.dur);
      this.hoverEl.style.left = clamp(x, 24, r.width - 24) + 'px';
    });
    el.addEventListener('pointerleave', () => {
      this.hoverEl.hidden = true;
    });
  }

  // ---- 区間（目印と目印の間） ----

  renderSegs() {
    const el = this.segsEl;
    el.innerHTML = '';
    const d = this.dur;
    if (!d) {
      this.segPts = [];
      return;
    }
    const pts = (this.segPts = this.boundaries());
    const frag = document.createDocumentFragment();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const s = document.createElement('div');
      s.className = 'tl-seg' + (this.store.findCell(a, b) ? ' is-cell' : '');
      s.style.left = (a / d) * 100 + '%';
      s.style.width = ((b - a) / d) * 100 + '%';
      s.dataset.i = i;
      s.title = `${fmt(a)} – ${fmt(b)}　クリックでセルに（ドラッグで複数区間）`;
      frag.appendChild(s);
    }
    el.appendChild(frag);
  }

  highlightSegs(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (const s of this.segsEl.children) {
      const i = Number(s.dataset.i);
      s.classList.toggle('is-range', a >= 0 && i >= lo && i <= hi);
    }
  }

  bindSegs() {
    const el = this.segsEl;
    const indexAt = (x) => {
      const r = el.getBoundingClientRect();
      const t = clamp((x - r.left) / r.width, 0, 1) * this.dur;
      const pts = this.segPts;
      let i = 0;
      while (i < pts.length - 2 && pts[i + 1] <= t) i++;
      return i;
    };
    el.addEventListener('pointerdown', (e) => {
      if (!this.dur || e.button !== 0 || this.segPts.length < 2) return;
      e.preventDefault();
      const i0 = indexAt(e.clientX);
      let i1 = i0;
      const rangeText = () => {
        const lo = Math.min(i0, i1);
        const hi = Math.max(i0, i1);
        return `${fmt(this.segPts[lo])} – ${fmt(this.segPts[hi + 1])}`;
      };
      el.setPointerCapture(e.pointerId);
      this.highlightSegs(i0, i1);
      const move = (ev) => {
        const i = indexAt(ev.clientX);
        if (i === i1) return;
        i1 = i;
        this.highlightSegs(i0, i1);
        this.app.hint(`${rangeText()} をセルにします（離すと作成）`, true);
      };
      const end = (ev) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        this.highlightSegs(-1, -1);
        if (ev.type === 'pointercancel') return;
        const lo = Math.min(i0, i1);
        const hi = Math.max(i0, i1);
        this.app.createCell(this.segPts[lo], this.segPts[hi + 1]);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }

  // ---- 拡大ストリップ ----
  // 全体を秒×pps の横長の帯（world）として描き、再生位置が中央に来るよう平行移動する

  renderZoom() {
    const d = this.dur;
    this.W = this.zoomEl.clientWidth;
    this.pps = this.W / (2 * this.app.settings.zoomRange);
    const pps = this.pps;
    this.bandsEl.innerHTML = '';
    this.marksEl.innerHTML = '';
    this.labelsEl.innerHTML = '';
    this.labelCenter = -Infinity;
    if (!d || !this.W) {
      this.world.style.width = '0px';
      return;
    }
    this.world.style.width = d * pps + 'px';

    const minor = [1, 5, 10, 30, 60].find((s) => s * pps >= 7) || 120;
    this.major = { 1: 5, 5: 30, 10: 60, 30: 300, 60: 600, 120: 1200 }[minor];
    this.world.style.setProperty('--minor', minor * pps + 'px');
    this.world.style.setProperty('--major', this.major * pps + 'px');

    const bands = document.createDocumentFragment();
    for (const c of this.store.cells) {
      const lane = Math.min(this.laneOf.get(c.id) ?? 0, 2);
      const b = document.createElement('div');
      b.className = `tz-band lv${c.lv}`;
      b.style.left = c.s * pps + 'px';
      b.style.width = Math.max(2, (c.e - c.s) * pps) + 'px';
      b.style.top = 3 + lane * 4 + 'px';
      bands.appendChild(b);
    }
    this.bandsEl.appendChild(bands);

    const tid = this.app.ui.target?.id;
    const pin = this.app.ui.commentPin;
    const marks = document.createDocumentFragment();
    if (pin && !pin.markerId) {
      const g = document.createElement('div');
      g.className = 'tz-mark is-ghost';
      g.style.left = pin.t * pps + 'px';
      g.innerHTML = '<div class="tz-knob"></div>';
      marks.appendChild(g);
    }
    for (const m of this.store.markers) {
      const el = document.createElement('div');
      const hi = m.id === tid || m.id === pin?.markerId;
      el.className = `tz-mark lv${m.lv}` + (hi ? ' is-target' : '') + (m.bm ? ' is-bm' : '') + (m.mark ? '' : ' is-moment');
      el.style.left = m.t * pps + 'px';
      el.dataset.id = m.id;
      el.title =
        fmt(m.t, true) +
        (m.tags.length ? '  ' + m.tags.map((t) => `［${t}］`).join('') : '') +
        (m.comments.length ? '  ' + m.comments[0].text : '') +
        '\nドラッグで位置を調整';
      // 定型コメントを付けた目印は、つまみにキー番号（4〜9）を出す
      const nums = this.app.tagNumbers(m.tags).slice(0, 3).join('');
      el.innerHTML = nums ? `<div class="tz-knob has-num">${nums}</div>` : '<div class="tz-knob"></div>';
      marks.appendChild(el);
    }
    this.marksEl.appendChild(marks);
    this.tick(this.app.now());
  }

  renderLabels(center) {
    const R = this.app.settings.zoomRange;
    const major = this.major;
    const to = Math.min(this.dur, center + 3 * R);
    let t = Math.max(0, Math.floor((center - 3 * R) / major) * major);
    let html = '';
    for (; t <= to; t += major) {
      html += `<span class="tz-label" style="left:${t * this.pps}px">${fmt(t)}</span>`;
    }
    this.labelsEl.innerHTML = html;
    this.labelCenter = center;
  }

  showDragLabel(t) {
    const x = this.W / 2 + (t - this.app.now()) * this.pps;
    this.dragEl.hidden = false;
    this.dragEl.textContent = fmt(t, true);
    this.dragEl.style.left = clamp(x, 28, this.W - 28) + 'px';
  }

  bindZoom() {
    const el = this.zoomEl;
    el.addEventListener('pointerdown', (e) => {
      if (!this.dur || e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      let moved = false;
      let move;
      let finish;
      const markEl = e.target.closest('.tz-mark');

      if (markEl) {
        // 目印をドラッグして微調整。クリックだけならその目印へ移動して対象にする
        const m = this.store.getMarker(markEl.dataset.id);
        if (!m) return;
        const t0 = m.t;
        move = (ev) => {
          const dx = ev.clientX - startX;
          if (!moved) {
            if (Math.abs(dx) < 3) return;
            moved = true;
            this.store.checkpoint();
            markEl.classList.add('is-dragging');
          }
          m.t = round2(clamp(t0 + dx / this.pps, 0, this.dur));
          markEl.style.left = m.t * this.pps + 'px';
          this.showDragLabel(m.t);
        };
        finish = () => {
          this.dragEl.hidden = true;
          if (moved) {
            this.store.touch();
            this.app.hint(`目印を ${fmt(m.t, true)} に動かしました`);
          } else {
            this.app.focusMarker(m.id);
          }
        };
      } else {
        // 背景をつかんで左右にずらすと再生位置が動く。クリックならその位置へ
        const t0 = this.app.now();
        el.classList.add('is-grabbing');
        move = (ev) => {
          const dx = ev.clientX - startX;
          if (!moved && Math.abs(dx) < 3) return;
          moved = true;
          this.app.seek(clamp(t0 - dx / this.pps, 0, this.dur));
        };
        finish = (ev) => {
          el.classList.remove('is-grabbing');
          if (moved) return;
          const r = el.getBoundingClientRect();
          this.app.seek(clamp(t0 + (ev.clientX - r.left - this.W / 2) / this.pps, 0, this.dur));
        };
      }

      el.setPointerCapture(e.pointerId);
      const end = (ev) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        finish(ev);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }

  // ---- 毎フレーム ----

  tick(now) {
    const d = this.dur;
    if (!d) return;
    const p = clamp(now / d, 0, 1) * 100;
    this.playheadEl.style.left = p + '%';
    this.playedEl.style.width = p + '%';
    if (this.W) {
      this.world.style.transform = `translate3d(${this.W / 2 - now * this.pps}px,0,0)`;
      if (Math.abs(now - this.labelCenter) > this.app.settings.zoomRange) this.renderLabels(now);
    }
  }
}
