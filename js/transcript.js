import { tr } from './i18n.js';

// 字幕・文字起こしの読み込み（.srt / .vtt / JSON / 時刻つきの文字）・書き出しと、時間での検索

// 00:01:02,345 / 00:01:02.345 / 01:02.345
function parseTimestamp(str) {
  const m = str.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return NaN;
  const [, h, mi, s, ms] = m;
  return Number(h || 0) * 3600 + Number(mi) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0);
}

// 書式タグ（<i> や <c.color> や {\an8}）と文字参照を取り除く。改行は残す
function cleanText(t) {
  return t
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

// .srt と .vtt は「時間の行（--> を含む）＋本文」のかたまりが空行で区切られている
function parseTimed(text) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue; // WEBVTT の見出し、NOTE、STYLE など
    const [a, b = ''] = lines[i].split('-->');
    const s = parseTimestamp(a);
    const e = parseTimestamp(b.trim().split(/\s+/)[0]);
    const body = cleanText(lines.slice(i + 1).join('\n'));
    if (body) cues.push({ s, e, text: body });
  }
  return cues;
}

// YouTube の「文字起こしを表示」などからコピーした文字:
//   0:05            ← 時刻だけの行のあとに本文の行（YouTube の一覧をコピーした形）
//   こんにちは
// または「0:05 こんにちは」「[1:02:03] こんにちは」のように行の頭に時刻と空白。
// 「3:00に集合」のように本文が数字で始まるだけの行は、時刻とみなさない
const TS = '(\\d{1,2}(?::\\d{2}){1,2}(?:\\.\\d+)?)';
const TS_ONLY = new RegExp(`^[\\[(（]?${TS}[\\])）]?$`);
const TS_HEAD = new RegExp(`^[\\[(（]?${TS}[\\])）]?[\\s\\u3000]+(.+)$`);

function toSeconds(ts) {
  return ts.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

function parsePlain(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const cues = [];
  // 時刻だけの行が「本文のあと」に来る並び（最後の行が時刻）なら、時刻はその上の本文のもの。
  // そうでなければ（YouTube の一覧をコピーした形）、時刻はその下の本文のもの
  const timeAfterText = lines.length > 1 && TS_ONLY.test(lines[lines.length - 1]) && !TS_ONLY.test(lines[0]);
  let cur = null;
  let buffer = [];
  for (const line of lines) {
    let m = line.match(TS_ONLY);
    if (m) {
      if (timeAfterText) {
        // 同じ行が続いたとき（見出しの重複など）は1つにまとめる
        const body = buffer.filter((l, i) => l !== buffer[i - 1]).join('\n');
        cues.push({ s: toSeconds(m[1]), e: NaN, text: body });
        buffer = [];
      } else {
        cur = { s: toSeconds(m[1]), e: NaN, text: '' };
        cues.push(cur);
      }
      continue;
    }
    m = line.match(TS_HEAD);
    if (m) {
      cur = { s: toSeconds(m[1]), e: NaN, text: m[2].trim() };
      cues.push(cur);
      buffer = [];
      continue;
    }
    if (timeAfterText) buffer.push(line);
    // 最初の時刻より前の行（「文字起こし」などの見出し）は捨てる
    else if (cur) cur.text = cur.text ? `${cur.text}\n${line}` : line;
  }
  // 終わりの時刻は次の行の始まり（無音が長いときに出しっぱなしにならないよう最大10秒）
  cues.sort((a, b) => a.s - b.s);
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1];
    cues[i].e = next ? Math.min(next.s, cues[i].s + 10) : cues[i].s + 5;
  }
  return cues;
}

// JSON: Whisper や cellview の文字起こし（segments）、cellview のセル（cells[].transcript）、[{start, end, text}]
function parseJson(data) {
  let segs = null;
  if (Array.isArray(data)) segs = data;
  else if (Array.isArray(data?.segments)) segs = data.segments;
  else if (Array.isArray(data?.transcript)) segs = data.transcript;
  else if (Array.isArray(data?.cues)) segs = data.cues;
  else if (Array.isArray(data?.cells)) segs = data.cells.flatMap((c) => (Array.isArray(c?.transcript) ? c.transcript : []));
  if (!segs) return [];
  return segs.map((x) => ({
    s: Number(x?.start ?? x?.s),
    e: Number(x?.end ?? x?.e),
    text: cleanText(String(x?.text ?? '')),
  }));
}

function normalize(cues) {
  return cues
    .filter((c) => Number.isFinite(c.s) && c.text)
    .map((c) => {
      const s = Math.max(0, c.s);
      const e = Number.isFinite(c.e) && c.e > s ? c.e : s + 2;
      return { s: Math.round(s * 100) / 100, e: Math.round(e * 100) / 100, text: c.text };
    })
    .sort((a, b) => a.s - b.s || a.e - b.e);
}

// このアプリの「書き出し」で作ったメモのファイルか（字幕ではない）
export function isNotesJson(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && (data.app === 'cells-player' || data.app === 'cell-player' || Array.isArray(data.markers));
}

// text: ファイルの中身、name: ファイル名（拡張子で形式を見分ける）
export function parseTranscript(text, name = '') {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  let cues;
  // 「[」で始まっても「[0:05] 本文」のような文字のことがあるので、JSON として読めたときだけ JSON 扱いにする
  let data;
  if (ext === 'json' || /^\s*[[{]/.test(text)) {
    try {
      data = JSON.parse(text);
    } catch {
      if (ext === 'json') throw new Error(tr('JSON として読み込めませんでした'));
    }
  }
  if (data !== undefined) {
    cues = parseJson(data);
  } else if (ext === 'srt' || ext === 'vtt' || text.includes('-->')) {
    cues = parseTimed(text);
  } else {
    cues = parsePlain(text);
  }
  const out = normalize(cues);
  if (!out.length) {
    throw new Error(tr('字幕・文字起こしの行が見つかりませんでした（.srt / .vtt / 文字起こしの JSON、または「0:05」のような時刻つきの文字に対応しています）'));
  }
  return out;
}

// ---- 書き出し ----

// 01:02:03,456（SRT） / 01:02:03.456（VTT）
function stamp(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000));
  const p2 = (n) => String(n).padStart(2, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms % 1000).padStart(3, '0')}`;
}

// 0:05 / 1:02:03（テキスト用）
function clock(t) {
  const s = Math.floor(Math.max(0, t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.s, ',')} --> ${stamp(c.e, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues) {
  return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.s, '.')} --> ${stamp(c.e, '.')}\n${c.text}\n`).join('\n');
}

// 「[0:05] 本文」の形。このアプリの「貼り付け」でそのまま読み込み直せる
export function toText(cues) {
  return cues.map((c) => `[${clock(c.s)}] ${c.text.replace(/\s*\n\s*/g, ' ')}`).join('\n') + '\n';
}

// ---- 文字起こしからセルの区切りを作る ----
// gap: この秒数以上あいたら区切る / maxLen: 1つの長さの上限 / minLen: これより短いものは前とまとめる
export function autoSegments(cues, { gap = 2, maxLen = 60, minLen = 5 } = {}) {
  const out = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) {
      cur = { s: c.s, e: c.e };
      continue;
    }
    if (c.s - cur.e >= gap || c.e - cur.s > maxLen) {
      out.push(cur);
      cur = { s: c.s, e: c.e };
    } else {
      cur.e = Math.max(cur.e, c.e);
    }
  }
  if (cur) out.push(cur);
  // 短すぎる区切りは、前の区切りにつなげる（上限を大きく超えない範囲で）
  const merged = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    if (prev && seg.e - seg.s < minLen && seg.e - prev.s <= maxLen * 1.5) prev.e = seg.e;
    else merged.push({ ...seg });
  }
  return merged;
}

// t 以前に始まった一番新しい行（なければ -1）
export function cueIndexAt(cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].s <= t + 0.01) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// s〜e の区間に少しでもかかる行（元の番号付き）
export function cuesIn(cues, s, e) {
  const out = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.s >= e) break;
    if (c.e > s) out.push({ cue: c, i });
  }
  return out;
}
