// 漢字SRS Phase 1（MVP）サーバー
// 画面は GitHub Pages（app/）に置き、ここは JSON API（doPost）だけを受け持つ。
// 13歳未満の Google 子どもアカウントでは script.google.com の画面が開けないため（Phase 0 で確認）。

// 初回のみ: 両方に6桁以上の別々の数字を入れて setup() を実行する。実行後は空に戻してよい（スクリプトプロパティに保存される）
const SETUP_STUDY_PIN = ''; // 子どものタブレット用（解答だけできる）
const SETUP_ADMIN_PIN = ''; // 親用（登録・修正・削除もできる）

const TZ = 'Asia/Tokyo';
const PHOTO_FOLDER_NAME = 'KanjiSRS_photos';
const INTERVALS = [1, 3, 7, 14, 30, 60]; // 段階 s で○なら INTERVALS[s] 日後
const MAX_STAGE = INTERVALS.length;      // 6: 60日後の復習待ち。ここで○なら卒業
const SPOT_DAYS = 180;                   // 卒業後の抜き打ちまでの日数
const SPOT_RETRY_DAYS = 30;              // 抜き打ちで△のとき
const MAX_TEXT = 500;

const COLUMNS = {
  items: ['item_id', 'type', 'subject', 'unit', 'sentence', 'answer', 'reading', 'prompt_form', 'explanation',
    'photo_q', 'photo_a', 'source', 'qno', 'source_date', 'reason', 'origin', 'created_at', 'status'],
  cards: ['card_id', 'item_id', 'direction', 'stage', 'due', 'state', 'reps', 'lapses', 'last_result',
    'last_reviewed_at', 'introduced_on'],
  reviews: ['review_id', 'card_id', 'answered_at', 'study_day', 'result', 'duration_sec', 'stage_before', 'stage_after'],
  days: ['study_day', 'completed', 'cards_done', 'seconds', 'freeze_used'],
  settings: ['key', 'value']
};
const NUMERIC = {
  cards: ['stage', 'reps', 'lapses'],
  reviews: ['duration_sec', 'stage_before', 'stage_after'],
  days: ['completed', 'cards_done', 'seconds', 'freeze_used']
};
const DEFAULT_SETTINGS = {
  daily_seconds: 600, new_per_day: 4, day_start_hour: 3, freezes_per_month: 2,
  sec_read: 10, sec_write: 20, sec_single: 15, sec_photo: 90
};
const RESULT_MARK = { o: '○', t: '△', x: '×' };

// ───────── セットアップ ─────────

function setup() {
  const props = PropertiesService.getScriptProperties();
  const pins = [SETUP_STUDY_PIN, SETUP_ADMIN_PIN];
  if (pins.some(function (p) { return p; })) {
    if (!pins.every(function (p) { return /^\d{6,}$/.test(p); })) {
      throw new Error('SETUP_STUDY_PIN と SETUP_ADMIN_PIN の両方に6桁以上の数字を入れてください');
    }
    if (SETUP_STUDY_PIN === SETUP_ADMIN_PIN) throw new Error('学習用と親用のPINは別の数字にしてください');
    props.setProperty('STUDY_PIN', SETUP_STUDY_PIN);
    props.setProperty('ADMIN_PIN', SETUP_ADMIN_PIN);
  } else if (!props.getProperty('STUDY_PIN') || !props.getProperty('ADMIN_PIN')) {
    throw new Error('初回は SETUP_STUDY_PIN と SETUP_ADMIN_PIN を入れてから実行してください');
  }
  props.deleteProperty('PIN'); // Phase 0 検証用のPIN

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(COLUMNS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const cols = COLUMNS[name];
    // 日付文字列が日付型に化けないよう、全セルを書式なしテキストにする（追加行は上の行の書式を引き継ぐ）
    sh.getRange(1, 1, sh.getMaxRows(), cols.length).setNumberFormat('@');
    sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    sh.setFrozenRows(1);
  });
  ['spike_log', 'spike_bulk'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s) ss.deleteSheet(s);
  });

  const st = table_('settings');
  const have = {};
  st.rows.forEach(function (r) { have[r.key] = true; });
  st.append(Object.keys(DEFAULT_SETTINGS).filter(function (k) { return !have[k]; })
    .map(function (k) { return { key: k, value: String(DEFAULT_SETTINGS[k]) }; }));

  let folderId = props.getProperty('PHOTO_FOLDER_ID');
  if (!folderId) {
    folderId = Drive.Files.create({ name: PHOTO_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      null, { fields: 'id' }).id;
    props.setProperty('PHOTO_FOLDER_ID', folderId);
  }
  const folderName = Drive.Files.get(folderId, { fields: 'name' }).name;
  Logger.log('OK: sheets=%s folder=%s', Object.keys(COLUMNS).join(','), folderName);
}

// ───────── 入口 ─────────

function doGet() {
  return ContentService.createTextOutput('kanji-srs API OK');
}

// 要求: POST text/plain {"fn": "...", "pin": "...", "args": [...]}
// 各関数は (role, ...args) を受け取る
const API_ = {
  whoami: ['study', function (role) { return { role: role }; }],
  getToday: ['study', getToday_],
  submitReviews: ['study', submitReviews_],
  finishDay: ['study', finishDay_],
  getPhoto: ['study', getPhoto_],
  addItems: ['admin', addItems_],
  uploadPhoto: ['admin', uploadPhoto_],
  listItems: ['admin', listItems_],
  itemHistory: ['admin', itemHistory_],
  updateItem: ['admin', updateItem_],
  setStatus: ['admin', setStatus_],
  getOverview: ['admin', getOverview_]
};

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (!Object.prototype.hasOwnProperty.call(API_, req.fn)) throw new Error('UNKNOWN_FN');
    const def = API_[req.fn];
    const role = auth_(req.pin, def[0]);
    out = { ok: true, result: def[1].apply(null, [role].concat(req.args || [])) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// 「全員（匿名）」公開なので全APIでPINを確認する。失敗10回で10分ロック
function auth_(pin, need) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinFails') || 0);
  if (fails >= 10) throw new Error('LOCKED');
  const props = PropertiesService.getScriptProperties();
  const admin = props.getProperty('ADMIN_PIN');
  const study = props.getProperty('STUDY_PIN');
  if (!admin || !study) throw new Error('NOT_SETUP');
  const p = String(pin || '');
  const role = p === admin ? 'admin' : (p === study ? 'study' : '');
  if (!role) {
    cache.put('pinFails', String(fails + 1), 600);
    throw new Error('BAD_PIN');
  }
  if (need === 'admin' && role !== 'admin') throw new Error('FORBIDDEN');
  return role;
}

// ───────── 共通部品 ─────────

function nowMs_() { return Date.now(); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// 1日の区切りは day_start_hour 時（既定 午前3時）
function studyDay_(ms, startHour) {
  return Utilities.formatDate(new Date(ms - startHour * 3600000), TZ, 'yyyy-MM-dd');
}

function addDays_(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function id_(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 12); }

// 数式として解釈されないよう、= + - @ 始まりは ' を付けて書き込む
function cell_(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function table_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('NOT_SETUP: setup() が未実行');
  const cols = COLUMNS[name];
  const nums = NUMERIC[name] || [];
  const values = sh.getDataRange().getDisplayValues();
  const rows = values.slice(1).map(function (v, i) {
    const o = { _row: i + 2 };
    cols.forEach(function (c, j) {
      let x = v[j] === undefined ? '' : v[j];
      if (/^'[=+\-@]/.test(x)) x = x.slice(1);
      o[c] = nums.indexOf(c) >= 0 ? Number(x || 0) : x;
    });
    return o;
  }).filter(function (o) { return o[cols[0]] !== ''; });
  const toRow = function (o) { return cols.map(function (c) { return cell_(o[c]); }); };
  return {
    rows: rows,
    update: function (o) { sh.getRange(o._row, 1, 1, cols.length).setValues([toRow(o)]); },
    append: function (objs) {
      if (!objs.length) return;
      const start = sh.getLastRow() + 1;
      const last = start + objs.length - 1;
      if (last > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), last - sh.getMaxRows() + 200);
      sh.getRange(start, 1, objs.length, cols.length).setValues(objs.map(toRow));
      objs.forEach(function (o, i) { o._row = start + i; rows.push(o); });
    }
  };
}

function settings_() {
  const s = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { s[k] = DEFAULT_SETTINGS[k]; });
  table_('settings').rows.forEach(function (r) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, r.key) && r.value !== '' && isFinite(Number(r.value))) {
      s[r.key] = Number(r.value);
    }
  });
  return s;
}

function indexBy_(rows, key) {
  const m = {};
  rows.forEach(function (r) { m[r[key]] = r; });
  return m;
}

// ───────── 復習ルール（固定間隔） ─────────

// 戻り値: { state, stage, due, lapse }
function schedule_(state, stage, result, day) {
  if (state === 'spot') {
    if (result === 'o') return { state: 'retired', stage: MAX_STAGE, due: '' };
    if (result === 'x') return { state: 'learning', stage: 0, due: addDays_(day, 1), lapse: true };
    return { state: 'spot', stage: MAX_STAGE, due: addDays_(day, SPOT_RETRY_DAYS) };
  }
  if (result === 'o') {
    if (stage >= MAX_STAGE) return { state: 'spot', stage: MAX_STAGE, due: addDays_(day, SPOT_DAYS) };
    return { state: 'learning', stage: stage + 1, due: addDays_(day, INTERVALS[stage]) };
  }
  if (result === 't') return { state: 'learning', stage: stage, due: addDays_(day, INTERVALS[Math.max(stage - 1, 0)]) };
  return { state: 'learning', stage: 0, due: addDays_(day, 1), lapse: true };
}

function cost_(card, item, st) {
  if (card.direction === 'write') return st.sec_write;
  if (card.direction === 'read') return st.sec_read;
  return item && item.photo_q ? st.sec_photo : st.sec_single;
}

function isGraduated_(c) { return c.state === 'spot' || c.state === 'retired'; }

// ───────── 連続日数とお休みチケット ─────────

// 解かなかった日の並び（gap）が、その月の残りチケットで埋まるときだけチケットを使う。
// 埋まらない＝連続が切れているときは使わない（無駄遣いしない）
function streak_(days, today, st, persist) {
  const map = indexBy_(days.rows, 'study_day');
  const usedByMonth = {};
  let first = '';
  days.rows.forEach(function (r) {
    if (!first || r.study_day < first) first = r.study_day;
    if (r.freeze_used) usedByMonth[r.study_day.slice(0, 7)] = (usedByMonth[r.study_day.slice(0, 7)] || 0) + 1;
  });
  const kept = function (d) { return map[d] && (map[d].completed || map[d].freeze_used); };
  let count = map[today] && map[today].completed ? 1 : 0;
  let d = addDays_(today, -1);
  while (first && d >= first) {
    if (map[d] && map[d].completed) { count++; d = addDays_(d, -1); continue; }
    if (kept(d)) { d = addDays_(d, -1); continue; }
    const gap = [];
    let g = d;
    while (g >= first && !kept(g)) { gap.push(g); g = addDays_(g, -1); }
    if (g < first) break;
    const need = {};
    gap.forEach(function (x) { need[x.slice(0, 7)] = (need[x.slice(0, 7)] || 0) + 1; });
    const ok = Object.keys(need).every(function (m) { return (usedByMonth[m] || 0) + need[m] <= st.freezes_per_month; });
    if (!ok) break;
    gap.forEach(function (x) {
      usedByMonth[x.slice(0, 7)] = (usedByMonth[x.slice(0, 7)] || 0) + 1;
      if (persist) upsertDay_(days, x, { freeze_used: 1 });
      else map[x] = { study_day: x, freeze_used: 1 };
    });
    d = g;
  }
  return { streak: count, freezesLeft: Math.max(0, st.freezes_per_month - (usedByMonth[today.slice(0, 7)] || 0)) };
}

function upsertDay_(days, day, fields) {
  let r = days.rows.find(function (x) { return x.study_day === day; });
  if (!r) {
    r = { study_day: day, completed: 0, cards_done: 0, seconds: 0, freeze_used: 0 };
    Object.keys(fields).forEach(function (k) { r[k] = fields[k]; });
    days.append([r]);
  } else {
    Object.keys(fields).forEach(function (k) { r[k] = fields[k]; });
    days.update(r);
  }
  return r;
}

// ───────── 子どもの画面用 ─────────

function getToday_() {
  return withLock_(function () {
    const st = settings_();
    const today = studyDay_(nowMs_(), st.day_start_hour);
    const items = table_('items');
    const cards = table_('cards');
    const days = table_('days');
    const reviews = table_('reviews');
    const itemMap = {};
    items.rows.forEach(function (i) { if (i.status === 'active') itemMap[i.item_id] = i; });
    const cardMap = indexBy_(cards.rows, 'card_id');
    const cost = function (c) { return cost_(c, itemMap[c.item_id], st); };

    const todayRow = days.rows.find(function (r) { return r.study_day === today; });
    let done = !!(todayRow && todayRow.completed);
    const queue = [];
    if (!done) {
      let spent = 0;
      reviews.rows.forEach(function (r) {
        if (r.study_day === today && cardMap[r.card_id]) spent += cost(cardMap[r.card_id]);
      });
      let budget = st.daily_seconds - spent;
      const rank = function (c) { return c.state === 'spot' ? 99 : c.stage; };
      const due = cards.rows.filter(function (c) {
        return itemMap[c.item_id] && (c.state === 'learning' || c.state === 'spot') && c.due && c.due <= today;
      }).sort(function (a, b) { return rank(a) - rank(b) || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0); });
      due.forEach(function (c) {
        const k = cost(c);
        // その日まだ1問も解いていなければ、予算を超える1問目でも出す
        if (k <= budget || (spent === 0 && queue.length === 0)) { queue.push(c); budget -= k; }
      });

      let allowance = st.new_per_day - cards.rows.filter(function (c) { return c.introduced_on === today; }).length;
      const prio = function (c) { const o = itemMap[c.item_id].origin; return o === '塾' || o === '模試' ? 0 : 1; };
      const fresh = cards.rows.filter(function (c) { return c.state === 'new' && itemMap[c.item_id]; })
        .sort(function (a, b) {
          const ia = itemMap[a.item_id], ib = itemMap[b.item_id];
          return prio(a) - prio(b) || (ia.created_at < ib.created_at ? -1 : ia.created_at > ib.created_at ? 1 : 0) ||
            (a.card_id < b.card_id ? -1 : 1);
        });
      for (let i = 0; i < fresh.length && allowance > 0; i++) {
        const c = fresh[i];
        const k = cost(c);
        if (k > budget && !(spent === 0 && queue.length === 0)) break;
        c.state = 'learning';
        c.stage = 0;
        c.due = today;
        c.introduced_on = today;
        cards.update(c);
        queue.push(c);
        budget -= k;
        allowance--;
      }
      // 出す問題が無い日は自動で「終えた日」にする
      if (!queue.length) {
        upsertDay_(days, today, { completed: 1 });
        done = true;
      }
    }
    const s = streak_(days, today, st, true);
    let graduated = 0;
    cards.rows.forEach(function (c) { if (itemMap[c.item_id] && isGraduated_(c)) graduated++; });
    let est = 0;
    const out = queue.map(function (c) { est += cost(c); return cardView_(c, itemMap[c.item_id]); });
    return { today: today, done: done, cards: out, estSeconds: est, streak: s.streak, freezesLeft: s.freezesLeft, graduated: graduated };
  });
}

function cardView_(c, it) {
  return {
    card_id: c.card_id, direction: c.direction, stage: c.stage, state: c.state,
    type: it.type, subject: it.subject, unit: it.unit, sentence: it.sentence, answer: it.answer, reading: it.reading,
    prompt_form: it.prompt_form, explanation: it.explanation, photo_q: it.photo_q, photo_a: it.photo_a,
    source: it.source, qno: it.qno, reason: it.reason
  };
}

// list: [{review_id, card_id, result: 'o'|'t'|'x', answered_at: ISO文字列, duration_sec}]
// 同じ review_id は二度反映しない（通信失敗時の再送に備える）
function submitReviews_(role, list) {
  if (!Array.isArray(list)) throw new Error('BAD_ARGS');
  return withLock_(function () {
    const st = settings_();
    const now = nowMs_();
    const cards = table_('cards');
    const reviews = table_('reviews');
    const cardMap = indexBy_(cards.rows, 'card_id');
    const seen = {};
    reviews.rows.forEach(function (r) { seen[r.review_id] = true; });
    const sorted = list.slice().sort(function (a, b) { return String(a.answered_at) < String(b.answered_at) ? -1 : 1; });
    const added = [];
    let duplicates = 0, skipped = 0;
    sorted.forEach(function (r) {
      const rid = String(r && r.review_id || '');
      if (!/^[\w-]{8,64}$/.test(rid) || !RESULT_MARK[r.result]) { skipped++; return; }
      if (seen[rid]) { duplicates++; return; }
      const c = cardMap[r.card_id];
      if (!c || c.state === 'new' || c.state === 'retired' || c.state === 'suspended') { skipped++; return; }
      let ms = Date.parse(r.answered_at);
      if (!isFinite(ms) || ms > now + 5 * 60000 || ms < now - 14 * 86400000) ms = now;
      const day = studyDay_(ms, st.day_start_hour);
      const before = c.stage;
      const n = schedule_(c.state, c.stage, r.result, day);
      c.state = n.state;
      c.stage = n.stage;
      c.due = n.due;
      c.reps += 1;
      if (n.lapse) c.lapses += 1;
      c.last_result = RESULT_MARK[r.result];
      c.last_reviewed_at = new Date(ms).toISOString();
      cards.update(c);
      added.push({
        review_id: rid, card_id: c.card_id, answered_at: new Date(ms).toISOString(), study_day: day,
        result: RESULT_MARK[r.result], duration_sec: Math.max(0, Math.min(600, Math.round(Number(r.duration_sec) || 0))),
        stage_before: before, stage_after: n.stage
      });
      seen[rid] = true;
    });
    reviews.append(added);
    return { applied: added.length, duplicates: duplicates, skipped: skipped };
  });
}

// info: { day, cards_done, seconds }
function finishDay_(role, info) {
  info = info || {};
  return withLock_(function () {
    const st = settings_();
    const today = studyDay_(nowMs_(), st.day_start_hour);
    // 午前3時をまたいで終えた場合は、始めた日（前日まで）を完了にする
    const day = info.day === addDays_(today, -1) ? info.day : today;
    const days = table_('days');
    upsertDay_(days, day, {
      completed: 1,
      cards_done: Math.max(0, Math.round(Number(info.cards_done) || 0)),
      seconds: Math.max(0, Math.round(Number(info.seconds) || 0))
    });
    return streak_(days, today, st, true);
  });
}

function photoFolderId_() {
  const id = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  if (!id) throw new Error('NOT_SETUP: setup() が未実行');
  return id;
}

// DriveApp は drive.file スコープで動かないため Drive API（Advanced Service v3）と UrlFetchApp を使う（Phase 0 で確認）
function getPhoto_(role, id) {
  id = String(id);
  if (!/^[\w-]+$/.test(id)) throw new Error('NOT_FOUND');
  const meta = Drive.Files.get(id, { fields: 'parents,mimeType' });
  if (!meta.parents || meta.parents.indexOf(photoFolderId_()) < 0) throw new Error('NOT_FOUND');
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  return { dataUrl: 'data:' + meta.mimeType + ';base64,' + Utilities.base64Encode(res.getContent()) };
}

// ───────── 親の画面用 ─────────

function uploadPhoto_(role, dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new Error('BAD_IMAGE');
  const bytes = Utilities.base64Decode(m[2]);
  const name = 'q_' + Utilities.formatDate(new Date(nowMs_()), TZ, 'yyyyMMdd_HHmmss') + '.jpg';
  const file = Drive.Files.create({ name: name, parents: [photoFolderId_()], mimeType: m[1] },
    Utilities.newBlob(bytes, m[1], name), { fields: 'id' });
  return { id: file.id };
}

const HIRAGANA_ = /^[ぁ-ゟー]+$/;
const KANA_ = /^[ぁ-ゟァ-ヿー]+$/;

// 登録・修正の入力を整えて検証する。戻り値 { item, kanji, error }
function normalizeItem_(x) {
  x = x || {};
  const s = function (k) { return String(x[k] === undefined || x[k] === null ? '' : x[k]).trim().slice(0, MAX_TEXT); };
  const it = {
    type: s('type'), subject: s('subject'), unit: s('unit'), sentence: s('sentence'), answer: s('answer'),
    reading: s('reading'), prompt_form: s('prompt_form'), explanation: s('explanation'),
    photo_q: s('photo_q'), photo_a: s('photo_a'), source: s('source'), qno: s('qno'),
    source_date: s('source_date'), reason: s('reason'), origin: s('origin') || 'その他'
  };
  if (['A', 'B', 'C'].indexOf(it.type) < 0) return { error: '型が不正です' };
  if ((it.photo_q && !/^[\w-]+$/.test(it.photo_q)) || (it.photo_a && !/^[\w-]+$/.test(it.photo_a))) return { error: '写真IDが不正です' };
  if (it.source_date && !/^\d{4}-\d{2}-\d{2}$/.test(it.source_date)) return { error: '日付は YYYY-MM-DD で入力してください' };
  const kanji = it.type === 'A' && !!it.reading;
  if (kanji) {
    if (!it.sentence || !it.answer) return { error: '例文と答えが必要です' };
    if (it.sentence.indexOf(it.answer) < 0) return { error: '例文に「' + it.answer + '」がありません' };
    if (!HIRAGANA_.test(it.reading)) return { error: '読みはひらがなで入力してください' };
    if (it.prompt_form && !KANA_.test(it.prompt_form)) return { error: '出題表記はかなで入力してください' };
  } else if (!it.sentence && !it.photo_q) {
    return { error: '問題文か問題の写真が必要です' };
  } else if (it.type === 'A' && !it.answer) {
    return { error: '答えが必要です' };
  }
  return { item: it, kanji: kanji };
}

function dupKey_(it) { return [it.type, it.sentence, it.answer, it.photo_q].join('|'); }

// list: 登録する問題の配列。各要素に make_read: true で読みカードも作る
function addItems_(role, list) {
  if (!Array.isArray(list) || list.length > 300) throw new Error('BAD_ARGS');
  return withLock_(function () {
    const items = table_('items');
    const cards = table_('cards');
    const existing = {};
    items.rows.forEach(function (i) { if (i.status !== 'deleted') existing[dupKey_(i)] = true; });
    const newItems = [], newCards = [], skipped = [];
    const now = new Date(nowMs_()).toISOString();
    list.forEach(function (x, index) {
      const n = normalizeItem_(x);
      if (n.error) { skipped.push({ index: index, reason: n.error }); return; }
      const key = dupKey_(n.item);
      if (existing[key]) { skipped.push({ index: index, reason: '登録済みです' }); return; }
      existing[key] = true;
      const it = n.item;
      it.item_id = id_('i');
      it.created_at = now;
      it.status = 'active';
      newItems.push(it);
      const dirs = n.kanji ? (x.make_read ? ['write', 'read'] : ['write']) : ['single'];
      dirs.forEach(function (d) {
        newCards.push({
          card_id: id_('c'), item_id: it.item_id, direction: d, stage: 0, due: '', state: 'new',
          reps: 0, lapses: 0, last_result: '', last_reviewed_at: '', introduced_on: ''
        });
      });
    });
    items.append(newItems);
    cards.append(newCards);
    return { added: newItems.length, cards: newCards.length, skipped: skipped };
  });
}

function itemStats_(itemRows, cardRows, reviewRows) {
  const cardsByItem = {};
  cardRows.forEach(function (c) { (cardsByItem[c.item_id] = cardsByItem[c.item_id] || []).push(c); });
  const itemOfCard = {};
  cardRows.forEach(function (c) { itemOfCard[c.card_id] = c.item_id; });
  const revByItem = {};
  reviewRows.forEach(function (r) {
    const iid = itemOfCard[r.card_id];
    if (iid) (revByItem[iid] = revByItem[iid] || []).push(r);
  });
  return itemRows.map(function (it) {
    const cs = cardsByItem[it.item_id] || [];
    const rs = (revByItem[it.item_id] || []).sort(function (a, b) { return a.answered_at < b.answered_at ? -1 : 1; });
    const ok = rs.filter(function (r) { return r.result === '○'; }).length;
    let state = 'learning';
    if (it.status === 'suspended') state = 'suspended';
    else if (cs.length && cs.every(isGraduated_)) state = 'graduated';
    else if (cs.length && cs.every(function (c) { return c.state === 'new'; })) state = 'new';
    let next = '';
    cs.forEach(function (c) { if (c.due && !isGraduated_(c) && (!next || c.due < next)) next = c.due; });
    let graduatedOn = '';
    if (state === 'graduated') cs.forEach(function (c) { const d = c.last_reviewed_at.slice(0, 10); if (d > graduatedOn) graduatedOn = d; });
    const v = {};
    Object.keys(it).forEach(function (k) { if (k !== '_row') v[k] = it[k]; });
    v.stats = {
      state: state,
      stage: cs.length ? Math.min.apply(null, cs.map(function (c) { return c.stage; })) : 0,
      next: next,
      graduated_on: graduatedOn,
      reps: rs.length,
      correct: rs.length ? Math.round(ok / rs.length * 100) : null,
      last5: rs.slice(-5).map(function (r) { return r.result; }),
      lapses: cs.reduce(function (m, c) { return Math.max(m, c.lapses); }, 0),
      directions: cs.map(function (c) { return c.direction; })
    };
    return v;
  });
}

function listItems_() {
  const items = table_('items').rows.filter(function (i) { return i.status !== 'deleted'; });
  const out = itemStats_(items, table_('cards').rows, table_('reviews').rows);
  return out.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
}

function itemHistory_(role, itemId) {
  const cards = table_('cards').rows.filter(function (c) { return c.item_id === itemId; });
  const dir = {};
  cards.forEach(function (c) { dir[c.card_id] = c.direction; });
  return table_('reviews').rows.filter(function (r) { return dir[r.card_id]; })
    .sort(function (a, b) { return a.answered_at < b.answered_at ? 1 : -1; })
    .slice(0, 30)
    .map(function (r) {
      return { answered_at: r.answered_at, study_day: r.study_day, result: r.result, direction: dir[r.card_id],
        duration_sec: r.duration_sec, stage_before: r.stage_before, stage_after: r.stage_after };
    });
}

const EDITABLE_ = ['subject', 'unit', 'sentence', 'answer', 'reading', 'prompt_form', 'explanation',
  'source', 'qno', 'source_date', 'reason', 'origin'];

function updateItem_(role, itemId, fields) {
  fields = fields || {};
  return withLock_(function () {
    const items = table_('items');
    const it = items.rows.find(function (i) { return i.item_id === itemId && i.status !== 'deleted'; });
    if (!it) throw new Error('NOT_FOUND');
    const merged = {};
    COLUMNS.items.forEach(function (c) { merged[c] = it[c]; });
    EDITABLE_.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(fields, k)) merged[k] = fields[k]; });
    const n = normalizeItem_(merged);
    if (n.error) throw new Error(n.error);
    EDITABLE_.forEach(function (k) { it[k] = n.item[k]; });
    items.update(it);
    return { ok: true };
  });
}

function setStatus_(role, itemId, status) {
  if (['active', 'suspended', 'deleted'].indexOf(status) < 0) throw new Error('BAD_ARGS');
  return withLock_(function () {
    const items = table_('items');
    const it = items.rows.find(function (i) { return i.item_id === itemId; });
    if (!it) throw new Error('NOT_FOUND');
    it.status = status;
    items.update(it);
    return { ok: true };
  });
}

function getOverview_() {
  const st = settings_();
  const today = studyDay_(nowMs_(), st.day_start_hour);
  const items = table_('items').rows;
  const cards = table_('cards').rows;
  const days = table_('days');
  const active = {};
  items.forEach(function (i) { if (i.status === 'active') active[i.item_id] = i; });
  const s = streak_(days, today, st, false);
  const todayRow = days.rows.find(function (r) { return r.study_day === today; }) || {};
  const forecast = [];
  for (let i = 0; i < 7; i++) forecast.push({ day: addDays_(today, i), count: 0 });
  let graduated = 0, fresh = 0;
  cards.forEach(function (c) {
    if (!active[c.item_id]) return;
    if (isGraduated_(c)) graduated++;
    if (c.state === 'new') fresh++;
    if ((c.state === 'learning' || c.state === 'spot') && c.due) {
      const idx = c.due <= today ? 0 : forecast.findIndex(function (f) { return f.day === c.due; });
      if (idx >= 0) forecast[idx].count++;
    }
  });
  const lapsesByItem = {};
  cards.forEach(function (c) {
    if (active[c.item_id]) lapsesByItem[c.item_id] = Math.max(lapsesByItem[c.item_id] || 0, c.lapses);
  });
  const struggling = Object.keys(lapsesByItem).filter(function (k) { return lapsesByItem[k] >= 3; })
    .sort(function (a, b) { return lapsesByItem[b] - lapsesByItem[a]; }).slice(0, 10)
    .map(function (k) {
      const it = active[k];
      return { item_id: k, lapses: lapsesByItem[k], answer: it.answer, sentence: it.sentence, source: it.source, qno: it.qno };
    });
  return {
    today: today, streak: s.streak, freezesLeft: s.freezesLeft,
    todayDone: !!todayRow.completed, todayCards: todayRow.cards_done || 0, todaySeconds: todayRow.seconds || 0,
    items: Object.keys(active).length, cards: cards.filter(function (c) { return active[c.item_id]; }).length,
    graduated: graduated, fresh: fresh, forecast: forecast, struggling: struggling
  };
}
