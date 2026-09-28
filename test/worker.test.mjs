// Worker（worker/src）のテスト。D1 は node:sqlite で動くシムに置き換える
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { schedule, studyDay, addDays } from '../worker/src/logic.js';
import { createD1 } from './d1-shim.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'migrations');
const S = '111111';
const A = '222222';
const ORIGIN = 'https://goskey-mode.github.io';

function setup() {
  const env = {
    DB: createD1(path.join(root, 'data')),
    PHOTOS: createD1(path.join(root, 'photos')),
    STUDY_PIN: S, ADMIN_PIN: A, ALLOWED_ORIGINS: ORIGIN,
    NOW_MS: String(Date.parse('2026-10-01T10:00:00+09:00'))
  };
  const raw = async (fn, pin, ...args) => {
    const res = await worker.fetch(new Request('https://api.test/api', {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' }, body: JSON.stringify({ fn, pin, args })
    }), env);
    return { res, body: await res.json() };
  };
  const api = async (fn, pin, ...args) => {
    const { body } = await raw(fn, pin, ...args);
    if (!body.ok) throw new Error(body.error);
    return body.result;
  };
  const setNow = (iso) => { env.NOW_MS = String(Date.parse(iso)); };
  const q = (sql, ...a) => env.DB.raw.prepare(sql).all(...a).map((r) => ({ ...r }));
  return { env, api, raw, setNow, q };
}

function kanji(sentence, answer, reading, extra = {}) {
  return { type: 'A', subject: '国語', sentence, answer, reading, origin: '塾', source: '漢字テスト', ...extra };
}
let seq = 0;
function rv(card_id, result, at) {
  return { review_id: 'r-' + String(++seq).padStart(8, '0'), card_id, result, answered_at: at, duration_sec: 12 };
}

test('logic: 固定間隔・卒業・抜き打ち・午前3時の区切り', () => {
  const d = '2026-10-01';
  assert.deepEqual(schedule('learning', 0, 'o', d), { state: 'learning', stage: 1, due: '2026-10-02' });
  assert.equal(schedule('learning', 5, 'o', d).due, '2026-11-30');
  assert.deepEqual(schedule('learning', 6, 'o', d), { state: 'spot', stage: 6, due: '2027-03-30' });
  assert.deepEqual(schedule('learning', 3, 't', d), { state: 'learning', stage: 3, due: '2026-10-08' });
  assert.deepEqual(schedule('learning', 4, 'x', d), { state: 'learning', stage: 0, due: '2026-10-02', lapse: true });
  assert.equal(schedule('spot', 6, 'o', d).state, 'retired');
  assert.equal(schedule('spot', 6, 't', d).due, '2026-10-31');
  assert.equal(studyDay(Date.parse('2026-10-02T02:59:00+09:00'), 3), '2026-10-01');
  assert.equal(studyDay(Date.parse('2026-10-02T03:00:00+09:00'), 3), '2026-10-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('PIN・CORS・ロック', async () => {
  const t = setup();
  const { res } = await t.raw('whoami', S);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal((await t.api('whoami', A)).role, 'admin');
  await assert.rejects(t.api('addItems', S, []), /FORBIDDEN/);
  await assert.rejects(t.api('whoami', '000000'), /BAD_PIN/);
  for (let i = 0; i < 9; i++) await t.api('whoami', 'x').catch(() => {});
  await assert.rejects(t.api('whoami', A), /LOCKED/);
  t.setNow('2026-10-01T10:11:00+09:00'); // 10分後に解除
  assert.equal((await t.api('whoami', A)).role, 'admin');
  const bad = await worker.fetch(new Request('https://api.test/api', { method: 'POST', body: 'x' }), t.env);
  assert.equal((await bad.json()).error, 'BAD_REQUEST');
});

test('addItems: 検証・重複・カード作成・数式風の文字列もそのまま', async () => {
  const t = setup();
  const r = await t.api('addItems', A, [
    kanji('大学の講義を受ける', '講義', 'こうぎ'),
    kanji('スープが温かい', '温かい', 'あたたかい', { prompt_form: 'アタタかい', make_read: true }),
    kanji('試合にマける', '負ける', 'まける'),
    kanji('大学の講義を受ける', '講義', 'こうぎ'),
    kanji('音楽を聞く', '音楽', 'オンガク'),
    { type: 'B', subject: '算数', photo_q: 'p1', origin: '模試' },
    { type: 'A', subject: '社会', sentence: '日本で一番長い川は？', answer: '信濃川' },
    { type: 'A', subject: '社会', sentence: '答えなし' },
    { type: 'Z', sentence: 'x' },
    { type: 'A', sentence: '=HYPERLINK("x")', answer: '+1' }
  ]);
  assert.equal(r.added, 5);
  assert.equal(r.cards, 6);
  assert.deepEqual(r.skipped.map((s) => s.index), [2, 3, 4, 7, 8]);
  assert.equal((await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')])).skipped[0].reason, '登録済みです');
  const list = await t.api('listItems', A);
  assert.equal(list.find((i) => i.answer === '+1').sentence, '=HYPERLINK("x")');
  assert.deepEqual(list.find((i) => i.answer === '温かい').stats.directions, ['write', 'read']);
  assert.equal(list.find((i) => i.answer === '講義').stats.state, 'new');
});

test('getToday: 新しいカードは1日4枚まで・塾/模試を先に・開き直しても増えない', async () => {
  const t = setup();
  const list = [];
  for (let i = 0; i < 6; i++) list.push(kanji('例' + i + 'の漢字', '漢字', 'かんじ'));
  list.push({ type: 'A', subject: '社会', sentence: '手入力の問題', answer: 'こたえ', origin: 'その他' });
  await t.api('addItems', A, list);
  const t1 = await t.api('getToday', S);
  assert.equal(t1.today, '2026-10-01');
  assert.equal(t1.cards.length, 4);
  assert.ok(t1.cards.every((c) => c.direction === 'write'));
  assert.equal(t1.estSeconds, 80);
  const t2 = await t.api('getToday', S);
  assert.deepEqual(t2.cards.map((c) => c.card_id), t1.cards.map((c) => c.card_id));
  await t.api('submitReviews', S, [rv(t1.cards[0].card_id, 'o', '2026-10-01T10:01:00+09:00'), rv(t1.cards[1].card_id, 'x', '2026-10-01T10:02:00+09:00')]);
  assert.equal((await t.api('getToday', S)).cards.length, 2);
});

test('getToday: 10分の予算・段階の低い順', async () => {
  const t = setup();
  const list = [];
  for (let i = 0; i < 40; i++) list.push(kanji('例' + i + 'の漢字', '漢字', 'かんじ'));
  await t.api('addItems', A, list);
  const ids = t.q('SELECT card_id FROM cards ORDER BY card_id').map((r) => r.card_id);
  ids.forEach((cid, i) => t.env.DB.raw.prepare("UPDATE cards SET state = 'learning', stage = ?, due = ? WHERE card_id = ?").run(i % 6, '2026-09-2' + (i % 9), cid));
  const today = await t.api('getToday', S);
  assert.equal(today.cards.length, 30);
  const stages = today.cards.map((c) => c.stage);
  assert.deepEqual(stages, stages.slice().sort((a, b) => a - b));
  assert.equal(today.estSeconds, 600);
});

test('submitReviews: 再送は無視・午前3時前は前日扱い・不正な値は飛ばす', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  const card = (await t.api('getToday', S)).cards[0];
  const r = rv(card.card_id, 'o', '2026-10-01T10:05:00+09:00');
  assert.deepEqual(await t.api('submitReviews', S, [r]), { applied: 1, duplicates: 0, skipped: 0 });
  assert.deepEqual(await t.api('submitReviews', S, [r]), { applied: 0, duplicates: 1, skipped: 0 });
  assert.deepEqual(t.q('SELECT stage, due FROM cards')[0], { stage: 1, due: '2026-10-02' });
  t.setNow('2026-10-03T02:30:00+09:00');
  await t.api('submitReviews', S, [rv(card.card_id, 'o', '2026-10-03T02:20:00+09:00')]);
  assert.equal(t.q('SELECT due FROM cards')[0].due, '2026-10-05');
  const revs = t.q('SELECT study_day, result FROM reviews ORDER BY answered_at');
  assert.deepEqual(revs[1], { study_day: '2026-10-02', result: '○' });
  assert.equal((await t.api('submitReviews', S, [{ review_id: 'bad-id-0001', card_id: card.card_id, result: 'z' }])).skipped, 1);
  assert.equal((await t.api('submitReviews', S, [rv('nope', 'o', '2026-10-03T02:21:00+09:00')])).skipped, 1);
  // 同じバッチ内で同じカードを2回（あり得ないが壊れないこと）
  const two = await t.api('submitReviews', S, [rv(card.card_id, 'x', '2026-10-03T02:22:00+09:00'), rv(card.card_id, 'o', '2026-10-03T02:23:00+09:00')]);
  assert.equal(two.applied, 2);
  assert.deepEqual({ ...t.q('SELECT stage, lapses, reps FROM cards')[0] }, { stage: 1, lapses: 1, reps: 4 });
});

test('7回連続○で卒業、抜き打ち○で完全卒業', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  let day = '2026-10-01';
  const cardId = (await t.api('getToday', S)).cards[0].card_id;
  for (let i = 0; i < 7; i++) {
    t.setNow(day + 'T10:00:00+09:00');
    assert.equal((await t.api('getToday', S)).cards.length, 1, 'day ' + day);
    await t.api('submitReviews', S, [rv(cardId, 'o', day + 'T10:01:00+09:00')]);
    day = t.q('SELECT due FROM cards')[0].due;
  }
  assert.equal(t.q('SELECT state FROM cards')[0].state, 'spot');
  assert.equal((await t.api('listItems', A))[0].stats.state, 'graduated');
  t.setNow(day + 'T10:00:00+09:00');
  await t.api('submitReviews', S, [rv(cardId, 'o', day + 'T10:01:00+09:00')]);
  assert.equal(t.q('SELECT state FROM cards')[0].state, 'retired');
});

test('連続日数とお休みチケット', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  const finish = async (day) => { t.setNow(day + 'T20:00:00+09:00'); return t.api('finishDay', S, { day, cards_done: 5, seconds: 300 }); };
  await finish('2026-10-01');
  await finish('2026-10-02');
  assert.equal((await finish('2026-10-03')).streak, 3);
  t.setNow('2026-10-06T19:00:00+09:00');
  const today = await t.api('getToday', S);
  assert.equal(today.streak, 3);
  assert.equal(today.freezesLeft, 0);
  assert.equal((await finish('2026-10-06')).streak, 4);
  t.setNow('2026-10-08T19:00:00+09:00');
  assert.equal((await t.api('getToday', S)).streak, 0);
});

test('連続日数: 休みがチケットより長いときはチケットを使わない', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  t.setNow('2026-10-01T20:00:00+09:00');
  await t.api('finishDay', S, { day: '2026-10-01' });
  t.setNow('2026-10-06T20:00:00+09:00');
  const today = await t.api('getToday', S);
  assert.equal(today.streak, 0);
  assert.equal(today.freezesLeft, 2);
  assert.equal(t.q('SELECT COUNT(*) AS n FROM days WHERE freeze_used = 1')[0].n, 0);
});

test('finishDay: 午前3時をまたいだら前日・2日以上前は今日', async () => {
  const t = setup();
  t.setNow('2026-10-02T03:10:00+09:00');
  await t.api('finishDay', S, { day: '2026-10-01', cards_done: 3, seconds: 100 });
  await t.api('finishDay', S, { day: '2026-09-01' });
  assert.deepEqual(t.q('SELECT study_day, completed, cards_done FROM days ORDER BY study_day'),
    [{ study_day: '2026-10-01', completed: 1, cards_done: 3 }, { study_day: '2026-10-02', completed: 1, cards_done: 0 }]);
});

test('出す問題が無い日は自動で終えた日になる', async () => {
  const t = setup();
  const today = await t.api('getToday', S);
  assert.equal(today.done, true);
  assert.equal(today.streak, 1);
});

test('停止・削除・修正', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ'), kanji('試合に負ける', '負ける', 'まける')]);
  const items = await t.api('listItems', A);
  await t.api('setStatus', A, items[0].item_id, 'suspended');
  await t.api('setStatus', A, items[1].item_id, 'deleted');
  assert.equal((await t.api('getToday', S)).cards.length, 0);
  assert.equal((await t.api('listItems', A)).length, 1);
  await t.api('setStatus', A, items[0].item_id, 'active');
  await assert.rejects(t.api('updateItem', A, items[0].item_id, { answer: '存在しない' }), /例文に/);
  await t.api('updateItem', A, items[0].item_id, { reason: 'うっかり' });
  assert.equal((await t.api('listItems', A))[0].reason, 'うっかり');
  await assert.rejects(t.api('setStatus', A, 'nope', 'deleted'), /NOT_FOUND/);
  await assert.rejects(t.api('setStatus', S, items[0].item_id, 'deleted'), /FORBIDDEN/);
});

test('写真: 保存・署名付きURLで取得・改ざんと期限切れは拒否', async () => {
  const t = setup();
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const up = await t.api('uploadPhoto', A, 'data:image/jpeg;base64,' + bytes.toString('base64'));
  assert.match(up.url, /^https:\/\/api\.test\/photo\/p[0-9a-f]+\?e=\d+&s=/);
  const res = await worker.fetch(new Request(up.url), t.env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.equal((await worker.fetch(new Request(up.url.replace(/s=./, 's=X')), t.env)).status, 403);
  t.setNow('2026-10-05T10:00:00+09:00');
  assert.equal((await worker.fetch(new Request(up.url), t.env)).status, 403);
  await assert.rejects(t.api('uploadPhoto', A, 'data:text/html;base64,AAAA'), /BAD_IMAGE/);
  await assert.rejects(t.api('uploadPhoto', S, 'data:image/jpeg;base64,AAAA'), /FORBIDDEN/);
  // 出題にも写真URLが付く
  await t.api('addItems', A, [{ type: 'B', subject: '算数', photo_q: up.id, answer: '12km', origin: '模試' }]);
  const card = (await t.api('getToday', S)).cards[0];
  assert.match(card.photo_q_url, /\/photo\/p/);
  assert.equal(card.photo_a_url, '');
});

test('getOverview と exportTable', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ'), kanji('試合に負ける', '負ける', 'まける')]);
  const [c1, c2] = t.q('SELECT card_id FROM cards ORDER BY card_id').map((r) => r.card_id);
  t.env.DB.raw.prepare("UPDATE cards SET state = 'learning', due = '2026-09-20', lapses = 3 WHERE card_id = ?").run(c1);
  t.env.DB.raw.prepare("UPDATE cards SET state = 'learning', due = '2026-10-03' WHERE card_id = ?").run(c2);
  const o = await t.api('getOverview', A);
  assert.equal(o.forecast[0].count, 1);
  assert.equal(o.forecast[2].count, 1);
  assert.equal(o.struggling.length, 1);
  assert.equal(o.items, 2);
  assert.equal(o.photos.count, 0);
  assert.ok(o.photos.bytes > 0);
  const ex = await t.api('exportTable', A, 'items', 0);
  assert.equal(ex.rows.length, 2);
  assert.equal(ex.next, null);
  await assert.rejects(t.api('exportTable', A, 'secrets', 0), /BAD_ARGS/);
});

test('新しいカードは登録した順・同じ問題は書き→読みの順に出る', async () => {
  const t = setup();
  await t.api('addItems', A, [
    kanji('一の漢字', '漢字', 'かんじ'), kanji('二の音楽', '音楽', 'おんがく', { make_read: true }), kanji('三の講義', '講義', 'こうぎ')
  ]);
  const cards = (await t.api('getToday', S)).cards;
  assert.deepEqual(cards.map((c) => c.answer + ':' + c.direction), ['漢字:write', '音楽:write', '音楽:read', '講義:write']);
});

test('0問で自動的に終えた日でも、あとから登録した問題はその日のうちに出る', async () => {
  const t = setup();
  const morning = await t.api('getToday', S);
  assert.equal(morning.done, true);
  assert.equal(morning.streak, 1);
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  const evening = await t.api('getToday', S);
  assert.equal(evening.done, false);
  assert.equal(evening.cards.length, 1);
  assert.equal(evening.streak, 1); // 連続日数はそのまま
  // 最後まで解いて終えたら、その日はもう出さない
  await t.api('submitReviews', S, [rv(evening.cards[0].card_id, 'o', '2026-10-01T20:00:00+09:00')]);
  await t.api('finishDay', S, { day: '2026-10-01', cards_done: 1, seconds: 20 });
  await t.api('addItems', A, [kanji('試合に負ける', '負ける', 'まける')]);
  assert.equal((await t.api('getToday', S)).done, true);
});

test('削除した問題を解いた時間は今日の予算に数えない', async () => {
  const t = setup();
  const list = [];
  for (let i = 0; i < 30; i++) list.push(kanji('例' + i + 'の漢字', '漢字', 'かんじ'));
  await t.api('addItems', A, [kanji('確認用の講義', '講義', 'こうぎ')]);
  const test1 = (await t.api('getToday', S)).cards[0];
  await t.api('submitReviews', S, [rv(test1.card_id, 'o', '2026-10-01T10:01:00+09:00')]);
  await t.api('setStatus', A, (await t.api('listItems', A))[0].item_id, 'deleted');
  await t.api('addItems', A, list);
  const ids = t.q("SELECT c.card_id FROM cards c JOIN items i ON i.item_id = c.item_id WHERE i.status = 'active'").map((r) => r.card_id);
  ids.forEach((cid) => t.env.DB.raw.prepare("UPDATE cards SET state = 'learning', stage = 1, due = '2026-09-30' WHERE card_id = ?").run(cid));
  assert.equal((await t.api('getToday', S)).cards.length, 30); // 600秒 ÷ 20秒。削除した1問の20秒は引かれない
});

test('削除した問題のカードは「今日の新しいカード4枚」に数えない', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('確認用の一', '一', 'いち'), kanji('確認用の二', '二', 'に'), kanji('確認用の三', '三', 'さん')]);
  assert.equal((await t.api('getToday', S)).cards.length, 3);
  for (const i of await t.api('listItems', A)) await t.api('setStatus', A, i.item_id, 'deleted');
  await t.api('addItems', A, [kanji('例一の漢字', '漢字', 'かんじ'), kanji('例二の音楽', '音楽', 'おんがく'), kanji('例三の講義', '講義', 'こうぎ'), kanji('例四の貿易', '貿易', 'ぼうえき')]);
  assert.equal((await t.api('getToday', S)).cards.length, 4);
});

test('終えたあとも同じ日に「つづき」と「もう一回」ができる', async () => {
  const t = setup();
  // 新しいカードの上限を超える6枚を登録し、今日は4枚だけ出す
  const list = [];
  for (let i = 0; i < 6; i++) list.push(kanji('例' + i + 'の漢字', '漢字', 'かんじ'));
  await t.api('addItems', A, list);
  const first = await t.api('getToday', S);
  assert.equal(first.cards.length, 4);
  assert.equal(first.extra.length, 0); // 終える前は出さない
  await t.api('submitReviews', S, first.cards.map((c, i) => rv(c.card_id, i === 0 ? 'x' : 'o', '2026-10-01T10:0' + i + ':00+09:00')));
  await t.api('finishDay', S, { day: '2026-10-01', cards_done: 4, seconds: 80 });
  const after = await t.api('getToday', S);
  assert.equal(after.done, true);
  assert.equal(after.cards.length, 0);
  assert.equal(after.extra.length, 0);       // 新しいカードの枠（4枚）は使い切った
  assert.equal(after.practice.length, 4);    // 今日解いた4枚は記録なしで練習できる
  // 親があとから上限を増やしたら、終えたあとでも「つづき」に出る
  t.env.DB.raw.prepare("UPDATE settings SET value = '6' WHERE key = 'new_per_day'").run();
  const more = await t.api('getToday', S);
  assert.equal(more.extra.length, 2);
  assert.equal(more.extraEstSeconds, 40);
  // 「つづき」の新しいカードはそのまま解ける（ここで出し始めたことになる）
  const r = await t.api('submitReviews', S, more.extra.map((c, i) => rv(c.card_id, 'o', '2026-10-01T11:0' + i + ':00+09:00')));
  assert.equal(r.applied, 2);
  assert.equal(t.q("SELECT COUNT(*) AS n FROM cards WHERE introduced_on = '2026-10-01'")[0].n, 6);
  await t.api('finishDay', S, { day: '2026-10-01', cards_done: 2, seconds: 40 });
  assert.deepEqual(t.q("SELECT cards_done, seconds FROM days WHERE study_day = '2026-10-01'")[0], { cards_done: 6, seconds: 120 });
  const last = await t.api('getToday', S);
  assert.equal(last.extra.length, 0);
  assert.equal(last.practice.length, 6);
  assert.equal(last.streak, 1);
});

test('記録の削除: 1件ずつ・問題ごと・日ごと。残りの記録からカードを作り直す', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ'), kanji('試合に負ける', '負ける', 'まける')]);
  const [c1, c2] = (await t.api('getToday', S)).cards.map((c) => c.card_id);
  // c1: 10/1 ○ → 10/2 × → 10/3 ○
  await t.api('submitReviews', S, [rv(c1, 'o', '2026-10-01T10:00:00+09:00'), rv(c2, 'o', '2026-10-01T10:01:00+09:00')]);
  await t.api('finishDay', S, { day: '2026-10-01', cards_done: 2 });
  t.setNow('2026-10-02T10:00:00+09:00');
  await t.api('submitReviews', S, [rv(c1, 'x', '2026-10-02T10:00:00+09:00')]);
  t.setNow('2026-10-03T10:00:00+09:00');
  await t.api('submitReviews', S, [rv(c1, 'o', '2026-10-03T10:00:00+09:00')]);
  assert.deepEqual({ ...t.q('SELECT stage, due, lapses, reps FROM cards WHERE card_id = ?', c1)[0] }, { stage: 1, due: '2026-10-04', lapses: 1, reps: 3 });

  // 真ん中の×を消すと、○○として作り直される（段階2・3日後）
  const items = await t.api('listItems', A);
  const it1 = items.find((i) => i.answer === '講義');
  const hist = await t.api('itemHistory', A, it1.item_id);
  const xId = hist.find((h) => h.result === '×').review_id;
  await assert.rejects(t.api('deleteReviews', S, [xId]), /FORBIDDEN/);
  assert.equal((await t.api('deleteReviews', A, [xId])).deleted, 1);
  assert.deepEqual({ ...t.q('SELECT stage, due, lapses, reps, introduced_on FROM cards WHERE card_id = ?', c1)[0] },
    { stage: 2, due: '2026-10-06', lapses: 0, reps: 2, introduced_on: '2026-10-01' });
  assert.deepEqual(t.q('SELECT stage_before, stage_after FROM reviews WHERE card_id = ? ORDER BY answered_at', c1).map((r) => [r.stage_before, r.stage_after]), [[0, 1], [1, 2]]);

  // 日ごと: 10/1 を取り消すと、その日の「終えた」記録も消え、c2 は未出題に戻る
  const res = await t.api('resetDay', A, '2026-10-01');
  assert.equal(res.deleted, 2);
  assert.equal(t.q("SELECT COUNT(*) AS n FROM days WHERE study_day = '2026-10-01'")[0].n, 0);
  assert.deepEqual({ ...t.q('SELECT state, stage, due, reps, introduced_on FROM cards WHERE card_id = ?', c2)[0] }, { state: 'new', stage: 0, due: '', reps: 0, introduced_on: '' });
  // c1 は 10/3 の○だけが残る（10/3 に出し始めて段階1）
  assert.deepEqual({ ...t.q('SELECT state, stage, due, introduced_on FROM cards WHERE card_id = ?', c1)[0] }, { state: 'learning', stage: 1, due: '2026-10-04', introduced_on: '2026-10-03' });

  // 問題ごと: すべて消して未出題に戻す
  await t.api('resetItem', A, it1.item_id);
  assert.equal(t.q('SELECT state FROM cards WHERE card_id = ?', c1)[0].state, 'new');
  assert.equal(t.q('SELECT COUNT(*) AS n FROM reviews')[0].n, 0);
  assert.equal((await t.api('listItems', A)).every((i) => i.stats.state === 'new' && i.stats.reps === 0), true);
  await assert.rejects(t.api('resetDay', A, 'yesterday'), /BAD_ARGS/);
  await assert.rejects(t.api('resetItem', A, 'nope'), /NOT_FOUND/);
});

test('今日の記録を消すと、今日の問題としてもう一度出る', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  const c = (await t.api('getToday', S)).cards[0];
  await t.api('submitReviews', S, [rv(c.card_id, 'o', '2026-10-01T10:00:00+09:00')]);
  await t.api('finishDay', S, { day: '2026-10-01', cards_done: 1 });
  assert.equal((await t.api('getToday', S)).done, true);
  await t.api('resetDay', A, '2026-10-01');
  const again = await t.api('getToday', S);
  assert.equal(again.done, false);
  assert.deepEqual(again.cards.map((x) => x.card_id), [c.card_id]);
  assert.equal(again.streak, 0);
});
