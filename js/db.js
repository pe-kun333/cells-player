// メモの保存先。IndexedDB（ブラウザの大きな保存領域）に、キーと値の組で保存する。
// IndexedDB が使えないときだけ、これまでの localStorage（全体で約 5MB）に保存する
import { tr } from './i18n.js';

const DB_NAME = 'cells-player';
const STORE = 'kv';
const LS_PREFIX = 'cellsplayer:';

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(tr('IndexedDB を開けませんでした')));
  });
}

class IdbKV {
  constructor(db) {
    this.db = db;
    this.kind = 'indexeddb';
  }

  // 値は put を呼んだ時点で複製されるので、このあと元のオブジェクトを書き換えても保存内容は変わらない
  run(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error(tr('保存が中断されました')));
    });
  }

  get(key) {
    return this.run('readonly', (st) => st.get(key));
  }

  set(key, value) {
    return this.run('readwrite', (st) => st.put(value, key));
  }

  del(key) {
    return this.run('readwrite', (st) => st.delete(key));
  }
}

class LocalKV {
  constructor() {
    this.kind = 'localstorage';
  }

  async get(key) {
    try {
      const v = localStorage.getItem(LS_PREFIX + key);
      return v ? JSON.parse(v) : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key, value) {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  }

  async del(key) {
    localStorage.removeItem(LS_PREFIX + key);
  }
}

// 移したあとに、古い版を開いたままのタブが localStorage に書いた分があれば、新しいほうを残す
function mergeOld(key, cur, old) {
  const byId = (a, b) => {
    const map = new Map(a.map((x) => [x.id, x]));
    for (const x of b) {
      const y = map.get(x.id);
      if (!y || (x.updatedAt || x.at || 0) > (y.updatedAt || y.at || 0)) map.set(x.id, x);
    }
    return [...map.values()];
  };
  if (key === 'index' || key === 'words') return Array.isArray(cur) && Array.isArray(old) ? byId(cur, old) : cur;
  return (old?.updatedAt || 0) > (cur?.updatedAt || 0) ? old : cur;
}

// これまで localStorage に置いていたメモ・最近の一覧・単語帳を IndexedDB へ移す（設定は小さいので localStorage のまま）
async function migrateFromLocalStorage(kv) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(LS_PREFIX)) continue;
    const key = k.slice(LS_PREFIX.length);
    if (key.startsWith('media:') || key === 'index' || key === 'words') keys.push(key);
  }
  for (const key of keys) {
    const raw = localStorage.getItem(LS_PREFIX + key);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const cur = await kv.get(key);
    if (cur === undefined) await kv.set(key, value);
    else await kv.set(key, mergeOld(key, cur, value));
  }
  // すべて移せてから消す（途中で失敗したら古いほうを残して次回また試す）
  for (const key of keys) localStorage.removeItem(LS_PREFIX + key);
  return keys.length;
}

export async function openKV() {
  try {
    if (!window.indexedDB) throw new Error('no indexedDB');
    const kv = new IdbKV(await openIdb());
    kv.migrated = await migrateFromLocalStorage(kv);
    // ブラウザが容量不足のときに勝手に消さないよう頼んでおく（許可されなくても使える）
    navigator.storage?.persist?.().catch(() => {});
    return kv;
  } catch {
    return new LocalKV();
  }
}

// 保存に使っている量と、使える量の目安
export async function storageEstimate() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}
