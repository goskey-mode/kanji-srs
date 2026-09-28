// 復習ルールなど、データベースに依存しない計算（gas/Code.gs から移植）

export const INTERVALS = [1, 3, 7, 14, 30, 60]; // 段階 s で○なら INTERVALS[s] 日後
export const MAX_STAGE = INTERVALS.length;      // 6: 60日後の復習待ち。ここで○なら卒業
export const SPOT_DAYS = 180;                   // 卒業後の抜き打ちまで
export const SPOT_RETRY_DAYS = 30;              // 抜き打ちで△のとき
export const MAX_TEXT = 500;
export const RESULT_MARK = { o: '○', t: '△', x: '×' };

export const DEFAULT_SETTINGS = {
  daily_seconds: 600, new_per_day: 4, day_start_hour: 3, freezes_per_month: 2,
  sec_read: 10, sec_write: 20, sec_single: 15, sec_photo: 90
};

// 1日の区切りは day_start_hour 時（既定 午前3時）。日本時間（UTC+9、夏時間なし）
export function studyDay(ms, startHour) {
  return new Date(ms + (9 - startHour) * 3600000).toISOString().slice(0, 10);
}

export function addDays(day, n) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// 戻り値: { state, stage, due, lapse }
export function schedule(state, stage, result, day) {
  if (state === 'spot') {
    if (result === 'o') return { state: 'retired', stage: MAX_STAGE, due: '' };
    if (result === 'x') return { state: 'learning', stage: 0, due: addDays(day, 1), lapse: true };
    return { state: 'spot', stage: MAX_STAGE, due: addDays(day, SPOT_RETRY_DAYS) };
  }
  if (result === 'o') {
    if (stage >= MAX_STAGE) return { state: 'spot', stage: MAX_STAGE, due: addDays(day, SPOT_DAYS) };
    return { state: 'learning', stage: stage + 1, due: addDays(day, INTERVALS[stage]) };
  }
  if (result === 't') return { state: 'learning', stage, due: addDays(day, INTERVALS[Math.max(stage - 1, 0)]) };
  return { state: 'learning', stage: 0, due: addDays(day, 1), lapse: true };
}

const RESULT_CODE = { '○': 'o', '△': 't', '×': 'x' };

// 1回の解答でカードの状態を進める。mode: 'daily'（毎日の復習）/ 'new'（新しい問題のチャレンジ）
// チャレンジで初めて解いた新しいカードは、○ → known（覚えていた。もう出さない）、△・× → まちがえた問題として翌日から復習（toMistake）
// 戻り値: { state, stage, due, lapse, introduced_on, toMistake } / 解けないカード（known・retired）は null
export function answer(card, code, day, mode) {
  if (card.state === 'known' || card.state === 'retired') return null;
  if (card.state === 'new' && mode === 'new') {
    if (code === 'o') return { state: 'known', stage: 0, due: '', lapse: false, introduced_on: '', toMistake: false };
    return { state: 'learning', stage: 0, due: addDays(day, 1), lapse: true, introduced_on: day, toMistake: true };
  }
  // まだ出していなかったカードを毎日の復習（「つづき」など）で解いたら、ここで出し始めたことにする
  const fresh = card.state === 'new';
  const n = schedule(fresh ? 'learning' : card.state, fresh ? 0 : card.stage, code, day);
  return { ...n, lapse: !!n.lapse, introduced_on: fresh ? day : card.introduced_on, toMistake: false };
}

// 残っている解答の記録を古い順にたどり直して、カードの状態を作り直す（記録を消したとき用）。
// reviews: [{review_id, result: '○'|'△'|'×', study_day, answered_at, mode}]（古い順）
// 戻り値: { card, stages: {review_id: [before, after]}, toMistake: チャレンジで間違えた記録が残っているか }
export function replay(reviews) {
  const card = { state: 'new', stage: 0, due: '', reps: 0, lapses: 0, last_result: '', last_reviewed_at: '', introduced_on: '' };
  const stages = {};
  let toMistake = false;
  for (const r of reviews) {
    const before = card.stage;
    const n = answer(card, RESULT_CODE[r.result], r.study_day, r.mode || 'daily');
    if (!n) continue;
    Object.assign(card, { state: n.state, stage: n.stage, due: n.due, reps: card.reps + 1, lapses: card.lapses + (n.lapse ? 1 : 0),
      last_result: r.result, last_reviewed_at: r.answered_at, introduced_on: n.introduced_on });
    if (n.toMistake) toMistake = true;
    stages[r.review_id] = [before, n.stage];
  }
  return { card, stages, toMistake };
}

export function cost(direction, hasPhoto, st) {
  if (direction === 'write') return st.sec_write;
  if (direction === 'read') return st.sec_read;
  return hasPhoto ? st.sec_photo : st.sec_single;
}

// 連続日数とお休みチケット。
// 解かなかった日の並び（gap）が、その月の残りチケットで埋まるときだけチケットを使う（切れているときは無駄遣いしない）。
// 戻り値の newFreezes は、新しくチケットを使った日（呼び出し側で保存する）
export function streak(dayRows, today, st) {
  const map = {};
  const usedByMonth = {};
  let first = '';
  for (const r of dayRows) {
    map[r.study_day] = r;
    if (!first || r.study_day < first) first = r.study_day;
    if (r.freeze_used) usedByMonth[r.study_day.slice(0, 7)] = (usedByMonth[r.study_day.slice(0, 7)] || 0) + 1;
  }
  const kept = (d) => map[d] && (map[d].completed || map[d].freeze_used);
  const newFreezes = [];
  let count = map[today] && map[today].completed ? 1 : 0;
  let d = addDays(today, -1);
  while (first && d >= first) {
    if (map[d] && map[d].completed) { count++; d = addDays(d, -1); continue; }
    if (kept(d)) { d = addDays(d, -1); continue; }
    const gap = [];
    let g = d;
    while (g >= first && !kept(g)) { gap.push(g); g = addDays(g, -1); }
    if (g < first) break;
    const need = {};
    for (const x of gap) need[x.slice(0, 7)] = (need[x.slice(0, 7)] || 0) + 1;
    if (!Object.keys(need).every((m) => (usedByMonth[m] || 0) + need[m] <= st.freezes_per_month)) break;
    for (const x of gap) {
      usedByMonth[x.slice(0, 7)] = (usedByMonth[x.slice(0, 7)] || 0) + 1;
      map[x] = { study_day: x, freeze_used: 1 };
      newFreezes.push(x);
    }
    d = g;
  }
  return {
    streak: count,
    freezesLeft: Math.max(0, st.freezes_per_month - (usedByMonth[today.slice(0, 7)] || 0)),
    newFreezes
  };
}

const HIRAGANA = /^[ぁ-ゟー]+$/;
const KANA = /^[ぁ-ゟァ-ヿー]+$/;
export const ITEM_FIELDS = ['type', 'subject', 'unit', 'sentence', 'answer', 'reading', 'prompt_form', 'explanation',
  'photo_q', 'photo_a', 'source', 'qno', 'source_date', 'reason', 'origin', 'pool'];

// 登録・修正の入力を整えて検証する。戻り値 { item, kanji } または { error }
export function normalizeItem(x) {
  x = x || {};
  const it = {};
  for (const k of ITEM_FIELDS) {
    const v = x[k];
    it[k] = String(v === undefined || v === null ? '' : v).trim().slice(0, MAX_TEXT);
  }
  if (!it.origin) it.origin = 'その他';
  if (!it.pool) it.pool = 'mistake';
  if (!['mistake', 'new'].includes(it.pool)) return { error: '登録先が不正です' };
  if (!['A', 'B', 'C'].includes(it.type)) return { error: '型が不正です' };
  if ((it.photo_q && !/^[\w-]+$/.test(it.photo_q)) || (it.photo_a && !/^[\w-]+$/.test(it.photo_a))) return { error: '写真IDが不正です' };
  if (it.source_date && !/^\d{4}-\d{2}-\d{2}$/.test(it.source_date)) return { error: '日付は YYYY-MM-DD で入力してください' };
  const kanji = it.type === 'A' && !!it.reading;
  if (kanji) {
    if (!it.sentence || !it.answer) return { error: '例文と答えが必要です' };
    if (!it.sentence.includes(it.answer)) return { error: '例文に「' + it.answer + '」がありません' };
    if (!HIRAGANA.test(it.reading)) return { error: '読みはひらがなで入力してください' };
    if (it.prompt_form && !KANA.test(it.prompt_form)) return { error: '出題表記はかなで入力してください' };
  } else if (!it.sentence && !it.photo_q) {
    return { error: '問題文か問題の写真が必要です' };
  } else if (it.type === 'A' && !it.answer) {
    return { error: '答えが必要です' };
  }
  return { item: it, kanji };
}

export function dupKey(it) { return [it.type, it.sentence, it.answer, it.photo_q].join('|'); }
