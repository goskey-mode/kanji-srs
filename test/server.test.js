// 実行: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./gas-mock');

const S = '111111'; // 学習PIN
const A = '222222'; // 親PIN

function kanji(sentence, answer, reading, extra = {}) {
  return { type: 'A', subject: '国語', sentence, answer, reading, origin: '塾', source: '漢字テスト', ...extra };
}

let seq = 0;
function rv(card_id, result, at) {
  return { review_id: 'r-' + String(++seq).padStart(8, '0'), card_id, result, answered_at: at, duration_sec: 12 };
}

test('schedule_: 固定間隔・卒業・抜き打ち・復活', () => {
  const { ctx } = load();
  const d = '2026-10-01';
  assert.deepEqual({ ...ctx.schedule_('learning', 0, 'o', d) }, { state: 'learning', stage: 1, due: '2026-10-02' });
  assert.equal(ctx.schedule_('learning', 1, 'o', d).due, '2026-10-04');
  assert.equal(ctx.schedule_('learning', 5, 'o', d).due, '2026-11-30'); // +60
  assert.equal(ctx.schedule_('learning', 5, 'o', d).stage, 6);
  const grad = ctx.schedule_('learning', 6, 'o', d);
  assert.equal(grad.state, 'spot');
  assert.equal(grad.due, '2027-03-30'); // +180
  // △は直前の間隔をもう一度・段階はそのまま
  assert.deepEqual({ ...ctx.schedule_('learning', 3, 't', d) }, { state: 'learning', stage: 3, due: '2026-10-08' });
  assert.equal(ctx.schedule_('learning', 0, 't', d).due, '2026-10-02');
  // ×は0へ・翌日・lapse
  assert.deepEqual({ ...ctx.schedule_('learning', 4, 'x', d) }, { state: 'learning', stage: 0, due: '2026-10-02', lapse: true });
  // 抜き打ち
  assert.equal(ctx.schedule_('spot', 6, 'o', d).state, 'retired');
  assert.equal(ctx.schedule_('spot', 6, 'x', d).stage, 0);
  assert.equal(ctx.schedule_('spot', 6, 't', d).due, '2026-10-31');
});

test('studyDay_: 午前3時で日付が切り替わる', () => {
  const { ctx } = load();
  assert.equal(ctx.studyDay_(Date.parse('2026-10-02T02:59:00+09:00'), 3), '2026-10-01');
  assert.equal(ctx.studyDay_(Date.parse('2026-10-02T03:00:00+09:00'), 3), '2026-10-02');
  assert.equal(ctx.addDays_('2026-12-31', 1), '2027-01-01');
  assert.equal(ctx.addDays_('2026-03-01', -1), '2026-02-28');
});

test('PIN: 学習PINは親用APIを使えない・間違い10回でロック', () => {
  const m = load();
  assert.equal(m.api('whoami', S).role, 'study');
  assert.equal(m.api('whoami', A).role, 'admin');
  assert.throws(() => m.api('addItems', S, []), /FORBIDDEN/);
  assert.throws(() => m.api('whoami', '000000'), /BAD_PIN/);
  for (let i = 0; i < 9; i++) { try { m.api('whoami', 'x'); } catch (e) { /* 想定どおり */ } }
  assert.throws(() => m.api('whoami', A), /LOCKED/);
  assert.throws(() => m.api('nope', A), /UNKNOWN_FN|LOCKED/);
});

test('setup: 同じPINは拒否・検証用シートとPINを消す・2回目はPINなしで通る', () => {
  const m = load({ setup: false });
  m.ctx.SpreadsheetApp.getActiveSpreadsheet().insertSheet('spike_log');
  m.props.PIN = '999999';
  m.ctx.setup();
  assert.equal(m.sheets.spike_log, undefined);
  assert.equal(m.props.PIN, undefined);
  const settingsRows = m.sheets.settings.grid().length;
  m.ctx.setup(); // 2回目: 設定値を重複して足さない
  assert.equal(m.sheets.settings.grid().length, settingsRows);
  assert.equal(m.props.PHOTO_FOLDER_ID, 'id1');
});

test('addItems: 検証・重複・カード作成（書き既定、読みは任意）', () => {
  const m = load();
  const r = m.api('addItems', A, [
    kanji('大学の講義を受ける', '講義', 'こうぎ'),
    kanji('スープが温かい', '温かい', 'あたたかい', { prompt_form: 'アタタかい', make_read: true }),
    kanji('試合にマける', '負ける', 'まける'),                  // 例文に答えがない
    kanji('大学の講義を受ける', '講義', 'こうぎ'),               // 同じバッチ内の重複
    kanji('音楽を聞く', '音楽', 'オンガク'),                     // 読みがカタカナ
    { type: 'B', subject: '算数', photo_q: 'id9', source: '模試', origin: '模試' },
    { type: 'A', subject: '社会', sentence: '日本で一番長い川は？', answer: '信濃川' },
    { type: 'A', subject: '社会', sentence: '答えなし' },
    { type: 'Z', sentence: 'x' },
    { type: 'A', sentence: '=HYPERLINK("x")', answer: '+1' }
  ]);
  assert.equal(r.added, 5);
  assert.equal(r.cards, 6); // 講義(書き) 温かい(書き+読み) 写真 手入力 数式風
  assert.deepEqual(r.skipped.map((s) => s.index), [2, 3, 4, 7, 8]);
  assert.match(r.skipped[0].reason, /例文に「負ける」がありません/);
  assert.match(r.skipped[1].reason, /登録済み/);
  // 2回目の登録でも重複を弾く
  assert.equal(m.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]).skipped[0].reason, '登録済みです');
  // 数式として解釈されず、そのまま読み戻せる
  const listed = m.api('listItems', A);
  const f = listed.find((i) => i.answer === '+1');
  assert.equal(f.sentence, '=HYPERLINK("x")');
  assert.deepEqual(listed.find((i) => i.answer === '温かい').stats.directions, ['write', 'read']);
});

test('getToday: 新しいカードは1日4枚まで・塾/模試を先に・同日に開き直しても増えない', () => {
  const m = load();
  const list = [];
  for (let i = 0; i < 6; i++) list.push(kanji('例文' + i + 'の漢字', '漢字', 'かんじ', { sentence: '例' + i + 'の漢字' }));
  list.push({ type: 'A', subject: '社会', sentence: '手入力の問題', answer: 'こたえ', origin: 'その他' });
  m.api('addItems', A, list);
  const t1 = m.api('getToday', S);
  assert.equal(t1.today, '2026-10-01');
  assert.equal(t1.cards.length, 4);
  assert.ok(t1.cards.every((c) => c.direction === 'write'));
  assert.equal(t1.estSeconds, 80);
  const t2 = m.api('getToday', S);
  assert.deepEqual(t2.cards.map((c) => c.card_id), t1.cards.map((c) => c.card_id));
  // 2枚解いてから開き直すと残り2枚
  m.api('submitReviews', S, [rv(t1.cards[0].card_id, 'o', '2026-10-01T10:01:00+09:00'), rv(t1.cards[1].card_id, 'x', '2026-10-01T10:02:00+09:00')]);
  assert.equal(m.api('getToday', S).cards.length, 2);
});

test('getToday: 10分の予算・段階の低い順・予算を超えた分は持ち越し', () => {
  const m = load();
  const list = [];
  for (let i = 0; i < 40; i++) list.push(kanji('例' + i + 'の漢字', '漢字', 'かんじ'));
  m.api('addItems', A, list);
  // 40枚を学習中にして、段階をばらして今日を出題日にする
  const cards = m.ctx.table_('cards');
  cards.rows.forEach((c, i) => { c.state = 'learning'; c.stage = i % 6; c.due = '2026-09-2' + (i % 9); cards.update(c); });
  const t = m.api('getToday', S);
  assert.equal(t.cards.length, 30); // 600秒 ÷ 書き20秒
  const stages = t.cards.map((c) => c.stage);
  assert.deepEqual(stages, stages.slice().sort((a, b) => a - b));
  assert.equal(t.estSeconds, 600);
});

test('submitReviews: 同じIDの再送は無視・午前3時前の解答は前日扱い', () => {
  const m = load();
  m.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  const card = m.api('getToday', S).cards[0];
  const r = rv(card.card_id, 'o', '2026-10-01T10:05:00+09:00');
  assert.deepEqual({ ...m.api('submitReviews', S, [r]) }, { applied: 1, duplicates: 0, skipped: 0 });
  assert.deepEqual({ ...m.api('submitReviews', S, [r]) }, { applied: 0, duplicates: 1, skipped: 0 });
  let c = m.ctx.table_('cards').rows[0];
  assert.equal(c.stage, 1);
  assert.equal(c.due, '2026-10-02');
  // 翌日の深夜2時に解く → 学習日は 10/2 のまま
  m.setNow('2026-10-03T02:30:00+09:00');
  m.api('submitReviews', S, [rv(card.card_id, 'o', '2026-10-03T02:20:00+09:00')]);
  c = m.ctx.table_('cards').rows[0];
  assert.equal(c.due, '2026-10-05'); // 10/2 + 3
  const revs = m.ctx.table_('reviews').rows;
  assert.equal(revs[1].study_day, '2026-10-02');
  assert.equal(revs[1].result, '○');
  // 不正な結果・未知のカードは飛ばす
  assert.equal(m.api('submitReviews', S, [{ review_id: 'bad-id-0001', card_id: card.card_id, result: 'z' }]).skipped, 1);
  assert.equal(m.api('submitReviews', S, [rv('nope', 'o', '2026-10-03T02:21:00+09:00')]).skipped, 1);
});

test('7回連続○で卒業し、抜き打ち○で完全卒業', () => {
  const m = load();
  m.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  let day = '2026-10-01';
  m.setNow(day + 'T10:00:00+09:00');
  const cardId = m.api('getToday', S).cards[0].card_id;
  for (let i = 0; i < 7; i++) {
    m.setNow(day + 'T10:00:00+09:00');
    const t = m.api('getToday', S);
    assert.equal(t.cards.length, 1, 'day ' + day);
    m.api('submitReviews', S, [rv(cardId, 'o', day + 'T10:01:00+09:00')]);
    day = m.ctx.table_('cards').rows[0].due;
  }
  const c = m.ctx.table_('cards').rows[0];
  assert.equal(c.state, 'spot');
  assert.equal(m.api('listItems', A)[0].stats.state, 'graduated');
  m.setNow(c.due + 'T10:00:00+09:00');
  m.api('submitReviews', S, [rv(cardId, 'o', c.due + 'T10:01:00+09:00')]);
  assert.equal(m.ctx.table_('cards').rows[0].state, 'retired');
});

test('連続日数: 終えた日を数え、休んだ日はチケット（月2枚）で埋める', () => {
  const m = load();
  m.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  const finish = (day) => { m.setNow(day + 'T20:00:00+09:00'); return m.api('finishDay', S, { day, cards_done: 5, seconds: 300 }); };
  finish('2026-10-01');
  finish('2026-10-02');
  assert.equal(finish('2026-10-03').streak, 3);
  // 10/4, 10/5 を休む → 10/6 に開くとチケット2枚で連続がつながる
  m.setNow('2026-10-06T19:00:00+09:00');
  const t = m.api('getToday', S);
  assert.equal(t.streak, 3);
  assert.equal(t.freezesLeft, 0);
  assert.equal(finish('2026-10-06').streak, 4);
  // 同じ月にもう1日休むとチケットが無いので切れる
  m.setNow('2026-10-08T19:00:00+09:00');
  assert.equal(m.api('getToday', S).streak, 0);
});

test('連続日数: 休みがチケットより長いときはチケットを使わない', () => {
  const m = load();
  m.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ')]);
  m.setNow('2026-10-01T20:00:00+09:00');
  m.api('finishDay', S, { day: '2026-10-01' });
  m.setNow('2026-10-06T20:00:00+09:00'); // 4日休み
  const t = m.api('getToday', S);
  assert.equal(t.streak, 0);
  assert.equal(t.freezesLeft, 2);
});

test('finishDay: 午前3時をまたいで終えたら前日を完了にする', () => {
  const m = load();
  m.setNow('2026-10-02T03:10:00+09:00');
  m.api('finishDay', S, { day: '2026-10-01', cards_done: 3, seconds: 100 });
  const d = m.ctx.table_('days').rows;
  assert.equal(d[0].study_day, '2026-10-01');
  assert.equal(d[0].completed, 1);
  // 2日以上前の日付は受け付けず今日にする
  m.api('finishDay', S, { day: '2026-09-01' });
  assert.equal(m.ctx.table_('days').rows[1].study_day, '2026-10-02');
});

test('出す問題が無い日は自動で終えた日になる', () => {
  const m = load();
  const t = m.api('getToday', S);
  assert.equal(t.done, true);
  assert.equal(t.cards.length, 0);
  assert.equal(t.streak, 1);
});

test('停止・削除した問題は出題しない / 修正は検証を通す', () => {
  const m = load();
  m.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ'), kanji('試合に負ける', '負ける', 'まける')]);
  const items = m.api('listItems', A);
  m.api('setStatus', A, items[0].item_id, 'suspended');
  m.api('setStatus', A, items[1].item_id, 'deleted');
  assert.equal(m.api('getToday', S).cards.length, 0);
  assert.equal(m.api('listItems', A).length, 1);
  m.api('setStatus', A, items[0].item_id, 'active');
  assert.throws(() => m.api('updateItem', A, items[0].item_id, { answer: '存在しない' }), /例文に/);
  m.api('updateItem', A, items[0].item_id, { reason: 'うっかり' });
  assert.equal(m.api('listItems', A)[0].reason, 'うっかり');
  assert.throws(() => m.api('setStatus', S, items[0].item_id, 'deleted'), /FORBIDDEN/);
});

test('写真: 保存と読み出し、フォルダ外は返さない', () => {
  const m = load();
  const d = 'data:image/jpeg;base64,' + Buffer.from('abc').toString('base64');
  const up = m.api('uploadPhoto', A, d);
  assert.equal(m.api('getPhoto', S, up.id).dataUrl, d);
  m.files.other = { parents: ['elsewhere'], mimeType: 'text/plain', bytes: Buffer.from('secret') };
  assert.throws(() => m.api('getPhoto', S, 'other'), /NOT_FOUND/);
  assert.throws(() => m.api('uploadPhoto', S, d), /FORBIDDEN/);
});

test('getOverview: 7日間の予定・苦手な問題', () => {
  const m = load();
  m.api('addItems', A, [kanji('大学の講義を受ける', '講義', 'こうぎ'), kanji('試合に負ける', '負ける', 'まける')]);
  const cards = m.ctx.table_('cards');
  cards.rows[0].state = 'learning'; cards.rows[0].due = '2026-09-20'; cards.rows[0].lapses = 3; cards.update(cards.rows[0]);
  cards.rows[1].state = 'learning'; cards.rows[1].due = '2026-10-03'; cards.update(cards.rows[1]);
  const o = m.api('getOverview', A);
  assert.equal(o.forecast[0].count, 1); // 期限切れは今日に数える
  assert.equal(o.forecast[2].count, 1);
  assert.equal(o.struggling.length, 1);
  assert.equal(o.struggling[0].answer, '講義');
  assert.equal(o.items, 2);
});
