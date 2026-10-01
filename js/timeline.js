import { $, clamp, fmt, round2, cellLabel, whoColor } from './util.js';
import { tr } from './i18n.js';

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
      '<div class="tz-world"><div class="tz-bands"></div><div class="tz-labels"></div><div class="tz-marks"></div><div class="tz-bounds"></div></div><div class="tz-playhead"></div><div class="tz-guide" hidden></div><div class="tz-drag" hidden></div>';
    this.world = this.zoomEl.querySelector('.tz-world');
    this.bandsEl = this.zoomEl.querySelector('.tz-bands');
    this.labelsEl = this.zoomEl.querySelector('.tz-labels');
    this.marksEl = this.zoomEl.querySelector('.tz-marks');
    this.dragEl = this.zoomEl.querySelector('.tz-drag');
    this.boundsEl = this.zoomEl.querySelector('.tz-bounds');
    this.guideEl = this.zoomEl.querySelector('.tz-guide');

    this.laneOf = new Map();
    this.segPts = [];
    this.W = 0;
    this.pps = 1;
    this.worldDur = 0;
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

  // 全体の幅を使う段（セル・全体）で、x の位置の時刻
  timeAtX(el, x) {
    const r = el.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1) * this.dur;
  }

  // 拡大の段で、x の位置の時刻（まん中が再生位置）
  zoomTimeAt(x) {
    const r = this.zoomEl.getBoundingClientRect();
    return clamp(this.app.now() + (x - r.left - this.W / 2) / this.pps, 0, this.dur);
  }

  // Shift を押しているときは「ここで分割」の目安、そうでなければ時刻だけ
  guideText(t, shift) {
    return shift ? `✂ ${fmt(t, true)}` : fmt(t, true);
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

  // 共有で読み込んだものに、その人の色と名前を付ける
  markShared(el, o) {
    const sh = this.store.shareOf(o);
    if (!sh) return null;
    el.classList.add('is-shared');
    el.style.setProperty('--who', whoColor(sh));
    return sh;
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
      el.textContent = !d
        ? ''
        : this.app.tlMenu.mode('seg') === 'menu'
          ? tr('まだセルはありません。下の「区間」をクリック（ドラッグで複数区間）して「セルにする」を選ぶとセルになります')
          : tr('まだセルはありません。下の「区間」をクリック（ドラッグで複数区間）するとセルになります');
      return;
    }
    el.style.height = count * (LANE_H + LANE_GAP) - LANE_GAP + 'px';
    el.appendChild(this.laneGuide);
    if (!d) return;
    const rep = this.app.ui.repeatId;
    const sel = this.app.ui.selectedCells;
    const frag = document.createDocumentFragment();
    for (const c of cells) {
      const b = document.createElement('div');
      b.className = `tl-cell lv${c.lv}` + (c.id === rep ? ' is-repeat' : '') + (sel.has(c.id) ? ' is-selected' : '');
      this.markShared(b, c);
      b.style.left = (c.s / d) * 100 + '%';
      b.style.width = ((c.e - c.s) / d) * 100 + '%';
      b.style.top = lanes.get(c.id) * (LANE_H + LANE_GAP) + 'px';
      b.dataset.id = c.id;
      b.title = `${fmt(c.s)} – ${fmt(c.e)}  ${cellLabel(c) || tr('（メモなし）')}`;
      frag.appendChild(b);
    }
    el.appendChild(frag);
  }

  bindLanes() {
    // セルの上で、クリックした位置の時刻を出す（Shift を押していれば ✂ 分ける位置）
    this.laneGuide = document.createElement('div');
    this.laneGuide.className = 'tl-guide';
    this.laneGuide.hidden = true;
    this.lanesEl.addEventListener('pointermove', (e) => {
      const b = e.target.closest('.tl-cell');
      if (!b || !this.dur) {
        this.laneGuide.hidden = true;
        return;
      }
      const r = this.lanesEl.getBoundingClientRect();
      const t = this.timeAtX(this.lanesEl, e.clientX);
      this.laneGuide.hidden = false;
      this.laneGuide.classList.toggle('is-cut', e.shiftKey);
      this.laneGuide.style.left = e.clientX - r.left + 'px';
      this.laneGuide.dataset.t = this.guideText(t, e.shiftKey);
    });
    this.lanesEl.addEventListener('pointerleave', () => {
      this.laneGuide.hidden = true;
    });
    this.lanesEl.addEventListener('click', (e) => {
      const b = e.target.closest('.tl-cell');
      const c = b && this.store.getCell(b.dataset.id);
      if (!c) return;
      // Ctrl（Mac は ⌘）を押しながらクリックすると、連結するセルとして選ぶ
      if (e.ctrlKey || e.metaKey) {
        this.app.toggleCellSelect(c.id);
        return;
      }
      const t = this.timeAtX(this.lanesEl, e.clientX);
      // Shift+クリック: クリックした位置ですぐに分ける
      if (e.shiftKey) {
        this.app.splitCellAt(c.id, t);
        return;
      }
      if (this.app.tlMenu.mode('cell') === 'menu') {
        this.app.tlMenu.open({ kind: 'cell', id: c.id, t, x: e.clientX, y: e.clientY });
        return;
      }
      this.app.seek(c.s);
      this.app.revealCell(c.id);
    });
    // 右クリックなら、設定にかかわらずメニュー
    this.lanesEl.addEventListener('contextmenu', (e) => {
      const b = e.target.closest('.tl-cell');
      if (!b || !this.store.getCell(b.dataset.id)) return;
      e.preventDefault();
      this.app.tlMenu.open({ kind: 'cell', id: b.dataset.id, t: this.timeAtX(this.lanesEl, e.clientX), x: e.clientX, y: e.clientY });
    });
  }

  updateActive() {
    const act = this.app.activeCells;
    const cur = act.size > 1 ? this.app.curCellId : null; // 重なっているときだけ、どれを操作するかを示す
    for (const el of this.lanesEl.querySelectorAll('.tl-cell')) {
      el.classList.toggle('is-active', act.has(el.dataset.id));
      el.classList.toggle('is-cur', el.dataset.id === cur);
    }
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
      this.markShared(p, m);
      p.style.left = (m.t / d) * 100 + '%';
      p.dataset.id = m.id;
      p.title =
        fmt(m.t, true) +
        (m.tags.length ? '  ' + m.tags.map((t) => tr('［{tag}］', { tag: t })).join('') : '') +
        (m.comments.length ? '  ' + m.comments[0].text : '') +
        (m.src ? '\n' + tr('{name} さんの共有', { name: this.store.shareOf(m)?.by || '' }) : '');
      frag.appendChild(p);
    }
    // コメントマークで固定した、まだ目印になっていない位置（点線）
    if (pin && !pin.markerId) {
      const g = document.createElement('div');
      g.className = 'tl-pin is-ghost';
      g.style.left = (pin.t / d) * 100 + '%';
      g.title = `${fmt(pin.t, true)}  ${tr('コメントを書いている位置')}`;
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
        if (!pin.dataset.id) return; // コメントを書いている位置（点線）
        // 目印: メニュー（再生位置は動かさない）か、その目印へ移動
        if (this.app.tlMenu.mode('marker') === 'menu') this.app.tlMenu.open({ kind: 'marker', id: pin.dataset.id, x: e.clientX, y: e.clientY });
        else this.app.focusMarker(pin.dataset.id);
        return;
      }
      // Shift+クリック: その位置でセルを分ける（再生位置は動かさない）
      if (e.shiftKey) {
        this.app.splitCellAt(null, timeAt(e.clientX));
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
      this.hoverEl.classList.toggle('is-cut', e.shiftKey);
      this.hoverEl.textContent = e.shiftKey ? this.guideText((x / r.width) * this.dur, true) : fmt((x / r.width) * this.dur);
      this.hoverEl.style.left = clamp(x, 24, r.width - 24) + 'px';
    });
    el.addEventListener('pointerleave', () => {
      this.hoverEl.hidden = true;
    });
    el.addEventListener('contextmenu', (e) => {
      if (!this.dur) return;
      e.preventDefault();
      const pin = e.target.closest('.tl-pin');
      // 目印なら目印のメニュー、何もない所ならその位置のメニュー（移動・目印・分割）
      if (pin?.dataset.id) this.app.tlMenu.open({ kind: 'marker', id: pin.dataset.id, x: e.clientX, y: e.clientY });
      else this.app.tlMenu.open({ kind: 'pos', t: timeAt(e.clientX), x: e.clientX, y: e.clientY });
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
    const mode = this.app.tlMenu.mode('seg');
    const segTip = mode === 'cell'
      ? tr('クリックでセルに（ドラッグで複数区間・右クリックでメニュー）')
      : mode === 'seek'
        ? tr('クリックでその区間の頭へ（右クリックでメニュー）')
        : tr('クリックでメニュー（セルにする・再生など。ドラッグで複数区間）');
    const frag = document.createDocumentFragment();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const s = document.createElement('div');
      s.className = 'tl-seg' + (this.store.findCell(a, b) ? ' is-cell' : '');
      s.style.left = (a / d) * 100 + '%';
      s.style.width = ((b - a) / d) * 100 + '%';
      s.dataset.i = i;
      s.title = `${fmt(a)} – ${fmt(b)}　${segTip}`;
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
        this.app.hint(
          this.app.tlMenu.mode('seg') === 'cell'
            ? tr('{range} をセルにします（離すと作成）', { range: rangeText() })
            : tr('{range} を選んでいます（離すとメニュー）', { range: rangeText() }),
          true,
        );
      };
      const end = (ev) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        this.highlightSegs(-1, -1);
        if (ev.type === 'pointercancel') return;
        const lo = Math.min(i0, i1);
        const hi = Math.max(i0, i1);
        const s = this.segPts[lo];
        const end2 = this.segPts[hi + 1];
        const mode = this.app.tlMenu.mode('seg');
        if (i1 !== i0) this.app.hint('');
        // 区間: メニュー・すぐセルにする・頭へ移動（複数の区間を選んだときは、移動の設定でもメニュー）
        if (mode === 'cell') this.app.createCell(s, end2);
        else if (mode === 'seek' && i1 === i0) this.app.seek(s);
        else this.app.tlMenu.open({ kind: 'seg', s, e: end2, x: ev.clientX, y: ev.clientY });
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
    el.addEventListener('contextmenu', (e) => {
      if (!this.dur || this.segPts.length < 2) return;
      e.preventDefault();
      const i = indexAt(e.clientX);
      this.app.tlMenu.open({ kind: 'seg', s: this.segPts[i], e: this.segPts[i + 1], x: e.clientX, y: e.clientY });
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
      this.worldDur = 0;
      return;
    }
    this.world.style.width = d * pps + 'px';
    this.worldDur = d;

    const minor = [1, 5, 10, 30, 60].find((s) => s * pps >= 7) || 120;
    this.major = { 1: 5, 5: 30, 10: 60, 30: 300, 60: 600, 120: 1200 }[minor];
    // 1時間を超えると目盛りの数字が「1:02:03」と長くなるので、重ならないよう間隔を広げる
    const next = { 5: 10, 10: 30, 30: 60, 60: 300, 300: 600, 600: 1200, 1200: 3600 };
    if (d >= 3600) while (this.major * pps < 58 && next[this.major]) this.major = next[this.major];
    this.world.style.setProperty('--minor', minor * pps + 'px');
    this.world.style.setProperty('--major', this.major * pps + 'px');

    const bands = document.createDocumentFragment();
    for (const c of this.store.cells) {
      const lane = Math.min(this.laneOf.get(c.id) ?? 0, 2);
      const b = document.createElement('div');
      b.className = `tz-band lv${c.lv}`;
      this.markShared(b, c);
      b.style.left = c.s * pps + 'px';
      b.style.width = Math.max(2, (c.e - c.s) * pps) + 'px';
      b.style.top = 3 + lane * 4 + 'px';
      bands.appendChild(b);
    }
    this.bandsEl.appendChild(bands);

    // となり合った自分のセルの境目に、つまみを出す（ドラッグで両方のセルが一緒に動く）
    this.boundsEl.innerHTML = '';
    const bounds = document.createDocumentFragment();
    for (const t of this.boundaryTimes()) {
      const g = document.createElement('div');
      g.className = 'tz-bound';
      g.style.left = t * pps + 'px';
      g.dataset.t = t;
      g.title = tr('{time} の境目（ドラッグで両方のセルが一緒に動きます・クリックでメニュー）', { time: fmt(t, true) });
      g.innerHTML = '<div class="tz-grip"></div>';
      bounds.appendChild(g);
    }
    this.boundsEl.appendChild(bounds);

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
      const sh = this.markShared(el, m);
      el.style.left = m.t * pps + 'px';
      el.dataset.id = m.id;
      el.title =
        fmt(m.t, true) +
        (m.tags.length ? '  ' + m.tags.map((t) => tr('［{tag}］', { tag: t })).join('') : '') +
        (m.comments.length ? '  ' + m.comments[0].text : '') +
        (sh ? '\n' + tr('{name} さんの共有', { name: sh.by }) : '\n' + tr('ドラッグで位置を調整'));
      // 定型コメントを付けた目印は、つまみにキー番号（4〜9）を出す
      const nums = this.app.tagNumbers(m.tags).slice(0, 3).join('');
      el.innerHTML = nums ? `<div class="tz-knob has-num">${nums}</div>` : '<div class="tz-knob"></div>';
      marks.appendChild(el);
    }
    this.marksEl.appendChild(marks);
    this.tick(this.app.now());
  }

  // 自分のセルどうしの境目（前のセルの終わり＝後ろのセルの始まり）の時刻
  boundaryTimes() {
    const own = this.store.ownCells;
    const ends = own.map((c) => c.e);
    const out = new Set();
    for (const c of own) if (ends.some((e) => Math.abs(e - c.s) < 0.05)) out.add(round2(c.s));
    return [...out];
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
      const boundEl = !markEl && e.target.closest('.tz-bound');
      this.guideEl.hidden = true;

      if (boundEl) {
        // セルの境目をドラッグ: 前のセルの終わりと後ろのセルの始まりを一緒に動かす。クリックだけならメニュー
        const t0 = Number(boundEl.dataset.t);
        const { left, right } = this.app.boundaryCells(t0);
        if (!left.length || !right.length) return;
        const lo = Math.max(0, ...left.map((c) => c.s + 0.1));
        const hi = Math.min(this.dur, ...right.map((c) => c.e - 0.1));
        let nt = t0;
        move = (ev) => {
          const dx = ev.clientX - startX;
          if (!moved) {
            if (Math.abs(dx) < 3) return;
            moved = true;
            this.store.checkpoint();
          }
          nt = round2(clamp(t0 + dx / this.pps, lo, hi));
          for (const c of left) c.e = nt;
          for (const c of right) c.s = nt;
          this.renderZoom();
          this.showDragLabel(nt);
        };
        finish = (ev) => {
          this.dragEl.hidden = true;
          if (moved) {
            this.store.touch();
            this.app.hint(tr('セルの境目を {time} に動かしました', { time: fmt(nt, true) }));
          } else if (ev.type !== 'pointercancel') {
            this.app.tlMenu.open({ kind: 'bound', t: t0, x: ev.clientX, y: ev.clientY });
          }
        };
      } else if (markEl) {
        // 目印をドラッグして微調整。クリックだけならその目印へ移動して対象にする
        const m = this.store.getMarker(markEl.dataset.id);
        if (!m) return;
        const t0 = m.t;
        move = (ev) => {
          const dx = ev.clientX - startX;
          if (m.src) return; // 共有で読み込んだ目印は動かさない
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
        finish = (ev) => {
          this.dragEl.hidden = true;
          if (moved) {
            this.store.touch();
            this.app.hint(tr('目印を {time} に動かしました', { time: fmt(m.t, true) }));
          } else if (ev.type !== 'pointercancel') {
            // クリックだけ: メニュー（再生位置は動かさない）か、その目印へ移動
            if (this.app.tlMenu.mode('marker') === 'menu') this.app.tlMenu.open({ kind: 'marker', id: m.id, x: ev.clientX, y: ev.clientY });
            else this.app.focusMarker(m.id);
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
          if (moved || ev.type === 'pointercancel') return;
          const r = el.getBoundingClientRect();
          const t = clamp(t0 + (ev.clientX - r.left - this.W / 2) / this.pps, 0, this.dur);
          // Shift+クリック: その位置でセルを分ける（再生位置は動かさない）
          if (ev.shiftKey) this.app.splitCellAt(null, t);
          else this.app.seek(t);
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
    el.addEventListener('contextmenu', (e) => {
      if (!this.dur) return;
      e.preventDefault();
      const markEl = e.target.closest('.tz-mark');
      const boundEl = e.target.closest('.tz-bound');
      if (markEl?.dataset.id) this.app.tlMenu.open({ kind: 'marker', id: markEl.dataset.id, x: e.clientX, y: e.clientY });
      else if (boundEl) this.app.tlMenu.open({ kind: 'bound', t: Number(boundEl.dataset.t), x: e.clientX, y: e.clientY });
      else this.app.tlMenu.open({ kind: 'pos', t: this.zoomTimeAt(e.clientX), x: e.clientX, y: e.clientY });
    });
    // Shift を押しながら動かすと、分ける位置の目安（線と時刻）を出す
    el.addEventListener('pointermove', (e) => {
      if (!this.dur || e.buttons || !e.shiftKey || e.target.closest('.tz-mark, .tz-bound')) {
        this.guideEl.hidden = true;
        return;
      }
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      this.guideEl.hidden = false;
      this.guideEl.style.left = x + 'px';
      this.guideEl.dataset.t = this.guideText(this.zoomTimeAt(e.clientX), true);
    });
    el.addEventListener('pointerleave', () => {
      this.guideEl.hidden = true;
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
      // ライブ配信は長さが伸び続けるので、帯もそれに合わせて伸ばす
      if (d > this.worldDur + 0.5) {
        this.worldDur = d;
        this.world.style.width = d * this.pps + 'px';
      }
      this.world.style.transform = `translate3d(${this.W / 2 - now * this.pps}px,0,0)`;
      if (Math.abs(now - this.labelCenter) > this.app.settings.zoomRange) this.renderLabels(now);
    }
  }
}
