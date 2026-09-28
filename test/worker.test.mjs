// Worker（worker/src）のテスト。D1 は node:sqlite で動くシムに置き換える
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { schedule, studyDay, addDays, bestStreak } from '../worker/src/logic.js';
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
  assert.deepEqual(t2.cards.map((c) => c.card_id).sort(), t1.cards.map((c) => c.card_id).sort());
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
  // 選ぶのは段階の低い順（並び順はランダム）
  const all = ids.map((_, i) => i % 6).sort((a, b) => a - b);
  assert.deepEqual(today.cards.map((c) => c.stage).sort((a, b) => a - b), all.slice(0, 30));
  assert.equal(today.estSeconds, 600);
});

test('submitReviews: 再送は無視・午前3時前は前日扱い・不正な値は飛ばす', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  const card = (await t.api('getToday', S)).cards[0];
  const r = rv(card.card_id, 'o', '2026-10-01T10:05:00+09:00');
  assert.deepEqual(await t.api('submitReviews', S, [r]), { applied: 1, duplicates: 0, skipped: 0, toMistake: 0 });
  assert.deepEqual(await t.api('submitReviews', S, [r]), { applied: 0, duplicates: 1, skipped: 0, toMistake: 0 });
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

test('同じ語は1日1枚まで（書きと読みは別の日に出る）', async () => {
  const t = setup();
  await t.api('addItems', A, [
    kanji('一の漢字', '漢字', 'かんじ'), kanji('二の音楽', '音楽', 'おんがく', { make_read: true }), kanji('三の講義', '講義', 'こうぎ')
  ]);
  const cards = (await t.api('getToday', S)).cards;
  assert.deepEqual(cards.map((c) => c.answer + ':' + c.direction).sort(), ['漢字:write', '音楽:write', '講義:write'].sort());
  // 翌日、音楽の読みが新しいカードとして出る（書きは前日に解いていないので、今日の分として残る）
  await t.api('submitReviews', S, cards.map((c, i) => rv(c.card_id, 'o', '2026-10-01T10:0' + i + ':00+09:00')));
  t.setNow('2026-10-02T10:00:00+09:00');
  const next = (await t.api('getToday', S)).cards.map((c) => c.answer + ':' + c.direction);
  assert.ok(next.includes('音楽:read') || next.includes('音楽:write'));
  assert.equal(next.filter((x) => x.startsWith('音楽')).length, 1);
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

test('今日すでに出ている語の読みカードで、新しいカードの枠が埋まらない', async () => {
  const t = setup();
  const R = { make_read: true }; // 本番と同じく読みカードも作る
  // 朝: 2語を登録して、書き2枚を出し始める（読みはまだ new のまま、登録順では先に並ぶ）
  await t.api('addItems', A, [kanji('貿易がさかんな港町', '貿易', 'ぼうえき', R), kanji('険しい山道', '険しい', 'けわしい', R)]);
  assert.equal((await t.api('getToday', S)).cards.length, 2);
  // あとから2問を追加（枠は残り2枚）。どちらも今日のうちに出る
  t.setNow('2026-10-01T15:00:00+09:00'); // 本番と同じく、あとから登録した問題は登録時刻が後になる
  await t.api('addItems', A, [kanji('会場を設ける', '設ける', 'もうける', R), { type: 'B', subject: '算数', photo_q: 'p1', origin: '塾' }]);
  const later = await t.api('getToday', S);
  assert.equal(later.cards.length, 4);
  assert.deepEqual(later.cards.map((c) => c.answer || c.type).sort(), ['B', '設ける', '貿易', '険しい'].sort());
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
  const todays = (await t.api('getToday', S)).cards;
  const c1 = todays.find((c) => c.answer === '講義').card_id;
  const c2 = todays.find((c) => c.answer === '負ける').card_id;
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


function rvn(card_id, result, at) { return { ...rv(card_id, result, at), mode: 'new' }; }

test('新しい問題: 毎日の復習には出ず、チャレンジで○は覚えていた・△×はまちがえた問題へ', async () => {
  const t = setup();
  await t.api('addItems', A, [
    kanji('大学の講義を受ける', '講義', 'こうぎ'),                                   // まちがえた問題（既定）
    kanji('話し合いで円満に解決する', '円満', 'えんまん', { pool: 'new', unit: '漢字1年生' }),
    kanji('五感を使って観察する', '五感', 'ごかん', { pool: 'new', unit: '漢字1年生' }),
    kanji('人の考え方は千差万別だ', '千差万別', 'せんさばんべつ', { pool: 'new', unit: '漢字1年生' }),
    { type: 'A', subject: '国語', unit: '作文表現', sentence: '雨（　　）、人が集まった。', answer: 'にもかかわらず', pool: 'new' }
  ]);
  const bad = await t.api('addItems', A, [kanji('例の漢字', '漢字', 'かんじ', { pool: 'x' })]);
  assert.match(bad.skipped[0].reason, /登録先/);
  // 毎日の復習は「まちがえた問題」だけ
  assert.deepEqual((await t.api('getToday', S)).cards.map((c) => c.answer), ['講義']);
  // 新しい問題の漢字は、書き・読みの両方でチャレンジできる
  assert.deepEqual(await t.api('getChallengeDecks', S), [
    { deck: '漢字1年生', n: 6, write: 3, read: 3, single: 0 }, { deck: '作文表現', n: 1, write: 0, read: 0, single: 1 }]);
  const ch = await t.api('getChallenge', S, '漢字1年生', 10, 'write');
  assert.deepEqual(ch.map((c) => c.answer + ':' + c.direction), ['円満:write', '五感:write', '千差万別:write']);
  const r = await t.api('submitReviews', S, [rvn(ch[0].card_id, 'o', '2026-10-01T10:00:00+09:00'), rvn(ch[1].card_id, 't', '2026-10-01T10:01:00+09:00'), rvn(ch[2].card_id, 'x', '2026-10-01T10:02:00+09:00')]);
  assert.equal(r.applied, 3);
  assert.equal(r.toMistake, 2);
  const list = await t.api('listItems', A);
  const by = (a) => list.find((i) => i.answer === a);
  assert.equal(by('五感').pool, 'mistake');
  assert.equal(by('千差万別').pool, 'mistake');
  assert.equal(by('円満').pool, 'new');
  // 書きを解いたあとも、読みはチャレンジに残る（間違えて移った語も、まだ解いていない読みはチャレンジ側）
  assert.deepEqual((await t.api('getChallengeDecks', S))[0], { deck: '漢字1年生', n: 3, write: 0, read: 3, single: 0 });
  assert.equal((await t.api('getChallenge', S, '漢字1年生', 10, 'write')).length, 0);
  const reads = await t.api('getChallenge', S, '漢字1年生', 10, 'read');
  assert.deepEqual(reads.map((c) => c.answer).sort(), ['五感', '円満', '千差万別'].sort());
  await t.api('submitReviews', S, [rvn(reads.find((c) => c.answer === '円満').card_id, 'o', '2026-10-01T10:05:00+09:00')]);
  assert.equal((await t.api('listItems', A)).find((i) => i.answer === '円満').stats.state, 'known'); // 書き・読みとも○
  // チャレンジの分は今日の10分の枠・今日の新しいカード数に数えない
  const today = await t.api('getToday', S);
  assert.equal(today.cards.length, 1);
  // 毎日の分を終えたら、「もう一回」にはチャレンジで△×だった問題も入る（○で覚えていた語は入らない）
  await t.api('submitReviews', S, [rv(today.cards[0].card_id, 'x', '2026-10-01T10:10:00+09:00')]);
  await t.api('finishDay', S, { day: '2026-10-01', cards_done: 1, seconds: 20 });
  assert.deepEqual((await t.api('getToday', S)).practice.map((c) => c.answer + ':' + c.direction).sort(),
    ['五感:write', '千差万別:write', '講義:write'].sort());
  // 翌日、チャレンジで間違えた書き2枚が「まちがえた問題」として復習に出る。まだ解いていない読みは毎日の復習には出ない
  t.setNow('2026-10-02T10:00:00+09:00');
  const next = await t.api('getToday', S);
  assert.deepEqual(next.cards.map((c) => c.answer + ':' + c.direction).sort(), ['五感:write', '千差万別:write', '講義:write'].sort());
  // 記録を消すと、登録したときの登録先（新しい問題）に戻る
  await t.api('resetItem', A, by('五感').item_id);
  assert.equal((await t.api('listItems', A)).find((i) => i.answer === '五感').pool, 'new');
  // 親が登録先を変えたら、それが登録したときの登録先になる
  await t.api('updateItem', A, by('円満').item_id, { pool: 'mistake' });
  await t.api('resetItem', A, by('円満').item_id);
  assert.equal((await t.api('listItems', A)).find((i) => i.answer === '円満').pool, 'mistake');
  const o = await t.api('getOverview', A);
  assert.equal(o.challenge, 4); // 五感（書き・読み）・千差万別（読み）・作文表現
});

test('チャレンジ「まぜる」: 1回の中で同じ語は1枚だけ', async () => {
  const t = setup();
  const list = [];
  for (let i = 0; i < 5; i++) list.push(kanji('例' + i + 'の漢字', '漢字', 'かんじ', { pool: 'new', unit: '漢字' }));
  await t.api('addItems', A, list);
  const ch = await t.api('getChallenge', S, '漢字', 10, 'mix');
  assert.equal(ch.length, 5);
  assert.equal(new Set(ch.map((c) => c.item_id)).size, 5);
});

test('チャレンジでも「つづき」の新しいカード数の枠は減らない', async () => {
  const t = setup();
  const mistakes = [];
  for (let i = 0; i < 6; i++) mistakes.push(kanji('例' + i + 'の漢字', '漢字', 'かんじ'));
  await t.api('addItems', A, mistakes.concat([kanji('新しい講義', '講義', 'こうぎ', { pool: 'new' })]));
  const ch = await t.api('getChallenge', S, '国語', 10);
  await t.api('submitReviews', S, [rvn(ch[0].card_id, 'x', '2026-10-01T09:00:00+09:00')]);
  assert.equal((await t.api('getToday', S)).cards.length, 4); // チャレンジで入った1枚は数えない
});

test('一覧は登録先・単元で絞って返す／単元の一覧と重複チェック用の軽い一覧', async () => {
  const t = setup();
  await t.api('addItems', A, [
    kanji('大学の講義を受ける', '講義', 'こうぎ'),
    kanji('話し合いで円満に解決する', '円満', 'えんまん', { pool: 'new', unit: '漢字1年生' }),
    kanji('五感を使って観察する', '五感', 'ごかん', { pool: 'new', unit: '漢字1年生' }),
    { type: 'A', subject: '国語', unit: '四字熟語', sentence: '（　　）をくり返す', answer: '試行錯誤', pool: 'new' }
  ]);
  assert.deepEqual((await t.api('listItems', A, { pool: 'mistake' })).map((i) => i.answer), ['講義']);
  assert.deepEqual((await t.api('listItems', A, { pool: 'new', unit: '漢字1年生' })).map((i) => i.answer).sort(), ['五感', '円満']);
  assert.equal((await t.api('listItems', A, { pool: 'new', limit: 1 })).length, 1);
  assert.equal((await t.api('listItems', A)).length, 4); // 省略時はすべて
  const ch = await t.api('getChallenge', S, '漢字1年生', 10, 'write');
  await t.api('submitReviews', S, ch.map((c, i) => rvn(c.card_id, 'o', '2026-10-01T10:0' + i + ':00+09:00')));
  const units = await t.api('listUnits', A);
  assert.deepEqual(units.map((u) => [u.pool, u.unit, u.n, u.known]), [['mistake', '', 1, 0], ['new', '漢字1年生', 2, 2], ['new', '四字熟語', 1, 0]]);
  const keys = await t.api('listKeys', A);
  assert.equal(keys.length, 4);
  assert.deepEqual(keys.find((k) => k[2] === '講義'), ['A', '大学の講義を受ける', '講義', '']);
});

// ───── 漢字図鑑・ダッシュボード ─────

function linkKanji(t, rows) {
  for (const [ch, grade, ord, answer] of rows) {
    const it = answer ? t.q('SELECT item_id FROM items WHERE answer = ?', answer)[0] : null;
    t.env.DB.raw.prepare('INSERT INTO kanji (char, grade, ord, item_id) VALUES (?, ?, ?, ?)').run(ch, grade, ord, it ? it.item_id : '');
  }
}

test('logic: 最長の連続日数（お休みチケットの日はつなぐが数えない）', () => {
  assert.equal(bestStreak([]), 0);
  assert.equal(bestStreak([
    { study_day: '2026-10-01', completed: 1 }, { study_day: '2026-10-02', completed: 1 }, { study_day: '2026-10-03', freeze_used: 1 },
    { study_day: '2026-10-04', completed: 1 }, { study_day: '2026-10-06', completed: 1 }, { study_day: '2026-10-07', completed: 0 }
  ]), 3);
});

test('図鑑: 字ごとに まだ／知ってた／練習中／卒業 を返し、マスを押すと語と状態が見られる', async () => {
  const t = setup();
  const N = { pool: 'new', unit: '漢字1年生' };
  await t.api('addItems', A, [kanji('一日中雨がふる', '一日', 'いちにち', N), kanji('右手をあげる', '右手', 'みぎて', N),
    kanji('雨天のため中止', '雨天', 'うてん', N), kanji('音楽を聞く', '音楽', 'おんがく', N)]);
  linkKanji(t, [['一', 1, 0, '一日'], ['右', 1, 1, '右手'], ['雨', 1, 2, '雨天'], ['円', 1, 3, ''], ['音', 1, 5, '音楽'], ['引', 2, 0, '']]);
  const ch = await t.api('getChallenge', S, '漢字1年生', 10, 'mix');
  const card = (a, d) => t.q('SELECT c.card_id FROM cards c JOIN items i ON i.item_id = c.item_id WHERE i.answer = ? AND c.direction = ?', a, d)[0].card_id;
  assert.ok(ch.length);
  await t.api('submitReviews', S, [rvn(card('一日', 'write'), 'o', '2026-10-01T10:00:00+09:00'), rvn(card('一日', 'read'), 'o', '2026-10-01T10:01:00+09:00'),
    rvn(card('右手', 'write'), 'x', '2026-10-01T10:02:00+09:00')]);
  t.env.DB.raw.prepare("UPDATE cards SET state = 'spot', stage = 6 WHERE item_id = (SELECT item_id FROM items WHERE answer = '音楽')").run();
  const z = await t.api('getZukan', S);
  assert.deepEqual(z.chars, [['一', 1, 'k', 0], ['右', 1, 'l', 0], ['雨', 1, 'n', 0], ['円', 1, 'n', 0], ['音', 1, 'g', 0], ['引', 2, 'n', 0]]);
  assert.deepEqual(z.count, { n: 3, k: 1, l: 1, g: 1 });
  assert.equal(z.total, 6);
  assert.deepEqual(z.badges.map((b) => b.kind + b.n + ':' + b.got), ['grad10:false', 'grad50:false', 'grad100:false', 'grad300:false', 'streak7:false', 'streak30:false', 'streak100:false']);
  const info = await t.api('getKanjiInfo', S, '右');
  assert.equal(info.answer, '右手');
  assert.equal(info.pool, 'mistake');
  assert.deepEqual(info.cards.map((c) => c.direction + ':' + c.state), ['write:learning', 'read:new']);
  const none = await t.api('getKanjiInfo', S, '円');
  assert.equal(none.item_id, null);
  assert.deepEqual(none.cards, []);
  await assert.rejects(t.api('getKanjiInfo', S, '犬'), /NOT_FOUND/);
  await assert.rejects(t.api('getKanjiInfo', S, ''), /BAD_ARGS/);
  // 問題を削除したら「まだ」に戻る
  await t.api('setStatus', A, info.item_id, 'deleted');
  assert.equal((await t.api('getZukan', S)).chars[1][2], 'n');
});

test('定着率のスナップショット: その日最初の読み込みで1行だけ残し、日ごとの記録削除で取り直す', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ'), kanji('試合に負ける', '負ける', 'まける')]);
  await t.api('getToday', S);
  assert.deepEqual(t.q('SELECT * FROM snapshots'), [{ study_day: '2026-10-01', cards_total: 2, cards_retained: 0 }]);
  t.env.DB.raw.prepare("UPDATE cards SET state = 'spot'").run();
  await t.api('getToday', S);
  assert.deepEqual(t.q('SELECT cards_total, cards_retained FROM snapshots'), [{ cards_total: 2, cards_retained: 0 }]); // 1日1行のまま
  await t.api('resetDay', A, '2026-10-01');
  assert.equal(t.q('SELECT COUNT(*) AS n FROM snapshots')[0].n, 0);
  t.setNow('2026-10-02T10:00:00+09:00');
  t.env.DB.raw.prepare("UPDATE cards SET state = 'learning', stage = 4, last_result = '○' WHERE card_id IN (SELECT card_id FROM cards LIMIT 1)").run();
  await t.api('getToday', S);
  assert.deepEqual(t.q("SELECT cards_total, cards_retained FROM snapshots WHERE study_day = '2026-10-02'"), [{ cards_total: 2, cards_retained: 1 }]); // 1枚は定着の条件（段階4以上で直近○）、もう1枚は今日出し始めた
});

test('ダッシュボード: 理由別・科目別・改善／苦手・カレンダー・所要時間の実測', async () => {
  const t = setup();
  await t.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ', { reason: '知らなかった' }),
    kanji('試合に負ける', '負ける', 'まける', { reason: 'うっかり' }),
    { type: 'A', subject: '社会', sentence: '日本一長い川は', answer: '信濃川', reason: '知らなかった' }]);
  const card = (a) => t.q('SELECT c.card_id FROM cards c JOIN items i ON i.item_id = c.item_id WHERE i.answer = ?', a)[0].card_id;
  const ins = t.env.DB.raw.prepare("INSERT INTO reviews (review_id, card_id, answered_at, study_day, result, duration_sec, stage_before, stage_after) VALUES (?, ?, ?, ?, ?, ?, 0, 0)");
  let n = 0;
  const hist = (a, marks, sec) => marks.split('').forEach((m, k) => ins.run('d' + (++n), card(a), '2026-09-2' + k + 'T10:00:00Z', '2026-09-2' + k, m, sec));
  hist('講義', '××○○○', 20);       // 改善
  hist('負ける', '×○××', 30);       // 苦手
  hist('信濃川', '○', 10);
  t.env.DB.raw.prepare("INSERT INTO days (study_day, completed, cards_done, seconds) VALUES ('2026-09-30', 1, 5, 240)").run();
  t.env.DB.raw.prepare("INSERT INTO snapshots VALUES ('2026-09-30', 4, 1)").run();
  const d = await t.api('getDashboard', A);
  assert.deepEqual(d.byReason.map((r) => [r.k, r.items, r.reps, r.x, r.o]), [['知らなかった', 2, 6, 2, 4], ['うっかり', 1, 4, 3, 1]]);
  assert.deepEqual(d.bySubject.map((r) => [r.k, r.items]), [['国語', 2], ['社会', 1]]);
  assert.deepEqual(d.improved.map((r) => r.answer + r.x), ['講義2']);
  assert.deepEqual(d.weak.map((r) => r.answer + r.x), ['負ける3']);
  assert.deepEqual(d.calendar, [{ study_day: '2026-09-30', completed: 1, cards_done: 5, seconds: 240, freeze_used: 0 }]);
  assert.deepEqual(d.trend, [{ study_day: '2026-09-30', cards_total: 4, cards_retained: 1 }]);
  assert.deepEqual(d.timing.find((x) => x.kind === 'write'), { kind: 'write', n: 9, median: 20, setting: 20 });
  assert.deepEqual(d.timing.find((x) => x.kind === 'single'), { kind: 'single', n: 1, median: 10, setting: 15 });
  await assert.rejects(t.api('getDashboard', S), /./); // 親だけ
});
