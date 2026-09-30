import { uid, round2 } from './util.js';
import { openKV } from './db.js';
import { tr, isEn } from './i18n.js';

const PREFIX = 'cellsplayer:';
const OLD_PREFIX = 'cellplayer:'; // アプリ名を cells-player に変える前の保存データ
const SETTINGS_KEY = PREFIX + 'settings';
const mediaKey = (id) => 'media:' + id;

// よく使うコメント（4〜9 キー）。付けた名前がそのままタグになるので、
// 名前を変えるとそれ以降は別のタグとして記録される
export const PRESET_COUNT = 6;
// 初めて使うときの内容。名前はタグとして保存されるので、そのときの表示の言語で用意する（あとで言語を変えても元のまま）
export const DEFAULT_PRESET_SETS = isEn
  ? [
      { id: 'study', name: 'Study', items: ['Review', "Can't catch", 'Useful phrase', 'Pronunciation', 'Got it', 'Question'] },
      { id: 'watch', name: 'Watching', items: ['Great scene', 'Funny', 'Moving', 'Chills', 'Beautiful shot', 'Watch again'] },
    ]
  : [
      { id: 'study', name: '学習用', items: ['要復習', '聞き取れない', '覚えたい表現', '発音注意', 'わかった', '質問したい'] },
      { id: 'watch', name: '鑑賞用', items: ['名場面', '笑った', '泣ける', '鳥肌', '映像がいい', 'もう一度見たい'] },
    ];

export const DEFAULT_SETTINGS = {
  offsets: [3, 6, 9],      // 「少し前に目印」ボタンの秒数
  mergeWindow: 2,          // この秒数以内の既存の目印はまとめる
  targetRange: 10,         // 作った目印が「対象」であり続ける範囲（秒）
  zoomRange: 30,           // 拡大ストリップの表示範囲（前後それぞれ、秒）
  leadIn: 3,               // 「少し前から」で移動するときに戻る秒数
  momentClip: 5,           // 連続再生で、目印のあと何秒まで再生するか（前は leadIn 秒）
  digestLoop: false,       // 連続再生が最後まで行ったら最初から繰り返す
  pauseOnMark: true,         // コメントマーク（C）を使ったら再生を止める
  resumeAfterComment: true,  // コメントマークで止めたとき、送信・取り消しのあと再生を戻す
  volume: 1,
  presetSets: DEFAULT_PRESET_SETS,
  activePresetSet: 'study',
  sidebarSort: 'time',       // サイドバーの並び順（time / like / new / comments）
  momentListOpen: true,      // サイドバー下の「瞬間のコメント」を開いておく
  momentListSync: true,      // 「瞬間のコメント」を再生位置に連動させる
  momentListMode: 'comments', // サイドバー下の一覧に出すもの（comments: 瞬間のコメント / transcript: 文字起こし）
  captions: true,            // 字幕を動画の上に表示する
  liveChat: true,            // ライブ配信のときに、YouTube のチャットを左に表示する
  liveLang: isEn ? 'en-US' : 'ja-JP', // 音声認識の言語
  lang: null,                // 表示の言語（null ならブラウザの言語に合わせる）
  liveHelpSeen: false,       // 音声認識の準備の説明を見たか（初回だけ出す）
  repeatCount: 0,            // リピートの回数（0 はずっと）
  repeatGap: 0,              // リピートで頭に戻ったあとの無音（秒）
  repeatRamp: false,         // リピートのたびに速度を上げる（0.7倍から元の速さまで）
  shadowGap: 1,              // シャドーイングの待ち時間（行の長さの何倍か）
  shadowRepeat: 1,           // シャドーイングで1行を何回くり返すか
  shadowShowText: true,      // シャドーイングで文字を見せる
  splitGap: 2,               // 文字起こしから自動でセルにするときの、区切る間（秒）
  splitMax: 60,              // 同じく、1つのセルの長さの上限（秒）
  wordScope: 'media',        // 単語帳の表示（media: いまのメディア / all: すべて）
};

function readJSON(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function normalizePresetSets(sets) {
  const out = (Array.isArray(sets) ? sets : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      id: typeof s.id === 'string' && s.id ? s.id : uid(),
      name: String(s.name || tr('セット')).trim() || tr('セット'),
      items: Array.from({ length: PRESET_COUNT }, (_, i) =>
        String((Array.isArray(s.items) && s.items[i]) || '').trim(),
      ),
    }));
  return out.length ? out : structuredClone(DEFAULT_PRESET_SETS);
}

// 以前の名前（cellplayer:）で保存したデータを新しい名前へ移す。
// 容量不足などで途中で失敗したときは、古いデータを消さずに残して次回また試す
function migrateOldKeys() {
  try {
    const old = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OLD_PREFIX)) old.push(k);
    }
    if (!old.length) return;
    for (const k of old) {
      const nk = PREFIX + k.slice(OLD_PREFIX.length);
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k));
    }
    for (const k of old) localStorage.removeItem(k);
  } catch {}
}
migrateOldKeys();

export function loadSettings() {
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...(readJSON(SETTINGS_KEY) || {}) };
  delete s.pauseWhileTyping; // コメントマークの設定に置き換えた古い設定
  s.presetSets = normalizePresetSets(s.presetSets);
  if (!s.presetSets.some((x) => x.id === s.activePresetSet)) s.activePresetSet = s.presetSets[0].id;
  if (!['time', 'like', 'new', 'comments'].includes(s.sidebarSort)) s.sidebarSort = 'time';
  return s;
}

export function saveSettings(s) {
  writeJSON(SETTINGS_KEY, s);
}

// 区切りかどうかを記録する前のデータ: 何も付いていない目印は M で置いたもの、
// いいね・コメントなどが付いているものは「この瞬間」でできたものとみなす
function guessMark(m) {
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const comments = Array.isArray(m.comments) ? m.comments : [];
  return !(m.lv || m.bm || tags.length || comments.length);
}

// extra: { via: 'x' } など（X に投稿した内容を残したコメント）
export function makeComment(text, t, extra = {}) {
  return { id: uid(), text, t: round2(t), at: Date.now(), ...extra };
}

function emptyDoc(meta) {
  const now = Date.now();
  return {
    version: 1,
    id: meta.id,
    title: meta.title,
    source: meta.source,
    url: meta.url || null,
    duration: 0,
    markers: [],
    cells: [],
    createdAt: now,
    updatedAt: now,
  };
}

// 字幕の行に編集・削除のための id を付ける
function withIds(cues) {
  for (const c of cues) if (!c.id) c.id = uid();
  return cues;
}

// 1つのメディアに対する目印・セルのデータと、元に戻す／やり直しの履歴を持つ。
// 保存先は IndexedDB（db.js）。最近開いた一覧と単語帳もここで持つ
export class Store {
  constructor() {
    this.doc = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.saveTimer = null;
    this.kv = null;
    this.index = []; // 最近開いたメディア
    this.words = []; // 単語帳（すべてのメディア共通）
    // ライブ配信を見ているか（main が差し込む）。ライブ中に作った目印・セル・字幕の行には fromLive を付け、
    // あとでアーカイブの時刻に合わせるときに、それだけをずらす
    this.liveNow = () => false;
  }

  // ライブ中に作ったものの印
  liveFlag() {
    return this.liveNow() ? { fromLive: true } : {};
  }

  // 起動時に一度だけ呼ぶ（localStorage からの引っ越しもここで行う）
  async init() {
    this.kv = await openKV();
    const idx = await this.kv.get('index');
    this.index = Array.isArray(idx) ? idx : [];
    const words = await this.kv.get('words');
    this.words = Array.isArray(words) ? words : [];
    return this.kv;
  }

  recent() {
    return [...this.index].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  subscribe(fn) {
    this.listeners.add(fn);
  }

  emit(reason) {
    for (const fn of this.listeners) fn(reason);
  }

  // 画面に出す目印・セル（自分のものと、表示にしている共有のもの）
  get markers() {
    return this.doc ? this.shownOnly(this.doc.markers) : [];
  }

  get cells() {
    return this.doc ? this.shownOnly(this.doc.cells) : [];
  }

  // 自分の目印・セル（共有で読み込んだものは含めない）
  get ownMarkers() {
    return this.doc ? this.doc.markers.filter((m) => !m.src) : [];
  }

  get ownCells() {
    return this.doc ? this.doc.cells.filter((c) => !c.src) : [];
  }

  // ---- 共有で読み込んだもの ----
  // 共有リンクから読み込んだ人ごとのまとまりを doc.shares に持つ。その人の目印・セルには src（まとまりの id）が付き、
  // 画面には出すが編集はしない（いいね・コメントは自分の目印に付く）

  get shares() {
    return this.doc?.shares || [];
  }

  shareOf(item) {
    return item?.src ? this.shares.find((s) => s.id === item.src) || null : null;
  }

  shownOnly(list) {
    const hidden = this.shares.filter((s) => s.shown === false);
    if (!hidden.length) return list;
    const ids = new Set(hidden.map((s) => s.id));
    return list.filter((x) => !x.src || !ids.has(x.src));
  }

  // 共有の中身を加える。同じ共有をもう一度開いたときは加えずに表示にする（false を返す）。
  // 元に戻すの対象にはしない（外すのは removeShare で、そちらは元に戻せる）
  addShare(meta, markers, cells) {
    const had = this.shares.find((s) => s.id === meta.id);
    if (had) {
      if (had.shown === false) this.setShareShown(meta.id, true);
      return false;
    }
    const used = new Set(this.shares.map((s) => s.color));
    let color = 0;
    while (used.has(color)) color++;
    this.mutate((doc) => {
      doc.shares = [...(doc.shares || []), { ...meta, color, shown: true, addedAt: Date.now() }];
      const at = meta.at ? meta.at * 1000 : Date.now();
      const comments = (list) => list.map((c) => ({ id: uid(), text: c.text, t: c.t, at }));
      for (const m of markers) {
        doc.markers.push({ id: uid(), t: m.t, mark: m.mark, lv: m.lv, bm: m.bm, tags: m.tags, comments: comments(m.comments), at, src: meta.id });
      }
      for (const c of cells) {
        doc.cells.push({ id: uid(), s: c.s, e: c.e, memo: c.memo, lv: c.lv, bm: c.bm, comments: comments(c.comments), at, src: meta.id });
      }
    }, { record: false });
    return true;
  }

  setShareShown(id, shown) {
    this.mutate((doc) => {
      doc.shares = (doc.shares || []).map((s) => (s.id === id ? { ...s, shown } : s));
    }, { record: false });
  }

  // 共有を外す（その人の目印・セルを消す）。元に戻せる
  removeShare(id) {
    this.mutate((doc) => {
      doc.shares = (doc.shares || []).filter((s) => s.id !== id);
      doc.markers = doc.markers.filter((m) => m.src !== id);
      doc.cells = doc.cells.filter((c) => c.src !== id);
    });
  }

  // 共有を自分のメモに取り込む（自分の目印・セルとして編集できるようになる）。
  // コメントには書いた人の名前を残す。元に戻せる
  adoptShare(id) {
    const sh = this.shares.find((s) => s.id === id);
    if (!sh) return 0;
    return this.mutate((doc) => {
      let n = 0;
      for (const x of [...doc.markers, ...doc.cells]) {
        if (x.src !== id) continue;
        delete x.src;
        for (const c of x.comments) c.by = sh.by;
        n++;
      }
      doc.shares = doc.shares.filter((s) => s.id !== id);
      return n;
    });
  }

  // 字幕・文字起こしの行 [{ s, e, text }]（読み込んでいなければ空）
  get cues() {
    return this.doc?.transcript?.cues || [];
  }

  // 音声認識の結果を1行追加する。key が同じ行（確定前に保存した同じ文の仮の行）は置き換える。
  // 同じ時間帯を聞き直したときは、前に認識した行（15秒以上前に作ったもの）を新しい結果で置き換える。
  // ファイルや貼り付けで読み込んだ行（live でないもの）は消さない
  upsertLiveCue(key, cue, name) {
    const now = Date.now();
    this.mutate((doc) => {
      if (!doc.transcript) doc.transcript = { name, cues: [] };
      const cues = doc.transcript.cues.filter((c) => {
        if (c.key === key) return false;
        if (!c.live || now - (c.at || 0) < 15000) return true;
        const overlap = Math.min(c.e, cue.e) - Math.max(c.s, cue.s);
        return overlap < 0.5 * Math.min(c.e - c.s, cue.e - cue.s);
      });
      cues.push({ ...cue, id: uid(), live: true, key, at: now, ...this.liveFlag() });
      cues.sort((a, b) => a.s - b.s || a.e - b.e);
      doc.transcript.cues = cues;
    }, { record: false });
  }

  // 字幕を丸ごと読み込む・外す（元に戻すの対象にしない）
  setTranscript(transcript) {
    if (transcript) withIds(transcript.cues);
    this.mutate((doc) => {
      doc.transcript = transcript;
    }, { record: false });
  }

  // ---- 字幕の行の編集（元に戻せる。音声認識中は、あとから届く行を消さないよう履歴を積まない） ----

  getCue(id) {
    return this.cues.find((c) => c.id === id) || null;
  }

  // 手で直した行は、音声認識の聞き直しで置き換えられないよう live を外す
  editCue(id, text, { record = true } = {}) {
    this.mutate(() => {
      const c = this.getCue(id);
      if (c) Object.assign(c, { text, live: false });
    }, { record, tx: true });
  }

  deleteCue(id, { record = true } = {}) {
    this.mutate((doc) => {
      if (doc.transcript) doc.transcript.cues = doc.transcript.cues.filter((c) => c.id !== id);
    }, { record, tx: true });
  }

  // 字幕全体の時刻をずらす（動画の音より字幕が遅いときはマイナス）
  shiftTranscript(delta, { record = true } = {}) {
    this.mutate((doc) => {
      const t = doc.transcript;
      if (!t) return;
      for (const c of t.cues) {
        const len = c.e - c.s;
        c.s = round2(Math.max(0, c.s + delta));
        c.e = round2(c.s + len);
      }
      t.offset = round2((t.offset || 0) + delta);
    }, { record, tx: true });
  }

  // 音声認識を始めるときは、字幕を含む履歴を消しておく（元に戻すで、あとから認識した行が消えないように）
  dropTranscriptUndo() {
    const strip = (s) => {
      const o = JSON.parse(s);
      delete o.transcript;
      return JSON.stringify(o);
    };
    this.undoStack = this.undoStack.map(strip);
    this.redoStack = this.redoStack.map(strip);
  }

  async open(meta) {
    let saved = null;
    try {
      saved = await this.kv.get(mediaKey(meta.id));
    } catch {}
    this.doc = saved && saved.version === 1 ? saved : emptyDoc(meta);
    if (this.doc.transcript) withIds(this.doc.transcript.cues);
    // タグ機能より前に保存された目印にも tags を用意しておく
    for (const m of this.doc.markers) {
      if (!Array.isArray(m.tags)) m.tags = [];
      if (typeof m.mark !== 'boolean') m.mark = guessMark(m);
    }
    // セルの「タイトル」は複数行のメモになった。以前のタイトルはメモとして引き継ぐ
    for (const c of this.doc.cells) {
      if (typeof c.memo !== 'string') c.memo = typeof c.title === 'string' ? c.title : '';
      delete c.title;
    }
    if (meta.title) this.doc.title = meta.title;
    if (meta.url) this.doc.url = meta.url;
    this.doc.source = meta.source;
    this.undoStack = [];
    this.redoStack = [];
    this.saveNow();
    this.emit('open');
  }

  close() {
    this.saveNow();
    this.doc = null;
    this.undoStack = [];
    this.redoStack = [];
  }

  setDuration(d) {
    if (!this.doc || !Number.isFinite(d) || d <= 0) return;
    if (Math.abs(this.doc.duration - d) < 0.01) return;
    this.doc.duration = d;
    this.scheduleSave();
    this.emit('duration');
  }

  // 履歴には目印とセルを残す。字幕を変える操作のときだけ字幕も残す（字幕は大きいので毎回は残さない）
  snapshot(withTranscript = false) {
    const o = { markers: this.doc.markers, cells: this.doc.cells, shares: this.doc.shares || [] };
    if (withTranscript) o.transcript = this.doc.transcript ?? null;
    return JSON.stringify(o);
  }

  // ドラッグ開始時など、変更の前に履歴だけ積む
  checkpoint(withTranscript = false) {
    if (!this.doc) return;
    this.undoStack.push(this.snapshot(withTranscript));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  mutate(fn, { record = true, tx = false } = {}) {
    if (!this.doc) return undefined;
    if (record) this.checkpoint(tx);
    const result = fn(this.doc);
    this.doc.updatedAt = Date.now();
    this.scheduleSave();
    this.emit('change');
    return result;
  }

  // 直接書き換えた内容を確定させる（履歴は積まない）
  touch() {
    this.mutate(() => {}, { record: false });
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.doc || !this.undoStack.length) return false;
    const s = JSON.parse(this.undoStack.pop());
    this.redoStack.push(this.snapshot('transcript' in s));
    Object.assign(this.doc, s);
    this.scheduleSave();
    this.emit('change');
    return true;
  }

  redo() {
    if (!this.doc || !this.redoStack.length) return false;
    const s = JSON.parse(this.redoStack.pop());
    this.undoStack.push(this.snapshot('transcript' in s));
    Object.assign(this.doc, s);
    this.scheduleSave();
    this.emit('change');
    return true;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    const doc = this.doc;
    if (!doc || !this.kv) return;
    const idx = this.index.filter((e) => e.id !== doc.id);
    idx.unshift({
      id: doc.id,
      title: doc.title,
      source: doc.source,
      url: doc.url,
      duration: doc.duration,
      markers: doc.markers.filter((m) => !m.src).length,
      cells: doc.cells.filter((c) => !c.src).length,
      updatedAt: doc.updatedAt,
    });
    this.index = idx.slice(0, 200);
    // IndexedDB は put を呼んだ時点の内容を保存するので、ここで待たなくてよい
    Promise.all([this.kv.set(mediaKey(doc.id), doc), this.kv.set('index', this.index)]).catch(() =>
      this.emit('saveError'),
    );
  }

  // ---- 単語帳（すべてのメディア共通） ----

  saveWords() {
    this.kv?.set('words', this.words).catch(() => this.emit('saveError'));
    this.emit('words');
  }

  addWord(word) {
    const w = { id: uid(), at: Date.now(), ...word };
    this.words.unshift(w);
    this.saveWords();
    return w;
  }

  updateWord(id, patch) {
    const w = this.words.find((x) => x.id === id);
    if (w) Object.assign(w, patch);
    this.saveWords();
  }

  deleteWord(id) {
    this.words = this.words.filter((x) => x.id !== id);
    this.saveWords();
  }

  // ---- 目印 ----

  getMarker(id) {
    return this.doc?.markers.find((m) => m.id === id) || null;
  }

  // 近くの自分の目印（いいね・コメントをまとめる先。共有で読み込んだ目印には付けない）
  nearestMarker(t, win) {
    let best = null;
    let bestD = Infinity;
    for (const m of this.doc?.markers || []) {
      if (m.src) continue;
      const d = Math.abs(m.t - t);
      if (d <= win && d < bestD) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  // init で最初からいいね・コメントを持たせると、元に戻すときも1回で消える
  addMarker(t, init = {}) {
    return this.mutate((doc) => {
      // mark: M や −N秒 で置いた「区間の区切り」になる目印か（いいね・コメントでできた目印は false）
      const m = { id: uid(), t: round2(t), mark: false, lv: 0, bm: false, tags: [], comments: [], at: Date.now(), ...this.liveFlag(), ...init };
      doc.markers.push(m);
      return m;
    });
  }

  updateMarker(id, patch) {
    return this.mutate(() => {
      const m = this.getMarker(id);
      if (m) Object.assign(m, patch);
      return m;
    });
  }

  deleteMarker(id) {
    this.mutate((doc) => {
      doc.markers = doc.markers.filter((m) => m.id !== id);
    });
  }

  // ---- セル ----

  getCell(id) {
    return this.doc?.cells.find((c) => c.id === id) || null;
  }

  // 同じ範囲の自分のセル
  findCell(s, e) {
    return this.ownCells.find((c) => Math.abs(c.s - s) < 0.05 && Math.abs(c.e - e) < 0.05) || null;
  }

  addCell(s, e) {
    const existing = this.findCell(s, e);
    if (existing) return { cell: existing, created: false };
    const cell = this.mutate((doc) => {
      const c = { id: uid(), s: round2(s), e: round2(e), memo: '', lv: 0, bm: false, comments: [], at: Date.now(), ...this.liveFlag() };
      doc.cells.push(c);
      return c;
    });
    return { cell, created: true };
  }

  // まとめて作る（文字起こしから自動で区切るとき）。すでに同じ範囲のセルがあれば作らない。元に戻すは1回で済む
  addCells(ranges) {
    const fresh = ranges.filter((r) => r.e - r.s >= 0.5 && !this.findCell(r.s, r.e));
    if (!fresh.length) return [];
    return this.mutate((doc) => {
      const made = fresh.map((r) => ({ id: uid(), s: round2(r.s), e: round2(r.e), memo: '', lv: 0, bm: false, comments: [], at: Date.now(), ...this.liveFlag() }));
      doc.cells.push(...made);
      return made;
    });
  }

  // 複数のセルを、最初の開始から最後の終了までの1つのセルにまとめる（元のセルは消える）。
  // メモは時間順に改行でつなぎ、コメントはすべて移し、いいねは一番高いものを残す
  mergeCells(ids) {
    const parts = this.ownCells.filter((c) => ids.includes(c.id)).sort((a, b) => a.s - b.s || a.e - b.e);
    if (parts.length < 2) return null;
    return this.mutate((doc) => {
      const merged = {
        id: uid(),
        s: Math.min(...parts.map((c) => c.s)),
        e: Math.max(...parts.map((c) => c.e)),
        memo: parts.map((c) => c.memo.trim()).filter(Boolean).join('\n'),
        lv: Math.max(...parts.map((c) => c.lv)),
        bm: parts.some((c) => c.bm),
        comments: parts.flatMap((c) => c.comments).sort((a, b) => (a.at || 0) - (b.at || 0) || (a.t || 0) - (b.t || 0)),
        at: Date.now(),
        ...(this.liveNow() || parts.every((c) => c.fromLive) ? { fromLive: true } : {}),
      };
      doc.cells = doc.cells.filter((c) => !ids.includes(c.id));
      doc.cells.push(merged);
      return merged;
    });
  }

  updateCell(id, patch) {
    return this.mutate(() => {
      const c = this.getCell(id);
      if (c) Object.assign(c, patch);
      return c;
    });
  }

  deleteCell(id) {
    this.mutate((doc) => {
      doc.cells = doc.cells.filter((c) => c.id !== id);
    });
  }

  // ---- コメント（目印・セル共通） ----

  getItem(kind, id) {
    return kind === 'cell' ? this.getCell(id) : this.getMarker(id);
  }

  addComment(kind, id, text, t, extra) {
    this.mutate(() => {
      const item = this.getItem(kind, id);
      if (item) item.comments.push(makeComment(text, t, extra));
    });
  }

  // ライブ配信などで X に書き込むときのハッシュタグ（動画ごと、# は付けずに持つ）
  setXTags(tags) {
    this.mutate((doc) => {
      doc.xTags = tags;
    }, { record: false });
  }

  deleteComment(kind, id, commentId) {
    this.mutate(() => {
      const item = this.getItem(kind, id);
      if (item) item.comments = item.comments.filter((c) => c.id !== commentId);
    });
  }

  // ---- ライブ配信 ----

  // ライブ配信として見たことを記録する（base: 再生位置 0 秒の実際の時刻、エポック秒）
  markLive(base) {
    this.mutate((doc) => {
      doc.live = { ...(doc.live || {}), base: round2(base), at: Date.now() };
    }, { record: false });
  }

  // ライブ中に作った目印・セル・字幕の行の数
  liveCounts() {
    const n = (list) => list.filter((x) => x.fromLive).length;
    return { markers: n(this.ownMarkers), cells: n(this.ownCells), cues: n(this.cues) };
  }

  // ライブ中に作ったものを delta 秒ずらす（アーカイブの時刻に合わせる）。
  // from を渡すと、その時刻より後ろのものだけ（アーカイブの途中がカットされていたとき）。元に戻せる
  shiftLive(delta, from = -Infinity) {
    const hit = (t) => t >= from - 0.01;
    const move = (t) => round2(Math.max(0, t + delta));
    const moveComments = (item) => {
      for (const c of item.comments) if (Number.isFinite(c.t)) c.t = move(c.t);
    };
    const moveRange = (x) => {
      const len = x.e - x.s;
      x.s = move(x.s);
      x.e = round2(x.s + len);
    };
    const withCues = this.cues.some((c) => c.fromLive && hit(c.s));
    return this.mutate((doc) => {
      let n = 0;
      for (const m of doc.markers) {
        if (!m.fromLive || !hit(m.t)) continue;
        m.t = move(m.t);
        moveComments(m);
        n++;
      }
      for (const c of doc.cells) {
        if (!c.fromLive || !hit(c.s)) continue;
        moveRange(c);
        moveComments(c);
        n++;
      }
      if (withCues) {
        for (const c of doc.transcript.cues) {
          if (!c.fromLive || !hit(c.s)) continue;
          moveRange(c);
          n++;
        }
        doc.transcript.cues.sort((a, b) => a.s - b.s || a.e - b.e);
      }
      return n;
    }, { tx: withCues });
  }

  // ライブ中の記録がアーカイブと合っていることを確かめた（案内を出さない）
  setLiveChecked(checked = true) {
    if (!this.doc?.live) return;
    this.mutate((doc) => {
      doc.live.checked = checked;
    }, { record: false });
  }

  // ---- 書き出し・読み込み ----

  exportData() {
    const d = this.doc;
    return {
      app: 'cells-player',
      version: 1,
      exportedAt: new Date().toISOString(),
      media: { id: d.id, title: d.title, source: d.source, url: d.url, duration: d.duration },
      // 自分のメモだけ（共有で読み込んだものは含めない）
      markers: d.markers.filter((m) => !m.src),
      cells: d.cells.filter((c) => !c.src),
      ...(d.transcript ? { transcript: d.transcript } : {}),
      ...(d.live ? { live: d.live } : {}),
    };
  }

  // 同じ id のものは上書きせずに飛ばし、新しいものだけ追加する
  importData(data) {
    const valid = (x) => x && typeof x === 'object' && typeof x.id === 'string';
    const markers = (Array.isArray(data.markers) ? data.markers : []).filter(
      (m) => valid(m) && Number.isFinite(m.t),
    );
    const cells = (Array.isArray(data.cells) ? data.cells : []).filter(
      (c) => valid(c) && Number.isFinite(c.s) && Number.isFinite(c.e) && c.e > c.s,
    );
    let addedM = 0;
    let addedC = 0;
    this.mutate((doc) => {
      const mIds = new Set(doc.markers.map((m) => m.id));
      const cIds = new Set(doc.cells.map((c) => c.id));
      for (const m of markers) {
        if (mIds.has(m.id)) continue;
        doc.markers.push({
          id: m.id,
          t: m.t,
          mark: typeof m.mark === 'boolean' ? m.mark : guessMark(m),
          lv: m.lv | 0,
          bm: !!m.bm,
          tags: Array.isArray(m.tags) ? m.tags.filter((x) => typeof x === 'string') : [],
          comments: Array.isArray(m.comments) ? m.comments : [],
          at: m.at || 0,
          ...(m.fromLive ? { fromLive: true } : {}),
        });
        addedM++;
      }
      for (const c of cells) {
        if (cIds.has(c.id)) continue;
        doc.cells.push({
          id: c.id,
          s: c.s,
          e: c.e,
          memo: String(c.memo ?? c.title ?? ''),
          lv: c.lv | 0,
          bm: !!c.bm,
          comments: Array.isArray(c.comments) ? c.comments : [],
          at: c.at || 0,
          ...(c.fromLive ? { fromLive: true } : {}),
        });
        addedC++;
      }
      // ライブ配信で付けた記録なら、その情報も引き継ぐ（アーカイブに合わせるときに使う）
      const lv = data.live;
      if (!doc.live && lv && typeof lv === 'object' && Number.isFinite(lv.base)) doc.live = { base: lv.base, at: lv.at || 0 };
      // 書き出したファイルに字幕が入っていて、いまのメディアにまだ字幕がなければ引き継ぐ
      const t = data.transcript;
      if (!doc.transcript && t && Array.isArray(t.cues) && t.cues.length) doc.transcript = { ...t, cues: withIds(t.cues) };
    });
    return { addedM, addedC };
  }
}
