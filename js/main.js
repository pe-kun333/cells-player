import { Store, DEFAULT_SETTINGS, loadSettings, saveSettings, makeComment } from './store.js';
import { storageEstimate } from './db.js';
import { Practice } from './practice.js';
import { Words } from './words.js';
import { TxTools } from './txtools.js';
import { LocalPlayer, YouTubePlayer, parseYouTubeId } from './players.js';
import { Timeline } from './timeline.js';
import { Moment } from './moment.js';
import { Sidebar } from './sidebar.js';
import { PresetDialog } from './presets.js';
import { CommentList } from './commentlist.js';
import { parseTranscript, isNotesJson, cueIndexAt } from './transcript.js';
import { Digest } from './digest.js';
import { LiveCaption } from './live.js';
import { Broadcast } from './broadcast.js';
import { ShareDialog, ShareLayers, decodeShare, shareIdOf, shareFromText } from './share.js';
import { $, clamp, fmt, round2, escapeHtml, icon, cellLabel } from './util.js';
import { tr, trMaybe, lang, isEn, translatePage } from './i18n.js';

$('#bootError').remove();
// 画面の文を表示の言語にする（英語のときだけ書き換わる）
translatePage();

const store = new Store();

const app = {
  store,
  settings: loadSettings(),
  player: null,
  ui: {
    target: null,   // { id, ref } いいね・コメントを付ける目印と、対象になった時の再生位置
    repeatId: null, // リピート中のセル（同時に1つ）
    expanded: new Set(),
    tab: 'cells',
    minLike: 0,
    bmOnly: false,
    tag: '',        // タグでの絞り込み
    commentPin: null, // コメントマークで固定した位置 { markerId, t, fromTarget, resume }
    query: '',              // サイドバーの検索語
    editingMemo: null,      // メモを編集中のセル
    commentsOpen: new Set(), // コメント欄を開いているカード
    selectedCells: new Set(), // 連結のために選んだセル
    pendingJump: null,        // 別のメディアを開いたら移動する場面 { mediaId, t }
    pendingShare: null,       // 共有リンクの中身（動画を開いたら「〇〇さんの共有」として加える）
    txOpen: new Set(),        // 文字起こしを開いているセル
    digestId: null,           // 連続再生でいま再生しているセル・目印
    flashId: null,
  },
  activeCells: new Set(), // 再生位置を含むセル
  nearId: null,           // 再生位置の近く（まとめる範囲内）の目印
};

app.now = () => (app.player ? app.player.getTime() : 0);
app.duration = () => app.player?.getDuration() || store.doc?.duration || 0;
app.activePresetSet = () =>
  app.settings.presetSets.find((s) => s.id === app.settings.activePresetSet) || app.settings.presetSets[0];

// 目印のアイコンに出す、定型コメントのキー番号（4〜9）。いまのセットを優先し、なければ他のセットから探す。
// 名前を変えて今はどのボタンにもないタグには番号を出さない
app.tagNumbers = (tags) => {
  if (!tags || !tags.length) return [];
  const sets = [app.activePresetSet(), ...app.settings.presetSets];
  const nums = new Set();
  for (const tag of tags) {
    for (const s of sets) {
      const i = s.items.indexOf(tag);
      if (i >= 0) {
        nums.add(i + 4);
        break;
      }
    }
  }
  return [...nums].sort((a, b) => a - b);
};

const timeline = new Timeline(app);
const moment = new Moment(app);
const sidebar = new Sidebar(app);
const commentList = new CommentList(app);
const digest = new Digest(app);
const live = new LiveCaption(app);
const practice = new Practice(app);
const words = new Words(app);
const txtools = new TxTools(app);
const broadcast = new Broadcast(app);
const shareDialog = new ShareDialog(app);
const shareLayers = new ShareLayers(app);
// ライブ配信を見ている間に作った目印・セルには印を付ける（あとでアーカイブの時刻に合わせるため）
store.liveNow = () => !!app.player?.isLive();
let txIndex = -2; // いま表示・強調している字幕の行（変わったときだけ描き直す）

app.hint = (msg, sticky) => moment.hint(msg, sticky);
app.sidebarItems = () => (store.doc ? sidebar.items() : []);

// 連続再生で次の区切りに進んだとき: サイドバーのカードを強調して見える位置へ
app.onDigestClip = (id) => {
  sidebar.updateActive();
  if (!id) return;
  document.querySelector(`#sideList .card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 4500);
}
app.toast = toast;

function requireMedia() {
  if (app.player && store.doc) return true;
  toast(tr('先に動画か音声を開いてください'));
  return false;
}

function renderAll() {
  timeline.render();
  moment.render();
  sidebar.render();
  commentList.render();
  shareLayers.render();
  updateCaptionButton();
  txIndex = -2; // 字幕の表示を次の監視で描き直す
  $('#btnUndo').disabled = !store.canUndo;
  $('#btnRedo').disabled = !store.canRedo;
}

store.subscribe((reason) => {
  if (reason === 'saveError') {
    toast(tr('保存できませんでした（ブラウザの保存容量がいっぱいの可能性があります）'));
    return;
  }
  if (reason === 'words') {
    words.refresh();
    return;
  }
  // 長さが分かった・伸びた（ライブ配信）ときは、タイムラインだけ描き直す
  if (reason === 'duration') {
    timeline.render();
    return;
  }
  if (app.ui.repeatId && !store.getCell(app.ui.repeatId)) app.stopRepeat();
  for (const id of app.ui.selectedCells) if (!store.getCell(id)) app.ui.selectedCells.delete(id);
  if (app.ui.target && !store.getMarker(app.ui.target.id)) app.ui.target = null;
  renderAll();
});

// ---- 再生操作 ----

let lastSeekAt = 0;
let seekTimer = null;
app.seek = (t) => {
  const p = app.player;
  if (!p) return;
  t = clamp(t, 0, app.duration() || Infinity);
  if (p.kind !== 'youtube') {
    p.seek(t);
    return;
  }
  // YouTube は連続で seek すると重いので間引く
  clearTimeout(seekTimer);
  const wait = 120 - (performance.now() - lastSeekAt);
  if (wait <= 0) {
    lastSeekAt = performance.now();
    p.seek(t);
  } else {
    seekTimer = setTimeout(() => {
      lastSeekAt = performance.now();
      p.seek(t);
    }, wait);
  }
};

// 止まっていれば再生を始める（再生中ならそのまま）
app.playNow = () => {
  if (app.player && app.player.paused) app.player.play();
};

// 移動ボタンのダブルクリック: 同じボタンを 0.45 秒以内に2回押したら再生も始める。
// クリックで一覧が描き直されても判定できるよう、要素ではなくボタンの種類と対象で見分ける
let lastJump = { key: '', at: 0 };
app.noteJump = (key) => {
  const now = performance.now();
  const double = key === lastJump.key && now - lastJump.at < 450;
  lastJump = double ? { key: '', at: 0 } : { key, at: now };
  if (double) app.playNow();
};

function togglePlay() {
  const p = app.player;
  if (!p) return;
  if (p.paused) p.play();
  else p.pause();
}

function updatePlayButton() {
  const paused = !app.player || app.player.paused;
  const b = $('#btnPlay');
  b.innerHTML = icon(paused ? 'play' : 'pause');
  b.setAttribute('aria-label', paused ? tr('再生') : tr('一時停止'));
}

// ---- 対象の目印 ----

// 対象は M・−N秒・目印のクリックで「選んだ」目印だけ。
// 選んだ目印には、その後のいいね・ブックマーク・定型コメント・コメントがそれぞれ1回ずつ付く。
// liked / bookmarked / commented: その操作が済んだか。tagged: 付けた定型コメントの名前の配列。
// 済んだ操作をもう一度したときや、選んでいないときは、押した瞬間に付く（2秒以内の目印にはまとめる）
app.setTarget = (id, ref = app.now(), flags = {}) => {
  const prev = app.ui.target && app.ui.target.id === id ? app.ui.target : null;
  app.ui.target = {
    id,
    ref,
    liked: prev ? prev.liked : false,
    bookmarked: prev ? prev.bookmarked : false,
    tagged: prev ? prev.tagged : [],
    commented: prev ? prev.commented : false,
    ...flags,
  };
  broadcast.notePick(id);
  renderAll();
};

const FRESH = { liked: false, bookmarked: false, tagged: [], commented: false };

// 操作を付けたあと: 選んだ対象に付けたなら「済み」を記録し、そうでなければ対象を外す。
// 対象でいられる範囲は、選んだ時点の再生位置から数える（操作するたびに延ばさない）
function settle(m, now, flags) {
  if (flags) {
    const tg = app.ui.target;
    app.setTarget(m.id, tg && tg.id === m.id ? tg.ref : now, flags);
  } else {
    app.ui.target = null;
    renderAll();
  }
}

app.onPinChange = () => renderAll();

app.releaseTarget = () => {
  if (!app.ui.target) return;
  app.ui.target = null;
  renderAll();
};

// いま、いいね・コメントがどの目印に付くか（対象 → 近くの目印 → なし）
// （共有で読み込んだ目印は編集しないので、対象にしていても付け先にはしない）
app.effectiveMarker = (now = app.now()) => {
  const tg = app.ui.target && store.getMarker(app.ui.target.id);
  if (tg && !tg.src) return { marker: tg, kind: 'target' };
  const near = store.nearestMarker(now, app.settings.mergeWindow);
  return near ? { marker: near, kind: 'near' } : null;
};

// 付け先（その操作がまだ済んでいない対象 → 近くの目印 → なし）。t は新しく目印を作るときの時刻。
// 共有で読み込んだ目印を対象にしていたら、その目印は変えずに、同じ時刻の自分の目印に付ける
function destFor(flag, now) {
  const tg = app.ui.target;
  const m = tg && !tg[flag] ? store.getMarker(tg.id) : null;
  if (m && !m.src) return { marker: m, fromTarget: true, t: now };
  const t = m ? m.t : now;
  return { marker: store.nearestMarker(t, app.settings.mergeWindow), fromTarget: false, t };
}
app.commentDest = (now = app.now()) => destFor('commented', now);
app.likeMarker = (now = app.now()) => destFor('liked', now).marker;
app.bookmarkMarker = (now = app.now()) => destFor('bookmarked', now).marker;

// 定型コメントは1つの目印に何種類も付けたいので、対象に付けた名前ごとに「済み」を覚える
function tagDest(tag, now) {
  const tg = app.ui.target;
  const m = tg && !tg.tagged.includes(tag) ? store.getMarker(tg.id) : null;
  if (m && !m.src) return { marker: m, fromTarget: true, t: now };
  const t = m ? m.t : now;
  return { marker: store.nearestMarker(t, app.settings.mergeWindow), fromTarget: false, t };
}
app.tagMarker = (tag, now = app.now()) => tagDest(tag, now).marker;

function applyMoment(flag, now, update, init) {
  const { marker, fromTarget, t } = destFor(flag, now);
  let m = marker;
  if (m) store.updateMarker(m.id, update(m));
  else m = store.addMarker(t, init);
  settle(m, now, fromTarget ? { [flag]: true } : null);
  return m;
}

// lead: true なら、設定の秒数だけ少し前から再生する（対象はその目印のまま）
app.focusMarker = (id, lead = false) => {
  const m = store.getMarker(id);
  if (!m) return;
  app.seek(lead ? app.leadTime(m.t) : m.t);
  // YouTube は移動に少し時間がかかるので、移動し終わるまでは「離れたので外す」をしない
  app.setTarget(id, m.t, { ...FRESH, holdUntil: performance.now() + 1500 });
};

app.leadTime = (t) => Math.max(0, t - app.settings.leadIn);

// ---- 目印 ----

app.markAt = (t, { offset = 0 } = {}) => {
  if (!requireMedia()) return null;
  t = clamp(t, 0, app.duration());
  const near = store.nearestMarker(t, app.settings.mergeWindow);
  let m;
  if (near) {
    // いいね・コメントだけの目印でも、M を押したら区間の区切りにする
    m = near;
    if (!m.mark) store.updateMarker(m.id, { mark: true });
    app.hint(tr('近くの目印（{time}）を対象にしました', { time: fmt(m.t, true) }));
  } else {
    m = store.addMarker(t, { mark: true });
    app.hint(
      offset
        ? tr('{s}秒前（{time}）に目印を付けました', { s: offset, time: fmt(m.t, true) })
        : tr('{time} に目印を付けました', { time: fmt(m.t, true) }),
    );
  }
  app.setTarget(m.id, app.now(), FRESH);
  return m;
};

app.rateMoment = (lv) => {
  if (!requireMedia()) return;
  const m = applyMoment('liked', app.now(), (x) => ({ lv: x.lv === lv ? 0 : lv }), { lv });
  app.hint(
    m.lv
      ? tr('{time} の目印にいいね {lv} を付けました', { time: fmt(m.t, true), lv: m.lv })
      : tr('{time} の目印のいいねを外しました', { time: fmt(m.t, true) }),
  );
};

app.toggleMomentBookmark = () => {
  if (!requireMedia()) return;
  const m = applyMoment('bookmarked', app.now(), (x) => ({ bm: !x.bm }), { bm: true });
  app.hint(
    m.bm
      ? tr('{time} の目印をブックマークしました', { time: fmt(m.t, true) })
      : tr('{time} のブックマークを外しました', { time: fmt(m.t, true) }),
  );
};

// ---- よく使うコメント（タグ） ----

app.setPresetSet = (id) => {
  if (!app.settings.presetSets.some((s) => s.id === id)) return;
  app.settings.activePresetSet = id;
  saveSettings(app.settings);
  moment.renderQuick();
  renderAll(); // 目印のアイコンのキー番号もセットに合わせて変わる
  app.hint(tr('よく使うコメントを「{name}」に切り替えました', { name: app.activePresetSet().name }));
};

// 付いていなければ付け、付いていれば外す
app.toggleQuickTag = (index) => {
  if (!requireMedia()) return;
  const tag = app.activePresetSet().items[index] || '';
  if (!tag) {
    app.hint(tr('このボタンはまだ空いています（鉛筆ボタンから登録できます）'));
    return;
  }
  const now = app.now();
  const { marker, fromTarget, t: at } = tagDest(tag, now);
  let m = marker;
  if (m) store.updateMarker(m.id, { tags: m.tags.includes(tag) ? m.tags.filter((t) => t !== tag) : [...m.tags, tag] });
  else m = store.addMarker(at, { tags: [tag] });
  settle(m, now, fromTarget ? { tagged: [...app.ui.target.tagged, tag] } : null);
  app.hint(
    m.tags.includes(tag)
      ? tr('{time} の目印に「{tag}」を付けました', { time: fmt(m.t, true), tag })
      : tr('{time} の目印から「{tag}」を外しました', { time: fmt(m.t, true), tag }),
  );
};

// pin: コメントマークで固定した位置 { markerId, t }。目印はここで（送信した時点で）作る
app.commentAt = (text, pin) => {
  if (!requireMedia()) return;
  let m = pin?.markerId ? store.getMarker(pin.markerId) : null;
  const t = clamp(pin ? pin.t : app.now(), 0, app.duration());
  if (!m) m = store.nearestMarker(t, app.settings.mergeWindow);
  if (m) store.addComment('marker', m.id, text, m.t);
  else m = store.addMarker(t, { comments: [makeComment(text, t)] });
  settle(m, app.now(), pin?.fromTarget ? { commented: true } : null);
  app.hint(tr('{time} の目印にコメントしました', { time: fmt(m.t, true) }));
};

app.moveMarker = (id, t) => {
  store.updateMarker(id, { t: round2(clamp(t, 0, app.duration())) });
};

function nudgeTarget(d) {
  const eff = app.effectiveMarker();
  if (!eff) {
    app.hint(tr('動かす目印がありません（目印をクリックして対象にしてください）'));
    return;
  }
  const m = eff.marker;
  app.moveMarker(m.id, m.t + d);
  app.setTarget(m.id);
  app.hint(tr('目印を {time} に動かしました', { time: fmt(m.t, true) }));
}

function deleteTargetMarker() {
  const eff = app.effectiveMarker();
  if (!eff) return;
  store.deleteMarker(eff.marker.id);
  app.hint(tr('目印を削除しました（Ctrl+Z で元に戻せます）'));
}

function jumpMarker(dir) {
  const now = app.now();
  const sorted = [...store.markers].sort((a, b) => a.t - b.t);
  const m = dir > 0 ? sorted.find((x) => x.t > now + 0.05) : [...sorted].reverse().find((x) => x.t < now - 0.3);
  if (m) app.focusMarker(m.id);
}

function frameStep(dir) {
  const p = app.player;
  if (!p.canFrameStep) {
    app.hint(tr('YouTube ではコマ送りは使えません'));
    return;
  }
  p.pause();
  app.seek(app.now() + dir / 30);
}

// ---- セル ----

app.createCell = (s, e) => {
  if (!requireMedia()) return;
  if (e - s < 0.1) {
    app.hint(tr('区間が短すぎます'));
    return;
  }
  const { cell, created } = store.addCell(s, e);
  app.revealCell(cell.id);
  app.hint(created ? tr('{range} をセルにしました', { range: `${fmt(s)} – ${fmt(e)}` }) : tr('このセルはもうあります'));
};

// 再生位置を挟む前後の目印の間をセルにする
app.makeCellHere = () => {
  if (!requireMedia()) return;
  const now = app.now();
  const pts = timeline.boundaries();
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1] <= now) i++;
  app.createCell(pts[i], pts[i + 1]);
};

app.revealCell = (id) => {
  const c = store.getCell(id);
  if (!c) return;
  if (app.ui.tab === 'markers') app.ui.tab = 'cells';
  if (!sidebar.passes(c, 'cell') || !sidebar.matchesQuery(c, 'cell')) {
    app.ui.minLike = 0;
    app.ui.bmOnly = false;
    app.ui.tag = '';
    app.ui.query = '';
    $('#sideSearch').value = '';
  }
  app.ui.flashId = id;
  sidebar.render();
};

app.toggleCellSelect = (id) => {
  if (store.getCell(id)?.src) {
    app.hint(tr('共有されたセルは選べません（取り込むと選べます）'));
    return;
  }
  const sel = app.ui.selectedCells;
  if (sel.has(id)) sel.delete(id);
  else sel.add(id);
  renderAll();
};

app.clearCellSelect = () => {
  if (!app.ui.selectedCells.size) return;
  app.ui.selectedCells.clear();
  renderAll();
};

app.mergeSelectedCells = () => {
  const ids = [...app.ui.selectedCells].filter((id) => store.getCell(id));
  if (ids.length < 2) {
    app.hint(tr('連結するセルを2つ以上選んでください'));
    return;
  }
  const parts = ids.map((id) => store.getCell(id)).sort((a, b) => a.s - b.s);
  // 選んだセルの間に、どれにも入っていない時間があるか
  let gap = false;
  let end = parts[0].e;
  for (const c of parts.slice(1)) {
    if (c.s > end + 0.05) gap = true;
    end = Math.max(end, c.e);
  }
  const wasRepeat = ids.includes(app.ui.repeatId);
  const hadComments = ids.some((id) => app.ui.commentsOpen.has(id));
  app.ui.selectedCells.clear();
  if (ids.includes(app.ui.editingMemo)) app.ui.editingMemo = null;
  const merged = store.mergeCells(ids);
  if (!merged) return;
  if (wasRepeat) app.ui.repeatId = merged.id;
  if (hadComments) app.ui.commentsOpen.add(merged.id);
  app.revealCell(merged.id);
  app.hint(
    tr('{n}つのセルを {range} に連結しました', { n: ids.length, range: `${fmt(merged.s)} – ${fmt(merged.e)}` }) +
      (gap ? tr('（間の部分も含めています）') : '') +
      tr('。Ctrl+Z で元に戻せます'),
  );
};

app.moveCellEdge = (id, edge, value) => {
  const c = store.getCell(id);
  if (!c) return;
  if (edge === 's') store.updateCell(id, { s: round2(clamp(value, 0, c.e - 0.1)) });
  else store.updateCell(id, { e: round2(clamp(value, c.s + 0.1, app.duration())) });
};

// ---- 連続再生・練習・リピートは同時に1つだけ ----

app.stopModes = (except) => {
  if (except !== 'digest' && digest.active) digest.stop();
  if (except !== 'practice' && practice.active) practice.stop();
  if (except !== 'repeat') app.stopRepeat();
};

// ---- リピート（回数・ループの間の無音・だんだん速く） ----

const RAMP_FROM = 0.7; // 「だんだん速く」の最初の速度
const RAMP_STEP = 0.1; // 1回ごとに上げる速度
const repeatState = { loops: 0, timer: null, baseRate: 1 };

function currentRate() {
  return Number($('#rateSelect').value) || 1;
}

// 使える速度のうち一番近いものにする（YouTube は選べる速度が決まっている）
app.setRate = (r) => {
  const p = app.player;
  if (!p) return 1;
  const rates = p.getRates();
  const best = rates.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), rates[0]);
  p.setRate(best);
  $('#rateSelect').value = String(best);
  return best;
};

function startRepeatState() {
  clearTimeout(repeatState.timer);
  repeatState.loops = 0;
  repeatState.baseRate = currentRate();
  if (app.settings.repeatRamp) app.setRate(Math.min(RAMP_FROM, repeatState.baseRate));
  renderRepeatBar();
}

function endRepeatState() {
  clearTimeout(repeatState.timer);
  if (app.settings.repeatRamp && app.player) app.setRate(repeatState.baseRate);
  repeatState.loops = 0;
  renderRepeatBar();
}

app.stopRepeat = () => {
  if (!app.ui.repeatId) return;
  app.ui.repeatId = null;
  endRepeatState();
  renderAll();
};

// セルの終わりまで来たとき（main の監視から呼ぶ）
function onRepeatLoop(c) {
  const p = app.player;
  const s = app.settings;
  repeatState.loops++;
  if (s.repeatCount && repeatState.loops >= s.repeatCount) {
    p.pause();
    app.stopRepeat();
    app.hint(tr('{n} 回くり返したので、リピートを終えました', { n: s.repeatCount }));
    return;
  }
  if (s.repeatRamp) app.setRate(Math.min(repeatState.baseRate, RAMP_FROM + repeatState.loops * RAMP_STEP));
  app.seek(c.s);
  if (s.repeatGap > 0) {
    // 頭に戻ってから少し待つ（聞いたことを口に出す時間）
    p.pause();
    clearTimeout(repeatState.timer);
    repeatState.timer = setTimeout(() => {
      if (app.ui.repeatId === c.id && app.player === p) p.play();
    }, s.repeatGap * 1000);
  }
  renderRepeatBar();
}

function renderRepeatBar() {
  const bar = $('#repeatBar');
  const c = app.ui.repeatId && store.getCell(app.ui.repeatId);
  bar.hidden = !c;
  if (!c) return;
  const s = app.settings;
  const opt = (values, cur, label) => values.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label(v)}</option>`).join('');
  const nth = s.repeatCount
    ? tr('{i} / {n} 回目', { i: repeatState.loops + 1, n: s.repeatCount })
    : tr('{i} 回目', { i: repeatState.loops + 1 });
  bar.innerHTML = `
    <span class="rp-state">${icon('repeat')}${tr('リピート {nth}', { nth })}</span>
    <label>${tr('回数')} <select data-rp="count">${opt([0, 2, 3, 5, 10, 20], s.repeatCount, (v) => (v ? tr('{n}回', { n: v }) : tr('ずっと')))}</select></label>
    <label>${tr('間')} <select data-rp="gap">${opt([0, 1, 2, 3, 5], s.repeatGap, (v) => (v ? tr('{s}秒', { s: v }) : tr('なし')))}</select></label>
    <label class="rp-ramp" title="${tr('{from}倍から始めて、1回ごとに {step} ずつ元の速さまで上げる', { from: RAMP_FROM, step: RAMP_STEP })}"><input type="checkbox" data-rp="ramp"${s.repeatRamp ? ' checked' : ''}> ${tr('だんだん速く')}</label>
    <button data-rp="stop" title="${tr('リピートを止める')}">${icon('x')}${tr('停止')}</button>`;
}

$('#repeatBar').addEventListener('change', (e) => {
  const k = e.target.dataset.rp;
  const s = app.settings;
  if (k === 'count') s.repeatCount = Number(e.target.value);
  else if (k === 'gap') s.repeatGap = Number(e.target.value);
  else if (k === 'ramp') {
    s.repeatRamp = e.target.checked;
    // 途中で切り替えたときは、いまの回数に合わせた速さにする／元の速さに戻す
    if (s.repeatRamp) {
      repeatState.baseRate = currentRate();
      app.setRate(Math.min(repeatState.baseRate, RAMP_FROM + repeatState.loops * RAMP_STEP));
    } else {
      app.setRate(repeatState.baseRate);
    }
  }
  saveSettings(s);
  e.target.blur();
  renderRepeatBar();
});
$('#repeatBar').addEventListener('click', (e) => {
  if (e.target.closest('[data-rp="stop"]')) {
    app.stopRepeat();
    app.hint(tr('リピートを止めました'));
  }
});

app.toggleRepeat = (id) => {
  if (app.ui.repeatId === id) {
    app.stopRepeat();
    app.hint(tr('リピートを止めました'));
    return;
  }
  const c = store.getCell(id);
  if (!c) return;
  app.stopModes('repeat');
  if (app.ui.repeatId) endRepeatState(); // 別のセルのリピートから切り替えるとき
  app.ui.repeatId = id;
  startRepeatState();
  const now = app.now();
  if (now < c.s || now >= c.e - 0.05) app.seek(c.s);
  app.player.play();
  app.hint(tr('「{name}」をリピート再生します', { name: cellLabel(c, 20) || `${fmt(c.s)} – ${fmt(c.e)}` }));
  renderAll();
};

function toggleRepeatHere() {
  if (app.ui.repeatId) {
    app.toggleRepeat(app.ui.repeatId);
    return;
  }
  const now = app.now();
  const inner = store.cells
    .filter((c) => now >= c.s && now < c.e)
    .sort((a, b) => a.e - a.s - (b.e - b.s))[0];
  if (inner) app.toggleRepeat(inner.id);
  else app.hint(tr('再生位置を含むセルがありません'));
}

// ---- メディアを開く ----

const stageMedia = $('#stageMedia');
let cleanupMedia = null;
let openSeq = 0;

function closeMedia() {
  if (app.player) {
    try {
      app.player.destroy();
    } catch {}
    app.player = null;
  }
  stageMedia.innerHTML = '';
  if (cleanupMedia) {
    cleanupMedia();
    cleanupMedia = null;
  }
  if (store.doc) store.close();
  app.ui.target = null;
  app.ui.repeatId = null;
  clearTimeout(repeatState.timer);
  repeatState.loops = 0;
  renderRepeatBar();
  if (practice.active) practice.stop();
  app.ui.commentPin = null;
  app.ui.editingMemo = null;
  app.ui.commentsOpen.clear();
  app.ui.selectedCells.clear();
  app.ui.txOpen.clear();
  if (digest.active) digest.stop();
  if (live.active) live.stop();
  broadcast.reset();
  $('#commentInput').value = '';
  app.ui.expanded.clear();
  app.activeCells = new Set();
  app.nearId = null;
  document.body.classList.remove('has-media');
  $('#audioCover').hidden = true;
  $('#caption').hidden = true;
  $('#modeBadge').hidden = true;
  $('#mediaTitle').textContent = '';
  updatePlayButton();
}

function showEmpty() {
  renderRecent();
  $('#emptyState').hidden = false;
  renderAll();
}

async function openMedia(meta, makePlayer, src, cleanup) {
  const seq = ++openSeq;
  closeMedia();
  const player = makePlayer(stageMedia);
  app.player = player;
  cleanupMedia = cleanup || null;
  $('#emptyState').hidden = true;
  document.body.classList.add('is-loading');
  try {
    await player.load(src);
  } catch (err) {
    if (seq !== openSeq) return;
    document.body.classList.remove('is-loading');
    toast(err.message);
    closeMedia();
    showEmpty();
    return;
  }
  if (seq !== openSeq) return;
  document.body.classList.remove('is-loading');

  if (player.kind === 'youtube') meta.title = player.getTitle() || meta.title;
  await store.open(meta);
  if (seq !== openSeq) return;
  store.setDuration(player.getDuration());

  player.on('play', updatePlayButton);
  player.on('pause', updatePlayButton);
  player.on('durationchange', () => store.setDuration(player.getDuration()));
  player.on('error', (msg) => toast(msg));
  player.on('ended', () => {
    if (digest.onEnded()) return;
    if (practice.onEnded()) return;
    const c = app.ui.repeatId && store.getCell(app.ui.repeatId);
    if (c && c.e >= app.duration() - 0.5) {
      onRepeatLoop(c);
      if (app.ui.repeatId === c.id && !app.settings.repeatGap) player.play();
    }
  });

  document.body.classList.add('has-media');
  $('#mediaTitle').textContent = store.doc.title;
  $('#mediaTitle').title = store.doc.title;
  $('#modeBadge').hidden = player.kind !== 'youtube';
  $('#audioCover').hidden = !player.isAudioOnly();
  $('#audioTitle').textContent = store.doc.title;
  $('#rateSelect').innerHTML = player
    .getRates()
    .map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r}x</option>`)
    .join('');
  player.setVolume(app.settings.volume);
  updatePlayButton();
  renderAll();
  const n = store.cells.length + store.markers.length;
  if (n) app.hint(tr('保存されていたセル {c} 件・目印 {m} 件を読み込みました', { c: store.cells.length, m: store.markers.length }));
  applyPendingShare();
  // 単語帳から別のメディアの場面へ移動しようとしていたら、開いたところでその位置へ
  const jump = app.ui.pendingJump;
  if (jump && jump.mediaId === store.doc.id) {
    app.ui.pendingJump = null;
    app.seek(jump.t);
  }
}

// ---- 共有リンクを開く ----

// リンクの中身を読み、その動画を開いてから「〇〇さんの共有」として加える
async function openShare(encoded) {
  let data;
  try {
    data = await decodeShare(encoded);
  } catch {
    toast(tr('共有リンクを読み込めませんでした（リンクが途中で切れている可能性があります）'));
    return;
  }
  app.ui.pendingShare = { ...data, id: await shareIdOf(encoded) };
  const docId = data.y ? 'yt:' + data.y : 'u:' + data.u;
  if (store.doc?.id === docId && app.player) applyPendingShare();
  else if (data.y) openYouTube(data.y);
  else openUrl(data.u);
}

function applyPendingShare() {
  const sh = app.ui.pendingShare;
  if (!sh || !store.doc) return;
  if (store.doc.id !== (sh.y ? 'yt:' + sh.y : 'u:' + sh.u)) return;
  app.ui.pendingShare = null;
  const added = store.addShare({ id: sh.id, by: sh.by, at: sh.at, title: sh.title }, sh.markers, sh.cells);
  if (sh.st) app.seek(sh.st);
  toast(
    added
      ? tr('{name} さんの共有（セル {c}・目印 {m}）を読み込みました。色付きで並びます', { name: sh.by, c: sh.cells.length, m: sh.markers.length })
      : tr('{name} さんのこの共有は、もう読み込んであります', { name: sh.by }),
  );
}

// アドレスの # より後ろに共有の中身があれば開く（開いたら消して、読み込み直しで何度も開かないようにする）
function openShareFromHash() {
  const enc = shareFromText(location.hash);
  if (!enc) return false;
  history.replaceState(null, '', location.pathname + location.search);
  openShare(enc);
  return true;
}
window.addEventListener('hashchange', openShareFromHash);

// 単語帳などから、別のメディアの場面へ移動する（URL で開けるものは開き、ファイルは開き直してもらう）
app.jumpToMedia = (mediaId, url, t, title) => {
  if (store.doc && store.doc.id === mediaId) {
    app.seek(t);
    return;
  }
  app.ui.pendingJump = { mediaId, t };
  if (url) openFromText(url);
  else toast(tr('「{title}」のファイルを開くと、その場面に移動します', { title }));
};

// ファイルの先頭 1MB とサイズから ID を作る（名前を変えても同じメモが開く）
async function fileId(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
    const size = new TextEncoder().encode(':' + file.size);
    const buf = new Uint8Array(head.length + size.length);
    buf.set(head);
    buf.set(size, head.length);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return 'f:' + [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `n:${file.name}:${file.size}`;
  }
}

const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac)$/i;

async function openLocalFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) {
    importJsonFile(file);
    return;
  }
  if (/\.(srt|vtt|txt)$/i.test(file.name)) {
    loadTranscriptFile(file);
    return;
  }
  if (!/^(video|audio)\//.test(file.type) && !MEDIA_EXT.test(file.name)) {
    toast(tr('動画または音声のファイルを選んでください'));
    return;
  }
  const id = await fileId(file);
  const url = URL.createObjectURL(file);
  await openMedia({ id, title: file.name, source: 'local' }, (c) => new LocalPlayer(c), url, () => URL.revokeObjectURL(url));
}

function openYouTube(videoId) {
  return openMedia(
    { id: 'yt:' + videoId, title: `YouTube ${videoId}`, source: 'youtube', url: `https://www.youtube.com/watch?v=${videoId}` },
    (c) => new YouTubePlayer(c),
    videoId,
  );
}

function openUrl(url) {
  let title = url;
  try {
    const u = new URL(url);
    title = decodeURIComponent(u.pathname.split('/').pop() || u.hostname);
  } catch {}
  return openMedia({ id: 'u:' + url, title, source: 'url', url }, (c) => new LocalPlayer(c), url);
}

function openFromText(text) {
  const s = text.trim();
  if (!s) return;
  const shared = shareFromText(s);
  if (shared) {
    openShare(shared);
    return;
  }
  const yt = parseYouTubeId(s);
  if (yt) {
    openYouTube(yt);
    return;
  }
  // チャンネルの「ライブ」ページの URL からは、いまの配信の動画を知ることができない
  if (/^https?:\/\/(www\.|m\.)?youtube\.com\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(live|streams)\/?(\?.*)?$/i.test(s)) {
    toast(tr('チャンネルのページの URL では開けません。配信の画面を開いて、その URL（…/watch?v=… か …/live/…）を貼ってください'));
    return;
  }
  try {
    const u = new URL(s, location.href);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      openUrl(u.href);
      return;
    }
  } catch {}
  toast(tr('URL を確認してください'));
}

function renderRecent() {
  const list = store.recent().slice(0, 8);
  const el = $('#recentList');
  if (!list.length) {
    el.innerHTML = '';
    return;
  }
  const kindLabel = { youtube: 'YouTube', url: 'URL', local: tr('ファイル') };
  el.innerHTML =
    `<div class="recent-head">${tr('最近のメディア')}</div>` +
    list
      .map((r) => {
        const canOpen = r.source !== 'local' && r.url;
        const tag = canOpen ? 'button' : 'div';
        const attrs = canOpen
          ? `data-url="${escapeHtml(r.url)}" title="${tr('クリックで開く')}"`
          : `title="${tr('同じファイルを開くと、メモが復元されます')}"`;
        return `<${tag} class="recent-item${canOpen ? ' can-open' : ''}" ${attrs}>
          <span class="recent-kind">${kindLabel[r.source] || ''}</span>
          <span class="recent-title">${escapeHtml(r.title)}</span>
          <span class="recent-count">${tr('セル {c}・目印 {m}', { c: r.cells, m: r.markers })}</span>
        </${tag}>`;
      })
      .join('');
}

$('#recentList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-url]');
  if (b) openFromText(b.dataset.url);
});

// ---- 字幕・文字起こし ----

function applyTranscript(cues, name) {
  store.setTranscript({ name, cues });
  renderAll();
  toast(
    tr('字幕「{name}」を読み込みました（{n} 行）。セルの「文字起こし」でその区間の文字を見られます', { name: trMaybe(name), n: cues.length }) +
      (app.settings.captions ? '' : tr('（動画の上の字幕は非表示にしています。T キーで表示）')),
  );
}

async function loadTranscriptFile(file) {
  if (!requireMedia()) return;
  let cues;
  try {
    cues = parseTranscript(await file.text(), file.name);
  } catch (err) {
    toast(err.message);
    return;
  }
  applyTranscript(cues, file.name);
}

// ---- 貼り付けで読み込む ----

const pasteForm = $('#pasteForm');
let pasteTimer = null;

function previewPaste() {
  const el = $('#pastePreview');
  const text = pasteForm.text.value;
  el.classList.remove('is-error');
  if (!text.trim()) {
    el.textContent = '';
    return null;
  }
  try {
    const cues = parseTranscript(text, '');
    const sample = cues
      .slice(0, 3)
      .map((c) => `${fmt(c.s)} ${c.text.replace(/\n/g, ' ').slice(0, 28)}`)
      .join('\n');
    el.textContent =
      tr('{n} 行を読み取りました（{from} 〜 {to}）', { n: cues.length, from: fmt(cues[0].s), to: fmt(cues[cues.length - 1].s) }) +
      `\n${sample}${cues.length > 3 ? '\n…' : ''}`;
    return cues;
  } catch (err) {
    el.classList.add('is-error');
    el.textContent = err.message;
    return null;
  }
}

function openPasteDialog(text = '') {
  if (!requireMedia()) return;
  pasteForm.text.value = text;
  previewPaste();
  $('#pasteDialog').showModal();
  pasteForm.text.focus();
}

pasteForm.text.addEventListener('input', () => {
  clearTimeout(pasteTimer);
  pasteTimer = setTimeout(previewPaste, 150);
});
pasteForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'load') return;
  const cues = previewPaste();
  if (!cues) {
    e.preventDefault(); // 読めないときは閉じずに理由を見せる
    if (!pasteForm.text.value.trim()) $('#pastePreview').textContent = tr('文字起こしを貼り付けてください');
    return;
  }
  const had = store.doc?.transcript;
  if (had && !confirm(tr('いまの字幕「{name}」を、貼り付けた文字起こしに置き換えますか？', { name: trMaybe(had.name) }))) {
    e.preventDefault();
    return;
  }
  // 字幕の名前として保存する（言語を切り替えても変えない。表示するときだけ訳す）
  applyTranscript(cues, '貼り付けた文字起こし');
  updateTxInfo();
});

// 入力欄の外で Ctrl+V したら、貼り付けた文字を入れた状態で貼り付け画面を開く
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t.closest?.('input, textarea, select, [contenteditable="true"], dialog')) return;
  const text = e.clipboardData?.getData('text/plain') || '';
  if (!text.trim() || !app.player) return;
  e.preventDefault();
  openPasteDialog(text);
});

function updateCaptionButton() {
  const has = store.cues.length > 0;
  const b = $('#btnCC');
  b.classList.toggle('on', has && app.settings.captions);
  $('#ccLabel').textContent = has ? (app.settings.captions ? tr('字幕 オン') : tr('字幕 オフ')) : tr('字幕を読み込む');
  b.title = has
    ? tr('{name}（{n} 行）: クリックで表示を切り替え (T)。読み込み直し・外すのは「設定」から', { name: trMaybe(store.doc.transcript.name), n: store.cues.length })
    : tr('字幕・文字起こしを読み込む（.srt / .vtt / JSON）');
  if (!has || !app.settings.captions) $('#caption').hidden = true;
  placeCaption();
}

// YouTube の埋め込みプレーヤーの上には何も重ねない（YouTube の規約）。字幕は動画のすぐ下の帯に出す。
// 帯は字幕を表示している間ずっと高さを取っておき、行が変わるたびに画面が上下しないようにする
function placeCaption() {
  const cap = $('#caption');
  const bar = $('#captionBar');
  const below = app.player?.kind === 'youtube';
  const home = below ? bar : $('#stage');
  if (cap.parentElement !== home) home.append(cap);
  bar.hidden = !(below && app.settings.captions && (store.cues.length > 0 || live.active));
  document.body.classList.toggle('caption-below', !bar.hidden);
}

function toggleCaptions() {
  if (!requireMedia()) return;
  if (!store.cues.length) {
    $('#txInput').click();
    return;
  }
  app.settings.captions = !app.settings.captions;
  saveSettings(app.settings);
  updateCaptionButton();
  txIndex = -2;
  app.hint(app.settings.captions ? tr('字幕を表示します') : tr('字幕を隠しました'));
}

// 再生位置の字幕: 動画の上に出す行（その行の時間内だけ）と、セルの文字起こしで強調する行（直前に始まった行）。
// 音声認識の途中結果があるときは、それを薄く表示する
function updateTranscript(now) {
  const cues = store.cues;
  const i = cues.length ? cueIndexAt(cues, now) : -1;
  const inside = i >= 0 && now < cues[i].e;
  const liveOn = live.active && app.settings.captions;
  const interim = liveOn ? live.interim : '';
  const recent = liveOn && !interim ? live.recentText() : '';
  // 練習中: シャドーイングは待ち時間もその行を出したまま、ディクテーションは答え合わせまで隠す
  const pr = practice.captionOverride();
  const key = pr
    ? `pr:${pr.hide ? 'hide' : pr.text}:${i}`
    : interim || recent ? `live:${interim}:${recent}:${i}` : i * 2 + (inside ? 1 : 0);
  if (key === txIndex) return;
  txIndex = key;
  const cap = $('#caption');
  cap.classList.toggle('is-live', !!interim && !pr);
  const text = pr
    ? pr.hide ? '' : pr.text
    : interim || recent || (inside && app.settings.captions ? cues[i].text : '');
  cap.hidden = !text;
  if (text) cap.textContent = text;
  sidebar.markTranscript(i);
}

app.onLiveInterim = () => updateTranscript(app.now());
app.refreshCaption = () => {
  placeCaption();
  txIndex = -2;
  updateTranscript(app.now());
};

// 字幕の行の編集・削除・時刻ずらし（元に戻せる。音声認識中は、あとから届く行を消さないよう履歴を積まない）
const txRecord = () => ({ record: !live.active });
app.editCue = (id, text) => store.editCue(id, text, txRecord());
app.deleteCue = (id) => {
  store.deleteCue(id, txRecord());
  app.hint(live.active ? tr('行を消しました') : tr('行を消しました（Ctrl+Z で元に戻せます）'));
};
app.shiftTranscript = (delta) => store.shiftTranscript(delta, txRecord());
app.openTxTools = () => txtools.open();
app.startPractice = (mode) => practice.start(mode);
app.openWordAdd = (init) => words.openAdd(init);
app.cueAt = (t) => {
  const cues = store.cues;
  const i = cueIndexAt(cues, t);
  return i >= 0 && t < cues[i].e + 1.5 ? cues[i] : null;
};
// 右下の一覧を「文字起こし」にして開く（音声認識を始めたとき）
app.showTranscriptList = () => commentList.setMode('transcript');

// ---- 書き出し・読み込み ----

function exportJson() {
  if (!requireMedia()) return;
  const blob = new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (store.doc.title || 'media').replace(/[\\/:*?"<>|]/g, '_') + '.cells.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJsonFile(file) {
  if (!requireMedia()) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast(tr('JSON ファイルとして読み込めませんでした'));
    return;
  }
  // メモの書き出しファイルでなければ、文字起こし（Whisper・cellview など）として読む
  if (!isNotesJson(data)) {
    loadTranscriptFile(file);
    return;
  }
  if (data.media && data.media.id !== store.doc.id) {
    const ok = confirm(tr('「{title}」のデータのようです。いま開いているメディアに追加しますか？', { title: data.media.title }));
    if (!ok) return;
  }
  const { addedM, addedC } = store.importData(data);
  toast(tr('セル {c} 件・目印 {m} 件を追加しました', { c: addedC, m: addedM }));
}

// ---- 設定・ヘルプ ----

function updateTxInfo() {
  const t = store.doc?.transcript;
  $('#txInfo').textContent = t ? tr('{name}（{n} 行）', { name: trMaybe(t.name), n: t.cues.length }) : tr('読み込んでいません');
  $('#btnTxRemove').hidden = !t;
}

$('#btnTxReload').addEventListener('click', () => $('#txInput').click());
$('#btnLiveHelp').addEventListener('click', () => {
  $('#settingsDialog').close();
  live.openHelp();
});
$('#btnTxPaste2').addEventListener('click', () => {
  $('#settingsDialog').close();
  openPasteDialog();
});
$('#btnTxRemove').addEventListener('click', () => {
  if (!store.doc?.transcript) return;
  if (!confirm(tr('字幕「{name}」を外しますか？（元のファイルはそのまま残ります）', { name: trMaybe(store.doc.transcript.name) }))) return;
  store.setTranscript(null);
  updateTxInfo();
  app.hint(tr('字幕を外しました'));
});

function updateStorageInfo() {
  const el = $('#storageInfo');
  const kind = store.kv?.kind === 'indexeddb' ? tr('ブラウザの大きな保存領域（IndexedDB）') : tr('localStorage（全体で約 5MB まで）');
  el.textContent = kind;
  storageEstimate().then((est) => {
    if (!est) return;
    const mb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
    el.textContent = kind + tr('・使用 {used}（上限の目安 {quota}）', { used: mb(est.usage), quota: mb(est.quota) });
  });
}

function openSettings() {
  updateTxInfo();
  updateStorageInfo();
  const f = $('#settingsForm');
  const s = app.settings;
  f.offsets.value = s.offsets.join(', ');
  f.mergeWindow.value = s.mergeWindow;
  f.targetRange.value = s.targetRange;
  f.zoomRange.value = String(s.zoomRange);
  f.leadIn.value = s.leadIn;
  f.momentClip.value = s.momentClip;
  f.pauseOnMark.checked = s.pauseOnMark;
  f.liveChat.checked = s.liveChat;
  f.resumeAfterComment.checked = s.resumeAfterComment;
  f.captions.checked = s.captions;
  f.lang.value = lang;
  $('#settingsDialog').showModal();
}

// 表示の言語を切り替える。文はページを開いたときに決まるので、読み込み直す（開いているファイルは開き直してもらう）
function switchLanguage(next) {
  if (next === lang) return;
  if (app.player && !confirm(tr('表示の言語を切り替えるため、ページを読み込み直します。開いているファイルは開き直してください。'))) return;
  app.settings.lang = next;
  saveSettings(app.settings);
  location.href = location.pathname; // ?lang= や ?src= を外して開き直す
}

const langBtn = $('#btnLangSwitch');
langBtn.textContent = isEn ? '日本語' : 'English';
langBtn.lang = isEn ? 'ja' : 'en';
langBtn.addEventListener('click', () => switchLanguage(isEn ? 'ja' : 'en'));

$('#settingsForm').addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const f = e.target;
  const num = (v, fallback) => (v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));
  const offsets = f.offsets.value
    .split(/[,、\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 120)
    .slice(0, 5);
  app.settings = {
    ...app.settings,
    offsets: offsets.length ? offsets : DEFAULT_SETTINGS.offsets,
    mergeWindow: clamp(num(f.mergeWindow.value, DEFAULT_SETTINGS.mergeWindow), 0, 10),
    targetRange: clamp(num(f.targetRange.value, DEFAULT_SETTINGS.targetRange), 2, 120),
    zoomRange: Number(f.zoomRange.value) || DEFAULT_SETTINGS.zoomRange,
    leadIn: clamp(Math.round(num(f.leadIn.value, DEFAULT_SETTINGS.leadIn)), 1, 30),
    momentClip: clamp(Math.round(num(f.momentClip.value, DEFAULT_SETTINGS.momentClip)), 1, 60),
    pauseOnMark: f.pauseOnMark.checked,
    liveChat: f.liveChat.checked,
    resumeAfterComment: f.resumeAfterComment.checked,
    captions: f.captions.checked,
  };
  saveSettings(app.settings);
  moment.renderOffsets();
  broadcast.applyChatSetting();
  commentList.paint(); // 「○秒前から」の秒数を描き直す
  renderAll();
  app.hint(tr('設定を保存しました'));
  switchLanguage(f.lang.value);
});

// ---- ボタン ----

$('#btnOpenFile').addEventListener('click', () => $('#fileInput').click());
$('#btnEmptyOpen').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  openLocalFile(e.target.files[0]);
  e.target.value = '';
});
$('#urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#urlInput');
  openFromText(input.value);
  input.blur();
});
$('#btnUndo').addEventListener('click', () => store.undo());
$('#btnRedo').addEventListener('click', () => store.redo());
$('#btnExport').addEventListener('click', exportJson);
$('#btnImport').addEventListener('click', () => {
  if (requireMedia()) $('#importInput').click();
});
$('#importInput').addEventListener('change', (e) => {
  if (e.target.files[0]) importJsonFile(e.target.files[0]);
  e.target.value = '';
});
$('#btnSettings').addEventListener('click', openSettings);
$('#btnCC').addEventListener('click', toggleCaptions);
$('#btnTxPaste').addEventListener('click', () => openPasteDialog());
$('#txInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await loadTranscriptFile(file);
  updateTxInfo();
});
const presetDialog = new PresetDialog(app, () => {
  moment.renderQuick();
  renderAll();
  app.hint(tr('よく使うコメントを保存しました'));
});
$('#btnEditPresets').addEventListener('click', () => presetDialog.open());
$('#presetSetSelect').addEventListener('change', (e) => {
  app.setPresetSet(e.target.value);
  e.target.blur();
});
$('#btnHelp').addEventListener('click', () => $('#helpDialog').showModal());
$('#btnPlay').addEventListener('click', togglePlay);
$('#btnBack').addEventListener('click', () => app.seek(app.now() - 5));
$('#btnFwd').addEventListener('click', () => app.seek(app.now() + 5));
$('#rateSelect').addEventListener('change', (e) => {
  app.player?.setRate(Number(e.target.value));
  e.target.blur();
});
$('#volume').value = app.settings.volume;
$('#volume').addEventListener('input', (e) => {
  app.settings.volume = Number(e.target.value);
  app.player?.setVolume(app.settings.volume);
});
$('#volume').addEventListener('change', (e) => {
  saveSettings(app.settings);
  e.target.blur();
});

// マウスで押したボタンからはフォーカスを外す（Space / Enter がボタンに取られないように）
document.addEventListener(
  'click',
  (e) => {
    const b = e.target.closest('button');
    if (b && e.detail > 0) setTimeout(() => b.blur(), 0);
  },
  true,
);

// YouTube の動画をクリックするとキー操作が iframe に取られるので、親ページへ戻す。
// ライブチャットの iframe は書き込むところなので戻さない（戻すと入力欄からすぐ外れてしまう）
window.addEventListener('blur', () => {
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a.tagName === 'IFRAME' && a.closest('#stageMedia')) {
      a.blur();
      window.focus();
    }
  }, 0);
});

// ---- ドラッグ＆ドロップ ----

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#dropHint').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropHint').hidden = true;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropHint').hidden = true;
  openLocalFile(e.dataTransfer.files[0]);
});

// ---- キーボード ----

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  const typing =
    (t.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'file'].includes(t.type)) ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable;
  if (typing) return;

  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (k === 'z' || k === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
    return;
  }
  if (ctrl && (k === 'y' || k === 'Y')) {
    e.preventDefault();
    store.redo();
    return;
  }
  if (k === '?') {
    $('#helpDialog').showModal();
    return;
  }
  if (!app.player || !store.doc) return;
  if (ctrl && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    e.preventDefault();
    nudgeTarget(k === 'ArrowLeft' ? -0.1 : 0.1);
    return;
  }
  if (ctrl || e.altKey) return;

  switch (k) {
    case ' ':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      app.seek(app.now() - (e.shiftKey ? 1 : 5));
      break;
    case 'ArrowRight':
      e.preventDefault();
      app.seek(app.now() + (e.shiftKey ? 1 : 5));
      break;
    case 'm':
    case 'M':
      app.markAt(app.now());
      break;
    case '1':
    case '2':
    case '3':
      app.rateMoment(Number(k));
      break;
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9':
      app.toggleQuickTag(Number(k) - 4);
      break;
    case 'b':
    case 'B':
      app.toggleMomentBookmark();
      break;
    case 'c':
    case 'C':
      e.preventDefault();
      moment.startMark();
      break;
    case 'Enter':
      e.preventDefault();
      app.makeCellHere();
      break;
    case 'r':
    case 'R':
      toggleRepeatHere();
      break;
    case 't':
    case 'T':
      toggleCaptions();
      break;
    case 'w':
    case 'W': {
      // 単語帳に追加: 選んでいる文字を言葉に、いまの字幕の行を前後の文として入れる
      const cue = app.cueAt(app.now());
      words.openAdd({ word: String(window.getSelection?.() || '').trim(), context: cue?.text || '', t: cue ? cue.s : app.now() });
      break;
    }
    case '[':
      jumpMarker(-1);
      break;
    case ']':
      jumpMarker(1);
      break;
    case ',':
      frameStep(-1);
      break;
    case '.':
      frameStep(1);
      break;
    case 'Escape':
      if (app.ui.commentPin) moment.finishPin();
      else if (app.ui.selectedCells.size) app.clearCellSelect();
      else app.releaseTarget();
      break;
    case 'Delete':
      deleteTargetMarker();
      break;
  }
});

// ---- 再生位置の監視 ----
// requestAnimationFrame は別のウィンドウを見ている間は止まるので、
// リピートなどの処理は画面に見えていなくても動くタイマーで行う

let lastNow = 0;
let activeKey = '';

function watch() {
  const p = app.player;
  if (!p || !store.doc) return;
  const now = p.getTime();

  // YouTube は読み込み直後だと長さが 0 のことがあるので、分かった時点で反映する。
  // ライブ配信は長さ（最新の位置）が伸び続けるので、10 秒ごとにだけ反映する
  p.updateLive();
  const d = p.getDuration();
  if (d && Math.abs(d - store.doc.duration) > (p.isLive() ? 10 : 0.5)) store.setDuration(d);

  // リピート: セルの終わりを内側から越えたら先頭へ戻す（回数・間・速度はそこで扱う）
  const rep = app.ui.repeatId && store.getCell(app.ui.repeatId);
  if (rep && !p.paused && lastNow >= rep.s - 0.3 && lastNow < rep.e && now >= rep.e - 0.02) {
    onRepeatLoop(rep);
  }
  lastNow = now;

  // 作った目印から十分離れたら対象を外す
  const tg = app.ui.target;
  if (tg && performance.now() > (tg.holdUntil || 0) && Math.abs(now - tg.ref) > app.settings.targetRange) {
    app.ui.target = null;
    renderAll();
  }

  // 再生位置を含むセル・近くの目印の強調
  const act = [];
  for (const c of store.cells) if (now >= c.s && now < c.e) act.push(c.id);
  const near = store.nearestMarker(now, app.settings.mergeWindow);
  const key = act.join(',') + '|' + (near ? near.id : '') + '|' + (app.ui.target ? app.ui.target.id : '');
  if (key !== activeKey) {
    activeKey = key;
    app.activeCells = new Set(act);
    app.nearId = near ? near.id : null;
    timeline.updateActive();
    sidebar.updateActive();
  }

  updateTranscript(now);
  digest.tick(now, !p.paused);
  practice.tick(now, !p.paused);
  broadcast.tick(now);
}

// ---- 毎フレームの描画 ----

let timeText = '';

function loop() {
  requestAnimationFrame(loop);
  const p = app.player;
  if (!p || !store.doc) return;
  const now = p.getTime();

  timeline.tick(now);
  moment.tick(now);
  commentList.tick(now);
  const tt = `${fmt(now, true)} / ${fmt(app.duration())}`;
  if (tt !== timeText) {
    timeText = tt;
    $('#timeText').textContent = tt;
  }
}

// ページを閉じる・別のタブに移るときは、待たずにすぐ保存する
window.addEventListener('pagehide', () => store.saveNow());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.saveNow();
});

// ---- インストールできる Web アプリ（PWA） ----

// オフラインでも起動できるようにする（file:// などでは何もしない）
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// インストールできるときだけ、「?」の画面に「アプリとしてインストール」を出す
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#btnInstall').hidden = false;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  $('#btnInstall').hidden = true;
});
$('#btnInstall').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  $('#btnInstall').hidden = true;
  if (outcome === 'accepted') toast(tr('インストールしました。スタートメニューなどから専用のウィンドウで開けます'));
});

// 保存先（IndexedDB）を開いてから始める。以前の保存データの引っ越しもここで行う
updatePlayButton();
const kv = await store.init();
if (kv.migrated) toast(tr('保存先を大きな領域（IndexedDB）に移しました（{n} 件）。これまでのメモはそのまま使えます', { n: kv.migrated }));
if (kv.kind !== 'indexeddb') toast(tr('このブラウザでは大きな保存領域が使えないため、これまでどおりの保存先（約 5MB まで）を使います'));

// ?src=... で URL のメディアを直接開ける（動作確認用）
// ?lang=en / ?lang=ja で開いたときは、その言語を覚えておく
const qLang = new URLSearchParams(location.search).get('lang');
if ((qLang === 'ja' || qLang === 'en') && app.settings.lang !== qLang) {
  app.settings.lang = qLang;
  saveSettings(app.settings);
}

const initial = new URLSearchParams(location.search).get('src');
if (openShareFromHash()) showEmpty();
else if (initial) openFromText(initial);
else showEmpty();

// インストールしたアプリに、エクスプローラーの「プログラムから開く」などでファイルが渡されたとき。
// 動画・音声と字幕を一緒に渡されたら、動画を開いてから字幕を読み込む
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const files = await Promise.all((params.files || []).map((h) => h.getFile()));
    const media = files.find((f) => !/\.(srt|vtt|txt|json)$/i.test(f.name));
    const sub = files.find((f) => /\.(srt|vtt)$/i.test(f.name));
    if (media) await openLocalFile(media);
    if (!sub) return;
    if (app.player) loadTranscriptFile(sub);
    else toast(tr('字幕を読み込むには、先に動画か音声を開いてください'));
  });
}

setInterval(watch, 30);
requestAnimationFrame(loop);
