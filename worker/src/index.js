// 漢字SRS API（Cloudflare Workers + D1）
// 画面（GitHub Pages）から POST /api {"fn", "pin", "args"} で呼ぶ。写真は署名付きURL GET /photo/<id> で配る。
// 無料プランの制約に合わせている: 1回の呼び出しで命令50個まで・CPU時間が短い → 集計はSQL、複数行の書き込みは json_each で1命令にまとめる
import {
  DEFAULT_SETTINGS, RESULT_MARK, ITEM_FIELDS,
  studyDay, addDays, cost, streak, bestStreak, normalizeItem, dupKey, replay, answer
} from './logic.js';

const PHOTO_MAX_BYTES = 1500000;
const PHOTO_URL_DAYS = 2;
const LOCK_FAILS = 10;
const LOCK_MS = 10 * 60 * 1000;

const ITEM_COLS = ['item_id', ...ITEM_FIELDS, 'registered_pool', 'created_at', 'status'];
const CARD_COLS = ['card_id', 'item_id', 'direction', 'stage', 'due', 'state', 'reps', 'lapses', 'last_result', 'last_reviewed_at', 'introduced_on'];
const REVIEW_COLS = ['review_id', 'card_id', 'answered_at', 'study_day', 'result', 'duration_sec', 'stage_before', 'stage_after', 'mode'];
// 出題に使う問題の列（カードと結合するときの名前の衝突を避けて明示する）
const ITEM_VIEW = ['item_id', ...ITEM_FIELDS].map((k) => 'i.' + k).join(', ');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const c = { env, db: env.DB, photos: env.PHOTOS, now: env.NOW_MS ? Number(env.NOW_MS) : Date.now(), base: url.origin };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
    }
    if (url.pathname === '/api' && request.method === 'POST') return api(c, request, cors);
    const m = /^\/photo\/([\w-]+)$/.exec(url.pathname);
    if (m && request.method === 'GET') return servePhoto(c, m[1], url);
    return new Response(url.pathname === '/' ? 'kanji-srs API OK' : 'Not found', { status: url.pathname === '/' ? 200 : 404 });
  }
};

const API = {
  whoami: ['study', async (c, role) => ({ role })],
  getToday: ['study', getToday],
  getChallengeDecks: ['study', getChallengeDecks],
  getChallenge: ['study', getChallenge],
  submitReviews: ['study', submitReviews],
  finishDay: ['study', finishDay],
  getZukan: ['study', getZukan],
  getKanjiInfo: ['study', getKanjiInfo],
  addItems: ['admin', addItems],
  uploadPhoto: ['admin', uploadPhoto],
  listItems: ['admin', listItems],
  listUnits: ['admin', listUnits],
  listKeys: ['admin', listKeys],
  itemHistory: ['admin', itemHistory],
  updateItem: ['admin', updateItem],
  setStatus: ['admin', setStatus],
  getOverview: ['admin', getOverview],
  getDashboard: ['admin', getDashboard],
  exportTable: ['admin', exportTable],
  deleteReviews: ['admin', deleteReviews],
  resetItem: ['admin', resetItem],
  resetDay: ['admin', resetDay]
};

function json(obj, cors) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
}

async function api(c, request, cors) {
  try {
    let body;
    try { body = JSON.parse(await request.text()); } catch (e) { throw new Error('BAD_REQUEST'); }
    if (!body || !Object.prototype.hasOwnProperty.call(API, body.fn)) throw new Error('UNKNOWN_FN');
    const [need, fn] = API[body.fn];
    const role = await auth(c, body.pin, need);
    const result = await fn(c, role, ...(Array.isArray(body.args) ? body.args : []));
    return json({ ok: true, result }, cors);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, cors);
  }
}

// 全APIでPINを確認する。失敗10回で10分ロック
async function auth(c, pin, need) {
  const row = await c.db.prepare('SELECT count, until FROM auth_fail WHERE k = ?').bind('pin').first();
  if (row && row.count >= LOCK_FAILS && row.until > c.now) throw new Error('LOCKED');
  const study = c.env.STUDY_PIN, admin = c.env.ADMIN_PIN;
  if (!study || !admin) throw new Error('NOT_SETUP');
  const p = String(pin || '');
  const role = p === admin ? 'admin' : (p === study ? 'study' : '');
  if (!role) {
    // 最初の失敗から10分以内の失敗を数え、10回目で10分ロック
    const active = row && row.until > c.now;
    const count = active ? row.count + 1 : 1;
    const until = count >= LOCK_FAILS ? c.now + LOCK_MS : (active ? row.until : c.now + LOCK_MS);
    await c.db.prepare('INSERT INTO auth_fail (k, count, until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET count = excluded.count, until = excluded.until')
      .bind('pin', count, until).run();
    throw new Error('BAD_PIN');
  }
  if (need === 'admin' && role !== 'admin') throw new Error('FORBIDDEN');
  return role;
}

// ───────── 共通部品 ─────────

function id(prefix) {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return prefix + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function settings(c) {
  const st = { ...DEFAULT_SETTINGS };
  const { results } = await c.db.prepare('SELECT key, value FROM settings').all();
  for (const r of results) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, r.key) && r.value !== '' && isFinite(Number(r.value))) st[r.key] = Number(r.value);
  }
  return st;
}

// json_each で「配列をまとめて1命令で書く」ための SELECT 句
function fromJson(cols) {
  return 'SELECT ' + cols.map((k) => `json_extract(value, '$.${k}')`).join(', ') + ' FROM json_each(?)';
}

function upsertDaysStmt(c, rows, cols) {
  // rows: [{study_day, ...cols}]
  const set = cols.map((k) => `${k} = excluded.${k}`).join(', ');
  return c.db.prepare(`INSERT INTO days (study_day, ${cols.join(', ')}) ${fromJson(['study_day', ...cols])} WHERE true ON CONFLICT(study_day) DO UPDATE SET ${set}`)
    .bind(JSON.stringify(rows));
}

// ───────── 写真の署名付きURL ─────────

let photoKey = null;
async function getPhotoKey(c) {
  if (photoKey) return photoKey;
  let row = await c.db.prepare('SELECT v FROM secrets WHERE k = ?').bind('photo_key').first();
  if (!row) {
    const raw = Array.from(crypto.getRandomValues(new Uint8Array(32)), (x) => x.toString(16).padStart(2, '0')).join('');
    await c.db.prepare('INSERT OR IGNORE INTO secrets (k, v) VALUES (?, ?)').bind('photo_key', raw).run();
    row = await c.db.prepare('SELECT v FROM secrets WHERE k = ?').bind('photo_key').first();
  }
  photoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(row.v), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return photoKey;
}

async function sign(c, photoId, exp) {
  const sig = await crypto.subtle.sign('HMAC', await getPhotoKey(c), new TextEncoder().encode(photoId + '.' + exp));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

// 同じ日のうちは同じURLになるよう、有効期限を日単位でそろえる（端末のキャッシュが効く）
async function photoUrl(c, photoId) {
  if (!photoId) return '';
  const exp = (Math.floor(c.now / 86400000) + PHOTO_URL_DAYS) * 86400000;
  return `${c.base}/photo/${photoId}?e=${exp}&s=${await sign(c, photoId, exp)}`;
}

async function servePhoto(c, photoId, url) {
  const exp = Number(url.searchParams.get('e'));
  const s = url.searchParams.get('s') || '';
  if (!exp || exp < c.now || s !== await sign(c, photoId, exp)) return new Response('Forbidden', { status: 403 });
  const row = await c.photos.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(photoId).first();
  if (!row) return new Response('Not found', { status: 404 });
  return new Response(toBytes(row.data), { headers: { 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=86400, immutable' } });
}

function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return new Uint8Array(0);
}

// 定着率の推移用。今日の行がまだ無いときだけ記録する（INSERT OR IGNORE なので、あれば何も変わらない）
const RETAINED = "(c.state IN ('spot', 'retired') OR (c.state = 'learning' AND c.stage >= 4 AND c.last_result = '○'))";
function snapshotStmt(c, day) {
  return c.db.prepare(`INSERT OR IGNORE INTO snapshots (study_day, cards_total, cards_retained)
    SELECT ?1, COUNT(*), COALESCE(SUM(${RETAINED}), 0) FROM cards c JOIN items i ON i.item_id = c.item_id
    WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE study_day = ?1)
      AND i.status = 'active' AND c.state IN ('learning', 'spot', 'retired')`).bind(day);
}

async function withPhotoUrls(c, obj) {
  obj.photo_q_url = await photoUrl(c, obj.photo_q);
  obj.photo_a_url = await photoUrl(c, obj.photo_a);
  return obj;
}

// ───────── 子どもの画面用 ─────────

async function getToday(c) {
  const st = await settings(c);
  const today = studyDay(c.now, st.day_start_hour);
  const [daysRes, spentRes, introRes, gradRes] = await c.db.batch([
    c.db.prepare('SELECT study_day, completed, cards_done, seconds, freeze_used FROM days'),
    // 削除・停止した問題（本番の動作確認用など）を解いた時間は、今日の予算に数えない
    // 新しい問題のチャレンジで解いた時間も数えない（間違えた問題の復習の量が減らないように）
    c.db.prepare("SELECT c.direction, i.photo_q, i.item_id FROM reviews r JOIN cards c ON c.card_id = r.card_id JOIN items i ON i.item_id = c.item_id WHERE r.study_day = ? AND i.status = 'active' AND r.mode = 'daily'").bind(today),
    // 今日出し始めた新しいカードの数。削除・停止した問題と、チャレンジで間違えて入ってきたカードは数えない
    c.db.prepare(`SELECT COUNT(*) AS n FROM cards c JOIN items i ON i.item_id = c.item_id
      WHERE c.introduced_on = ? AND i.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.card_id = c.card_id AND r.mode = 'new')`).bind(today),
    c.db.prepare("SELECT COUNT(*) AS n FROM cards c JOIN items i ON i.item_id = c.item_id WHERE i.status = 'active' AND c.state IN ('spot', 'retired')")
  ]);
  const dayRows = daysRes.results;
  const todayRow = dayRows.find((r) => r.study_day === today);
  // 最後まで解いて終えた日だけ「終わり」にする。出す問題が0問で自動的に終えた日（cards_done = 0）は、
  // あとから親が問題を登録したら同じ日のうちに出題する
  let done = !!(todayRow && todayRow.completed && todayRow.cards_done > 0);
  const finished = done;
  const queue = [];
  const writes = [];
  const allowance = Math.max(0, st.new_per_day - introRes.results[0].n);
  const usedItems = new Set(spentRes.results.map((r) => r.item_id));
  const dueStmt = c.db.prepare(
    `SELECT c.card_id, c.direction, c.stage, c.state, ${ITEM_VIEW} FROM cards c JOIN items i ON i.item_id = c.item_id
     WHERE i.status = 'active' AND c.state IN ('learning', 'spot') AND c.due <> '' AND c.due <= ?
     ORDER BY CASE WHEN c.state = 'spot' THEN 99 ELSE c.stage END, c.due, i.created_at, i.item_id,
       CASE c.direction WHEN 'write' THEN 0 WHEN 'read' THEN 1 ELSE 2 END LIMIT 500`).bind(today);
  const freshStmt = c.db.prepare(
    `SELECT c.card_id, c.direction, c.stage, c.state, ${ITEM_VIEW} FROM cards c JOIN items i ON i.item_id = c.item_id
     WHERE i.status = 'active' AND i.registered_pool = 'mistake' AND c.state = 'new'
     ORDER BY CASE WHEN i.origin IN ('塾', '模試') THEN 0 ELSE 1 END, i.created_at, i.item_id,
       CASE c.direction WHEN 'write' THEN 0 WHEN 'read' THEN 1 ELSE 2 END LIMIT 500`);
  // 候補は枠の数より多めに取り、「同じ語は1日1枚」で外したあとに枠（allowance）の数だけ使う。
  // 先に LIMIT で枠の数だけ取ると、今日すでに出ている語の読みカードで枠が埋まり、ほかの問題が出なくなる
  if (!done) {
    let spent = 0;
    for (const r of spentRes.results) spent += cost(r.direction, !!r.photo_q, st);
    let budget = st.daily_seconds - spent;
    const due = await dueStmt.all();
    for (const r of due.results) {
      if (usedItems.has(r.item_id)) continue;
      const k = cost(r.direction, !!r.photo_q, st);
      // その日まだ1問も解いていなければ、予算を超える1問目でも出す
      if (k <= budget || (spent === 0 && queue.length === 0)) { queue.push(r); usedItems.add(r.item_id); budget -= k; }
    }
    if (allowance > 0) {
      const fresh = await freshStmt.all();
      const introduced = [];
      for (const r of fresh.results) {
        if (introduced.length >= allowance) break;
        if (usedItems.has(r.item_id)) continue;
        const k = cost(r.direction, !!r.photo_q, st);
        if (k > budget && !(spent === 0 && queue.length === 0)) break;
        r.state = 'learning';
        r.stage = 0;
        queue.push(r);
        usedItems.add(r.item_id);
        introduced.push(r.card_id);
        budget -= k;
      }
      if (introduced.length) {
        writes.push(c.db.prepare("UPDATE cards SET state = 'learning', stage = 0, due = ?1, introduced_on = ?1 WHERE card_id IN (SELECT value FROM json_each(?2))")
          .bind(today, JSON.stringify(introduced)));
      }
    }
    // 出す問題が無い日は自動で「終えた日」にする
    if (!queue.length) {
      if (!(todayRow && todayRow.completed)) {
        writes.push(upsertDaysStmt(c, [{ study_day: today, completed: 1 }], ['completed']));
        dayRows.push({ study_day: today, completed: 1, cards_done: 0, freeze_used: 0 });
      }
      done = true;
    }
  }
  // 最後まで終えた日も、同じ日に何度でも取り組めるようにする
  //   extra: まだ出していない問題（予算を超えた復習と、今日の新しいカードの残り枠）。解けば記録する
  //   practice: 今日解いた問題。記録しない練習用（同じ日に何度も記録すると復習の間隔が進みすぎるため）
  //             チャレンジで△×だった問題も入れる（○で「覚えていた」になったものは入れない）
  let extra = [], practice = [];
  if (finished) {
    const [dueAll, freshAll, practiced] = await c.db.batch([dueStmt, freshStmt,
      c.db.prepare(`SELECT c.card_id, c.direction, c.stage, c.state, ${ITEM_VIEW} FROM reviews r
        JOIN cards c ON c.card_id = r.card_id JOIN items i ON i.item_id = c.item_id
        WHERE r.study_day = ? AND i.status = 'active' AND c.state <> 'known' GROUP BY c.card_id ORDER BY MIN(r.answered_at)`).bind(today)]);
    const pick = (r) => {
      if (usedItems.has(r.item_id)) return false;
      usedItems.add(r.item_id);
      return true;
    };
    extra = dueAll.results.filter(pick).concat(freshAll.results.filter(pick).slice(0, allowance));
    practice = practiced.results;
  }
  const s = streak(dayRows, today, st);
  if (s.newFreezes.length) writes.push(upsertDaysStmt(c, s.newFreezes.map((d) => ({ study_day: d, freeze_used: 1 })), ['freeze_used']));
  writes.push(snapshotStmt(c, today));
  await c.db.batch(writes);
  const view = async (list) => { const out = []; for (const r of list) out.push(await withPhotoUrls(c, r)); return out; };
  shuffle(queue);
  shuffle(extra);
  let est = 0;
  for (const r of queue) est += cost(r.direction, !!r.photo_q, st);
  let extraEst = 0;
  for (const r of extra) extraEst += cost(r.direction, !!r.photo_q, st);
  return {
    today, done, cards: await view(queue), estSeconds: est,
    extra: await view(extra), extraEstSeconds: extraEst, practice: await view(practice),
    streak: s.streak, freezesLeft: s.freezesLeft, graduated: gradRes.results[0].n
  };
}

// list: [{review_id, card_id, result: 'o'|'t'|'x', answered_at, duration_sec}]
// 同じ review_id は二度反映しない（通信失敗時の再送に備える）
async function submitReviews(c, role, list) {
  if (!Array.isArray(list) || list.length > 200) throw new Error('BAD_ARGS');
  const st = await settings(c);
  const ids = list.map((r) => String((r && r.review_id) || ''));
  const cardIds = [...new Set(list.map((r) => String((r && r.card_id) || '')))];
  const [seenRes, cardsRes] = await c.db.batch([
    c.db.prepare('SELECT review_id FROM reviews WHERE review_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)),
    c.db.prepare('SELECT card_id, item_id, state, stage, reps, lapses, introduced_on FROM cards WHERE card_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(cardIds))
  ]);
  const seen = new Set(seenRes.results.map((r) => r.review_id));
  const cardMap = Object.fromEntries(cardsRes.results.map((r) => [r.card_id, r]));
  const sorted = list.slice().sort((a, b) => (String(a.answered_at) < String(b.answered_at) ? -1 : 1));
  const added = [];
  const touched = {};
  const toMistake = new Set();
  let duplicates = 0, skipped = 0;
  for (const r of sorted) {
    const rid = String((r && r.review_id) || '');
    if (!/^[\w-]{8,64}$/.test(rid) || !RESULT_MARK[r.result]) { skipped++; continue; }
    if (seen.has(rid)) { duplicates++; continue; }
    const card = cardMap[r.card_id];
    const mode = r.mode === 'new' ? 'new' : 'daily';
    let ms = Date.parse(r.answered_at);
    if (!isFinite(ms) || ms > c.now + 5 * 60000 || ms < c.now - 14 * 86400000) ms = c.now;
    const day = studyDay(ms, st.day_start_hour);
    const n = card && answer(card, r.result, day, mode);
    if (!n) { skipped++; continue; }
    const before = card.stage;
    Object.assign(card, {
      state: n.state, stage: n.stage, due: n.due, reps: card.reps + 1, lapses: card.lapses + (n.lapse ? 1 : 0),
      last_result: RESULT_MARK[r.result], last_reviewed_at: new Date(ms).toISOString(), introduced_on: n.introduced_on
    });
    if (n.toMistake) toMistake.add(card.item_id);
    touched[card.card_id] = card;
    added.push({
      review_id: rid, card_id: card.card_id, answered_at: new Date(ms).toISOString(), study_day: day,
      result: RESULT_MARK[r.result], duration_sec: Math.max(0, Math.min(600, Math.round(Number(r.duration_sec) || 0))),
      stage_before: before, stage_after: n.stage, mode
    });
    seen.add(rid);
  }
  if (added.length) {
    const upd = ['state', 'stage', 'due', 'reps', 'lapses', 'last_result', 'last_reviewed_at', 'introduced_on'];
    await c.db.batch([
      c.db.prepare(`UPDATE cards SET ${upd.map((k) => `${k} = j.${k}`).join(', ')}
        FROM (SELECT ${['card_id', ...upd].map((k) => `json_extract(value, '$.${k}') AS ${k}`).join(', ')} FROM json_each(?)) AS j
        WHERE cards.card_id = j.card_id`).bind(JSON.stringify(Object.values(touched))),
      c.db.prepare(`INSERT OR IGNORE INTO reviews (${REVIEW_COLS.join(', ')}) ${fromJson(REVIEW_COLS)}`).bind(JSON.stringify(added)),
      // チャレンジで△・×だった問題は「まちがえた問題」に移し、塾で間違えた問題と同じように復習に出す
      c.db.prepare("UPDATE items SET pool = 'mistake' WHERE item_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify([...toMistake]))
    ]);
  }
  return { applied: added.length, duplicates, skipped, toMistake: toMistake.size };
}

// info: { day, cards_done, seconds }
async function finishDay(c, role, info) {
  info = info || {};
  const st = await settings(c);
  const today = studyDay(c.now, st.day_start_hour);
  // 午前3時をまたいで終えた場合は、始めた日（前日）を完了にする
  const day = info.day === addDays(today, -1) ? info.day : today;
  const row = {
    study_day: day, completed: 1,
    cards_done: Math.max(0, Math.round(Number(info.cards_done) || 0)),
    seconds: Math.max(0, Math.round(Number(info.seconds) || 0))
  };
  // 同じ日に「つづき」で何度終えても、解いた数と時間は足していく
  await c.db.prepare(`INSERT INTO days (study_day, completed, cards_done, seconds) VALUES (?, 1, ?, ?)
    ON CONFLICT(study_day) DO UPDATE SET completed = 1, cards_done = days.cards_done + excluded.cards_done, seconds = days.seconds + excluded.seconds`)
    .bind(row.study_day, row.cards_done, row.seconds).run();
  const { results } = await c.db.prepare('SELECT study_day, completed, freeze_used FROM days').all();
  const s = streak(results, today, st);
  if (s.newFreezes.length) await upsertDaysStmt(c, s.newFreezes.map((d) => ({ study_day: d, freeze_used: 1 })), ['freeze_used']).run();
  return { streak: s.streak, freezesLeft: s.freezesLeft };
}

// ───────── 親の画面用 ─────────

async function uploadPhoto(c, role, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new Error('BAD_IMAGE');
  const bin = atob(m[2]);
  if (bin.length > PHOTO_MAX_BYTES) throw new Error('写真が大きすぎます（1.5MBまで）');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const photoId = id('p');
  await c.photos.prepare('INSERT INTO photos (id, mime, data, created_at) VALUES (?, ?, ?, ?)')
    .bind(photoId, m[1], bytes, new Date(c.now).toISOString()).run();
  return { id: photoId, url: await photoUrl(c, photoId) };
}

// list: 登録する問題の配列。各要素に make_read: true で読みカードも作る
async function addItems(c, role, list) {
  if (!Array.isArray(list) || list.length > 300) throw new Error('BAD_ARGS');
  const { results } = await c.db.prepare("SELECT type, sentence, answer, photo_q FROM items WHERE status <> 'deleted'").all();
  const existing = new Set(results.map(dupKey));
  const newItems = [], newCards = [], skipped = [];
  list.forEach((x, index) => {
    const n = normalizeItem(x);
    if (n.error) { skipped.push({ index, reason: n.error }); return; }
    const key = dupKey(n.item);
    if (existing.has(key)) { skipped.push({ index, reason: '登録済みです' }); return; }
    existing.add(key);
    // 同じ登録操作の中でも登録順に出題されるよう、1件ごとに1ミリ秒ずらす
    const it = { ...n.item, item_id: id('i'), registered_pool: n.item.pool, created_at: new Date(c.now + newItems.length).toISOString(), status: 'active' };
    newItems.push(it);
    const dirs = n.kanji ? (x.make_read || it.pool === 'new' ? ['write', 'read'] : ['write']) : ['single'];
    for (const d of dirs) {
      newCards.push({ card_id: id('c'), item_id: it.item_id, direction: d, stage: 0, due: '', state: 'new', reps: 0, lapses: 0,
        last_result: '', last_reviewed_at: '', introduced_on: '' });
    }
  });
  if (newItems.length) {
    await c.db.batch([
      c.db.prepare(`INSERT INTO items (${ITEM_COLS.join(', ')}) ${fromJson(ITEM_COLS)}`).bind(JSON.stringify(newItems)),
      c.db.prepare(`INSERT INTO cards (${CARD_COLS.join(', ')}) ${fromJson(CARD_COLS)}`).bind(JSON.stringify(newCards))
    ]);
  }
  return { added: newItems.length, cards: newCards.length, skipped };
}

// opts: { pool: 'mistake' | 'new'（省略ですべて）, unit: 単元, limit, offset }
// 新しい問題が千件以上あるため、登録先・単元で絞ってから集計する（無料プランの CPU 時間と通信量を抑える）
async function listItems(c, role, opts) {
  opts = opts || {};
  const where = ["status <> 'deleted'"], binds = [];
  if (['mistake', 'new'].includes(opts.pool)) { where.push('pool = ?'); binds.push(opts.pool); }
  if (typeof opts.unit === 'string' && opts.unit) { where.push('unit = ?'); binds.push(opts.unit); }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit) || 300)));
  const offset = Math.max(0, Math.floor(Number(opts.offset) || 0));
  const itemsRes = await c.db.prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY created_at DESC, item_id LIMIT ? OFFSET ?`)
    .bind(...binds, limit, offset).all();
  if (!itemsRes.results.length) return [];
  const ids = JSON.stringify(itemsRes.results.map((i) => i.item_id));
  const [cardAgg, revAgg, last5] = await c.db.batch([
    c.db.prepare(`SELECT item_id, MIN(stage) AS stage, COUNT(*) AS n,
        SUM(state IN ('spot', 'retired')) AS grad, SUM(state = 'new') AS fresh, SUM(state = 'known') AS known,
        MIN(CASE WHEN state = 'learning' AND due <> '' THEN due END) AS next,
        MAX(CASE WHEN state IN ('spot', 'retired') THEN substr(last_reviewed_at, 1, 10) END) AS graduated_on,
        MAX(lapses) AS lapses, group_concat(direction) AS dirs
      FROM cards WHERE item_id IN (SELECT value FROM json_each(?)) GROUP BY item_id`).bind(ids),
    c.db.prepare(`SELECT c.item_id, COUNT(*) AS reps, SUM(r.result = '○') AS ok FROM reviews r JOIN cards c ON c.card_id = r.card_id
      WHERE c.item_id IN (SELECT value FROM json_each(?)) GROUP BY c.item_id`).bind(ids),
    c.db.prepare(`SELECT item_id, result FROM (
        SELECT c.item_id, r.result, r.answered_at,
          ROW_NUMBER() OVER (PARTITION BY c.item_id ORDER BY r.answered_at DESC) AS rn
        FROM reviews r JOIN cards c ON c.card_id = r.card_id WHERE c.item_id IN (SELECT value FROM json_each(?)))
      WHERE rn <= 5 ORDER BY item_id, answered_at`).bind(ids)
  ]);
  const ca = Object.fromEntries(cardAgg.results.map((r) => [r.item_id, r]));
  const ra = Object.fromEntries(revAgg.results.map((r) => [r.item_id, r]));
  const l5 = {};
  for (const r of last5.results) (l5[r.item_id] = l5[r.item_id] || []).push(r.result);
  const out = [];
  for (const it of itemsRes.results) {
    const a = ca[it.item_id] || { stage: 0, n: 0, grad: 0, fresh: 0, next: null, graduated_on: null, lapses: 0, dirs: '' };
    const r = ra[it.item_id] || { reps: 0, ok: 0 };
    let state = 'learning';
    if (it.status === 'suspended') state = 'suspended';
    else if (a.n && a.grad === a.n) state = 'graduated';
    else if (a.n && a.known === a.n) state = 'known';
    else if (a.n && a.fresh === a.n) state = 'new';
    const dirs = String(a.dirs || '').split(',').filter(Boolean).sort((x, y) => ['write', 'read', 'single'].indexOf(x) - ['write', 'read', 'single'].indexOf(y));
    it.stats = {
      state, stage: a.stage || 0, next: a.next || '', graduated_on: a.graduated_on || '',
      reps: r.reps, correct: r.reps ? Math.round(r.ok / r.reps * 100) : null,
      last5: l5[it.item_id] || [], lapses: a.lapses || 0, directions: dirs
    };
    out.push(await withPhotoUrls(c, it));
  }
  return out;
}

// 一覧の絞り込み用: 登録先ごとの単元と件数
async function listUnits(c) {
  const { results } = await c.db.prepare(
    `SELECT pool, unit, COUNT(*) AS n, SUM(EXISTS (SELECT 1 FROM cards k WHERE k.item_id = items.item_id AND k.state = 'known')) AS known
     FROM items WHERE status <> 'deleted' GROUP BY pool, unit ORDER BY pool, MIN(created_at)`).all();
  return results;
}

// 登録前の重複チェック用に、問題を見分ける列だけを返す（一覧全体より軽い）
async function listKeys(c) {
  const { results } = await c.db.prepare("SELECT type, sentence, answer, photo_q FROM items WHERE status <> 'deleted'").all();
  return results.map((r) => [r.type, r.sentence, r.answer, r.photo_q]);
}

async function itemHistory(c, role, itemId) {
  const { results } = await c.db.prepare(
    `SELECT r.review_id, r.answered_at, r.study_day, r.result, c.direction, r.duration_sec, r.stage_before, r.stage_after
     FROM reviews r JOIN cards c ON c.card_id = r.card_id WHERE c.item_id = ? ORDER BY r.answered_at DESC LIMIT 30`).bind(String(itemId)).all();
  return results;
}

const EDITABLE = ['subject', 'unit', 'sentence', 'answer', 'reading', 'prompt_form', 'explanation', 'source', 'qno', 'source_date', 'reason', 'origin', 'pool'];

async function updateItem(c, role, itemId, fields) {
  fields = fields || {};
  const it = await c.db.prepare("SELECT * FROM items WHERE item_id = ? AND status <> 'deleted'").bind(String(itemId)).first();
  if (!it) throw new Error('NOT_FOUND');
  const merged = { ...it };
  for (const k of EDITABLE) if (Object.prototype.hasOwnProperty.call(fields, k)) merged[k] = fields[k];
  const n = normalizeItem(merged);
  if (n.error) throw new Error(n.error);
  await c.db.prepare(`UPDATE items SET ${EDITABLE.map((k) => k + ' = ?').join(', ')}, registered_pool = ? WHERE item_id = ?`)
    .bind(...EDITABLE.map((k) => n.item[k]), n.item.pool !== it.pool ? n.item.pool : it.registered_pool, it.item_id).run();
  return { ok: true };
}

async function setStatus(c, role, itemId, status) {
  if (!['active', 'suspended', 'deleted'].includes(status)) throw new Error('BAD_ARGS');
  const r = await c.db.prepare('UPDATE items SET status = ? WHERE item_id = ?').bind(status, String(itemId)).run();
  if (!r.meta.changes) throw new Error('NOT_FOUND');
  return { ok: true };
}

async function getOverview(c) {
  const st = await settings(c);
  const today = studyDay(c.now, st.day_start_hour);
  const last = addDays(today, 6);
  const [daysRes, countsRes, dueRes, strugRes] = await c.db.batch([
    c.db.prepare('SELECT study_day, completed, cards_done, seconds, freeze_used FROM days'),
    c.db.prepare(`SELECT COUNT(DISTINCT i.item_id) AS items, COUNT(c.card_id) AS cards,
        SUM(c.state IN ('spot', 'retired')) AS graduated, SUM(c.state = 'new' AND i.registered_pool = 'mistake') AS fresh,
        SUM(c.state = 'new' AND i.registered_pool = 'new') AS challenge, SUM(c.state = 'known') AS known
      FROM items i LEFT JOIN cards c ON c.item_id = i.item_id WHERE i.status = 'active'`),
    c.db.prepare(`SELECT CASE WHEN c.due < ?1 THEN ?1 ELSE c.due END AS day, COUNT(*) AS n
      FROM cards c JOIN items i ON i.item_id = c.item_id
      WHERE i.status = 'active' AND c.state IN ('learning', 'spot') AND c.due <> '' AND c.due <= ?2 GROUP BY 1`).bind(today, last),
    c.db.prepare(`SELECT i.item_id, MAX(c.lapses) AS lapses, i.answer, i.sentence, i.source, i.qno
      FROM cards c JOIN items i ON i.item_id = c.item_id WHERE i.status = 'active'
      GROUP BY i.item_id HAVING MAX(c.lapses) >= 3 ORDER BY lapses DESC LIMIT 10`)
  ]);
  const s = streak(daysRes.results, today, st);
  const todayRow = daysRes.results.find((r) => r.study_day === today) || {};
  const byDay = Object.fromEntries(dueRes.results.map((r) => [r.day, r.n]));
  const forecast = [];
  for (let i = 0; i < 7; i++) { const d = addDays(today, i); forecast.push({ day: d, count: byDay[d] || 0 }); }
  const photoRes = await c.photos.prepare('SELECT COUNT(*) AS n FROM photos').all();
  const cnt = countsRes.results[0];
  return {
    today, streak: s.streak, freezesLeft: s.freezesLeft,
    todayDone: !!todayRow.completed, todayCards: todayRow.cards_done || 0, todaySeconds: todayRow.seconds || 0,
    items: cnt.items || 0, cards: cnt.cards || 0, graduated: cnt.graduated || 0, fresh: cnt.fresh || 0,
    challenge: cnt.challenge || 0, known: cnt.known || 0,
    forecast, struggling: strugRes.results,
    photos: { count: photoRes.results[0].n, bytes: (photoRes.meta && photoRes.meta.size_after) || 0, limit: 500 * 1000 * 1000 }
  };
}

// ───────── 漢字図鑑 ─────────
// 1字＝熟語（item_id。多くは音読み）＋訓読みの語（kun_item_id。訓読みの無い字は無し）
// 語ごとの状態: n = まだ / k = 知ってた（チャレンジで○）/ l = 練習中 / g = 卒業。書き・読みのカードのうち、練習中が1枚でもあれば練習中、なければ卒業、知ってたの順
// マス全体（熟語・訓読みの両方で判定）: どれかが練習中 → l / 全部が知ってた・卒業 → 卒業が1つでもあれば g、なければ k / 一部だけ終えた → p（途中）/ それ以外 → n
const BADGES_GRAD = [10, 50, 100, 300];
const BADGES_STREAK = [7, 30, 100];
const wordState = (l, g, k) => (l ? 'l' : g ? 'g' : k ? 'k' : 'n');
function cellState(words) {
  if (words.includes('l')) return 'l';
  const done = words.filter((w) => w === 'k' || w === 'g').length;
  if (done === words.length) return words.includes('g') ? 'g' : 'k';
  return done ? 'p' : 'n';
}
async function getZukan(c) {
  const st = await settings(c);
  const today = studyDay(c.now, st.day_start_hour);
  const agg = (col, cond) => `COALESCE(SUM(c.item_id = k.${col} AND ${cond}), 0)`;
  const [rows, daysRes] = await c.db.batch([
    c.db.prepare(`SELECT k.char, k.grade, k.kun_item_id <> '' AS has_kun,
        ${agg('item_id', "c.state = 'learning'")} AS ol, ${agg('item_id', "c.state IN ('spot', 'retired')")} AS og, ${agg('item_id', "c.state = 'known'")} AS ok,
        ${agg('kun_item_id', "c.state = 'learning'")} AS kl, ${agg('kun_item_id', "c.state IN ('spot', 'retired')")} AS kg, ${agg('kun_item_id', "c.state = 'known'")} AS kk,
        MIN(CASE WHEN c.state = 'learning' THEN c.stage END) AS stage
      FROM kanji k LEFT JOIN items i ON i.item_id IN (k.item_id, k.kun_item_id) AND i.status = 'active' LEFT JOIN cards c ON c.item_id = i.item_id
      GROUP BY k.char ORDER BY k.grade, k.ord`),
    c.db.prepare('SELECT study_day, completed, freeze_used FROM days')
  ]);
  const count = { n: 0, p: 0, k: 0, l: 0, g: 0 };
  const chars = rows.results.map((r) => {
    const on = wordState(r.ol, r.og, r.ok);
    const kun = r.has_kun ? wordState(r.kl, r.kg, r.kk) : '';
    const s = cellState(kun ? [on, kun] : [on]);
    count[s]++;
    return [r.char, r.grade, s, s === 'l' ? r.stage || 0 : 0, on, kun];
  });
  const cur = streak(daysRes.results, today, st).streak;
  const best = Math.max(cur, bestStreak(daysRes.results));
  return {
    chars, count, total: chars.length, streak: cur, bestStreak: best,
    badges: BADGES_GRAD.map((n) => ({ kind: 'grad', n, got: count.g >= n }))
      .concat(BADGES_STREAK.map((n) => ({ kind: 'streak', n, got: best >= n })))
  };
}

// 図鑑でマスを押したとき: その字の熟語・訓読みの語（例文・意味）と、カードの状態
async function getKanjiInfo(c, role, ch) {
  if (typeof ch !== 'string' || !ch || ch.length > 2) throw new Error('BAD_ARGS');
  const k = await c.db.prepare('SELECT char, grade, item_id, kun_item_id FROM kanji WHERE char = ?').bind(ch).first();
  if (!k) throw new Error('NOT_FOUND');
  const ids = [['on', k.item_id], ['kun', k.kun_item_id]].filter((x) => x[1]);
  const [itemsRes, cardsRes] = ids.length
    ? await c.db.batch([
      c.db.prepare(`SELECT item_id, sentence, answer, reading, prompt_form, explanation, pool FROM items
        WHERE status = 'active' AND item_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids.map((x) => x[1]))),
      c.db.prepare(`SELECT item_id, direction, state, stage, due, reps, last_result FROM cards
        WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY direction DESC`).bind(JSON.stringify(ids.map((x) => x[1])))
    ])
    : [{ results: [] }, { results: [] }];
  const words = ids.map(([kind, id]) => {
    const it = itemsRes.results.find((r) => r.item_id === id);
    return it ? { kind, ...it, cards: cardsRes.results.filter((r) => r.item_id === id) } : { kind, item_id: null, cards: [] };
  });
  return { char: k.char, grade: k.grade, words };
}

// ───────── ダッシュボード（親） ─────────
// 改善 = ×が2回以上あって直近3回が続けて○ / 苦手 = ×が3回以上（改善したものは除く）
const LABEL_COLS = 'i.item_id, i.type, i.subject, i.sentence, i.answer, i.reading, i.prompt_form, i.photo_q, i.source, i.qno';
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
async function getDashboard(c) {
  const st = await settings(c);
  const today = studyDay(c.now, st.day_start_hour);
  const group = (key) => c.db.prepare(`SELECT ${key} AS k, COUNT(DISTINCT i.item_id) AS items, COUNT(r.review_id) AS reps,
      COALESCE(SUM(r.result = '×'), 0) AS x, COALESCE(SUM(r.result = '○'), 0) AS o
    FROM items i LEFT JOIN cards c ON c.item_id = i.item_id LEFT JOIN reviews r ON r.card_id = c.card_id
    WHERE i.status = 'active' AND i.pool = 'mistake' GROUP BY 1 ORDER BY items DESC`);
  const [trend, cal, byReason, bySubject, hist, durs] = await c.db.batch([
    c.db.prepare('SELECT study_day, cards_total, cards_retained FROM snapshots ORDER BY study_day DESC LIMIT 400'),
    c.db.prepare('SELECT study_day, completed, cards_done, seconds, freeze_used FROM days'),
    group(`CASE WHEN i.reason <> '' THEN i.reason WHEN i.registered_pool = 'new' THEN 'チャレンジで間違えた' ELSE '（未記入）' END`),
    group(`COALESCE(NULLIF(i.subject, ''), 'その他')`),
    c.db.prepare(`SELECT item_id, SUM(result = '×') AS x, SUM(rn <= 3) AS last3, SUM(rn <= 3 AND result = '○') AS last3o FROM (
        SELECT c.item_id, r.result, ROW_NUMBER() OVER (PARTITION BY c.item_id ORDER BY r.answered_at DESC) AS rn
        FROM reviews r JOIN cards c ON c.card_id = r.card_id JOIN items i ON i.item_id = c.item_id WHERE i.status = 'active')
      GROUP BY item_id HAVING x >= 2`),
    c.db.prepare(`SELECT c.direction, i.photo_q <> '' AS photo, r.duration_sec AS sec FROM reviews r
      JOIN cards c ON c.card_id = r.card_id JOIN items i ON i.item_id = c.item_id
      WHERE r.duration_sec > 0 AND r.study_day >= ? ORDER BY r.answered_at DESC LIMIT 3000`).bind(addDays(today, -60))
  ]);
  const improvedIds = [], weakIds = [];
  for (const r of hist.results) {
    if (r.last3 === 3 && r.last3o === 3) improvedIds.push(r.item_id);
    else if (r.x >= 3) weakIds.push(r.item_id);
  }
  const x = Object.fromEntries(hist.results.map((r) => [r.item_id, r.x]));
  const ids = improvedIds.concat(weakIds);
  const labels = ids.length
    ? Object.fromEntries((await c.db.prepare(`SELECT ${LABEL_COLS} FROM items i WHERE i.item_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids)).all()).results.map((r) => [r.item_id, r]))
    : {};
  const pick = (list) => list.filter((id) => labels[id]).sort((a, b) => x[b] - x[a]).slice(0, 20).map((id) => ({ ...labels[id], x: x[id] }));
  // 見積もり時間の実測（直近60日の中央値）。設定値と比べて、1日の量の見直しに使う
  const kinds = { write: [], read: [], single: [], photo: [] };
  for (const r of durs.results) kinds[r.photo ? 'photo' : r.direction] && kinds[r.photo ? 'photo' : r.direction].push(r.sec);
  const timing = Object.keys(kinds).map((k) => ({ kind: k, n: kinds[k].length, median: median(kinds[k]), setting: st['sec_' + k] }));
  return {
    today, trend: trend.results.reverse(), calendar: cal.results,
    byReason: byReason.results, bySubject: bySubject.results,
    improved: pick(improvedIds), weak: pick(weakIds), timing
  };
}

// CSV 書き出し用。CPU時間の上限に収まるよう1回5000行ずつ返す
const EXPORTS = {
  items: 'SELECT * FROM items ORDER BY created_at, item_id',
  cards: 'SELECT * FROM cards ORDER BY item_id, card_id',
  reviews: 'SELECT * FROM reviews ORDER BY answered_at, review_id',
  days: 'SELECT * FROM days ORDER BY study_day',
  snapshots: 'SELECT * FROM snapshots ORDER BY study_day'
};
async function exportTable(c, role, name, offset) {
  if (!EXPORTS[name]) throw new Error('BAD_ARGS');
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const { results } = await c.db.prepare(EXPORTS[name] + ' LIMIT 5000 OFFSET ?').bind(off).all();
  return { rows: results, next: results.length === 5000 ? off + 5000 : null };
}

// ───────── 解いた記録の削除（親だけ） ─────────
// 記録を消したら、残っている記録を古い順にたどり直してカードの状態（段階・次の出題日など）を作り直す

async function rebuildCards(c, cardIds) {
  if (!cardIds.length) return 0;
  const { results } = await c.db.prepare(
    'SELECT review_id, card_id, result, study_day, answered_at, mode FROM reviews WHERE card_id IN (SELECT value FROM json_each(?)) ORDER BY answered_at, review_id')
    .bind(JSON.stringify(cardIds)).all();
  const byCard = {};
  for (const id of cardIds) byCard[id] = [];
  for (const r of results) byCard[r.card_id].push(r);
  const cards = [], stageRows = [];
  const mistakeItems = new Set();
  for (const id of cardIds) {
    const { card, stages, toMistake } = replay(byCard[id]);
    if (toMistake) mistakeItems.add(id);
    cards.push({ card_id: id, ...card });
    for (const [rid, [before, after]] of Object.entries(stages)) stageRows.push({ review_id: rid, stage_before: before, stage_after: after });
  }
  const upd = ['state', 'stage', 'due', 'reps', 'lapses', 'last_result', 'last_reviewed_at', 'introduced_on'];
  const stmts = [c.db.prepare(`UPDATE cards SET ${upd.map((k) => `${k} = j.${k}`).join(', ')}
    FROM (SELECT ${['card_id', ...upd].map((k) => `json_extract(value, '$.${k}') AS ${k}`).join(', ')} FROM json_each(?)) AS j
    WHERE cards.card_id = j.card_id`).bind(JSON.stringify(cards))];
  if (stageRows.length) {
    stmts.push(c.db.prepare(`UPDATE reviews SET stage_before = j.stage_before, stage_after = j.stage_after
      FROM (SELECT json_extract(value, '$.review_id') AS review_id, json_extract(value, '$.stage_before') AS stage_before,
        json_extract(value, '$.stage_after') AS stage_after FROM json_each(?)) AS j
      WHERE reviews.review_id = j.review_id`).bind(JSON.stringify(stageRows)));
  }
  stmts.push(c.db.prepare(`UPDATE items SET pool = CASE WHEN EXISTS (
      SELECT 1 FROM cards c2 WHERE c2.item_id = items.item_id AND c2.card_id IN (SELECT value FROM json_each(?2))
    ) THEN 'mistake' ELSE registered_pool END
    WHERE item_id IN (SELECT item_id FROM cards WHERE card_id IN (SELECT value FROM json_each(?1)))`)
    .bind(JSON.stringify(cardIds), JSON.stringify([...mistakeItems])));
  await c.db.batch(stmts);
  return cards.length;
}

// 解答の記録を1件ずつ消す（問題の詳細の履歴から）
async function deleteReviews(c, role, reviewIds) {
  if (!Array.isArray(reviewIds) || !reviewIds.length || reviewIds.length > 500) throw new Error('BAD_ARGS');
  const ids = JSON.stringify(reviewIds.map(String));
  const { results } = await c.db.prepare('SELECT DISTINCT card_id FROM reviews WHERE review_id IN (SELECT value FROM json_each(?))').bind(ids).all();
  const r = await c.db.prepare('DELETE FROM reviews WHERE review_id IN (SELECT value FROM json_each(?))').bind(ids).run();
  await rebuildCards(c, results.map((x) => x.card_id));
  return { deleted: r.meta.changes };
}

// 1つの問題の記録をすべて消して、未出題に戻す
async function resetItem(c, role, itemId) {
  const { results } = await c.db.prepare('SELECT card_id FROM cards WHERE item_id = ?').bind(String(itemId)).all();
  if (!results.length) throw new Error('NOT_FOUND');
  const ids = results.map((x) => x.card_id);
  const r = await c.db.prepare('DELETE FROM reviews WHERE card_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).run();
  await rebuildCards(c, ids);
  return { deleted: r.meta.changes };
}

// ある日の記録をすべて消す（テストで解いた日を取り消す）。その日の「終えた」記録と、その日に出し始めたカードも元に戻す
async function resetDay(c, role, day) {
  day = String(day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('BAD_ARGS');
  const [revCards, introCards] = await c.db.batch([
    c.db.prepare('SELECT DISTINCT card_id FROM reviews WHERE study_day = ?').bind(day),
    c.db.prepare('SELECT card_id FROM cards WHERE introduced_on = ?').bind(day)
  ]);
  const ids = [...new Set(revCards.results.concat(introCards.results).map((x) => x.card_id))];
  const [delRev] = await c.db.batch([
    c.db.prepare('DELETE FROM reviews WHERE study_day = ?').bind(day),
    c.db.prepare('DELETE FROM days WHERE study_day = ?').bind(day),
    c.db.prepare('DELETE FROM snapshots WHERE study_day = ?').bind(day)
  ]);
  await rebuildCards(c, ids);
  return { deleted: delRev.meta.changes, cards: ids.length };
}

// ───────── 新しい問題のチャレンジ ─────────
// 登録先が「新しい問題」で、まだ解いていないカードを種類（単元）ごとに出す。10分の枠や連続日数とは別

const DECK = "COALESCE(NULLIF(i.unit, ''), i.subject, 'その他')";

async function getChallengeDecks(c) {
  const { results } = await c.db.prepare(
    `SELECT ${DECK} AS deck, COUNT(*) AS n, SUM(c.direction = 'write') AS write, SUM(c.direction = 'read') AS read, SUM(c.direction = 'single') AS single
     FROM cards c JOIN items i ON i.item_id = c.item_id
     WHERE i.status = 'active' AND i.registered_pool = 'new' AND c.state = 'new' GROUP BY 1 ORDER BY MIN(i.created_at)`).all();
  return results;
}

// dir: 'write'（書きだけ）/ 'read'（読みだけ）/ 'mix'（まぜる）。漢字以外の問題（single）はどれでも出す
// 出す順番はランダム。ただし、書きか読みを直近 RECENT_DAYS 日以内に解いた語は後回しにする
// （書きの答えの画面で見たばかりの語の読みが続けて出ると、覚えているかの確認にならないため）
const RECENT_DAYS = 3;
async function getChallenge(c, role, deck, limit, dir) {
  const n = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  dir = ['write', 'read'].includes(dir) ? dir : 'mix';
  const st = await settings(c);
  const since = addDays(studyDay(c.now, st.day_start_hour), -(RECENT_DAYS - 1));
  const { results } = await c.db.prepare(
    `SELECT c.card_id, c.direction, c.stage, c.state, ${ITEM_VIEW} FROM cards c JOIN items i ON i.item_id = c.item_id
     WHERE i.status = 'active' AND i.registered_pool = 'new' AND c.state = 'new' AND ${DECK} = ?1
       AND (?2 = 'mix' OR c.direction = 'single' OR c.direction = ?2)
     ORDER BY EXISTS (SELECT 1 FROM cards k JOIN reviews r ON r.card_id = k.card_id WHERE k.item_id = i.item_id AND r.study_day >= ?4),
       RANDOM() LIMIT ?3`).bind(String(deck || ''), dir, n * 2 + 2, since).all();
  // 同じ語は1回に1枚だけ（読みの問題には書きの答えがそのまま出るため）。まぜるときは語ごとに書き・読みをランダムに選ぶ
  const byItem = new Map();
  for (const r of results) (byItem.get(r.item_id) || byItem.set(r.item_id, []).get(r.item_id)).push(r);
  const out = [];
  for (const cards of byItem.values()) {
    if (out.length >= n) break;
    out.push(await withPhotoUrls(c, cards[cards.length > 1 ? randomInt(cards.length) : 0]));
  }
  return out;
}

function randomInt(n) { return crypto.getRandomValues(new Uint32Array(1))[0] % n; }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
