// 動いている API に対する通し確認と速さの測定
//   node test/smoke.mjs <APIのURL> <学習PIN> <親PIN> [--readonly]
//   --readonly: データを書き込まず、読み取りの速さだけ測る（本番用）
const [base, S, A] = process.argv.slice(2);
const readonly = process.argv.includes('--readonly');
if (!base || !S || !A) { console.error('usage: node test/smoke.mjs <api url> <study pin> <admin pin> [--readonly]'); process.exit(2); }

const times = {};
async function call(fn, pin, ...args) {
  const t0 = performance.now();
  const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8', Origin: 'https://goskey-mode.github.io' }, body: JSON.stringify({ fn, pin, args }) });
  const j = await res.json();
  (times[fn] = times[fn] || []).push(Math.round(performance.now() - t0));
  if (!j.ok) throw new Error(fn + ': ' + j.error);
  return j.result;
}
function check(cond, msg) { if (!cond) throw new Error('NG: ' + msg); console.log('ok  ' + msg); }

check((await call('whoami', S)).role === 'study', '学習PINで whoami');
check((await call('whoami', A)).role === 'admin', '親PINで whoami');
await call('addItems', S, []).then(() => check(false, '学習PINで登録できてしまう'), (e) => check(/FORBIDDEN/.test(e.message), '学習PINでは登録できない'));

if (!readonly) {
  const tag = 'smoke' + Date.now().toString(36);
  const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');
  const up = await call('uploadPhoto', A, 'data:image/jpeg;base64,' + jpeg.toString('base64'));
  const img = await fetch(up.url);
  check(img.status === 200 && Buffer.compare(Buffer.from(await img.arrayBuffer()), jpeg) === 0, '写真を保存して署名付きURLで同じバイト列が返る');
  check((await fetch(up.url.replace(/s=./, 's=X'))).status === 403, '改ざんした写真URLは拒否');
  const add = await call('addItems', A, [
    { type: 'A', subject: '国語', sentence: tag + 'の講義を受ける', answer: '講義', reading: 'こうぎ', origin: '塾', make_read: true },
    { type: 'B', subject: '算数', photo_q: up.id, answer: '12km', origin: '模試', source: tag }
  ]);
  check(add.added === 2 && add.cards === 3, '問題2件・カード3枚を登録');
  const today = await call('getToday', S);
  const mine = today.cards.filter((c) => c.sentence.startsWith(tag) || c.source === tag);
  check(mine.length >= 1, '今日の問題に登録した問題が出る（' + mine.length + '枚）');
  const reviews = mine.map((c, i) => ({ review_id: tag + '-r' + i, card_id: c.card_id, result: i === 0 ? 'x' : 'o', answered_at: new Date().toISOString(), duration_sec: 5 }));
  const r1 = await call('submitReviews', S, reviews);
  check(r1.applied === reviews.length, '解答を反映（' + r1.applied + '件）');
  const r2 = await call('submitReviews', S, reviews);
  check(r2.applied === 0 && r2.duplicates === reviews.length, '同じ解答の再送は無視');
  const list = await call('listItems', A);
  const it = list.find((i) => i.sentence.startsWith(tag));
  check(it && it.stats.reps >= 1 && it.stats.directions.join() === 'write,read', '一覧に解答回数と書き・読みが出る');
  check((await call('itemHistory', A, it.item_id)).length >= 1, '解答の履歴');
  await call('updateItem', A, it.item_id, { reason: 'うっかり' });
  check((await call('listItems', A)).find((i) => i.item_id === it.item_id).reason === 'うっかり', '修正');
  for (const i of (await call('listItems', A)).filter((x) => x.sentence.startsWith(tag) || x.source === tag)) await call('setStatus', A, i.item_id, 'deleted');
  check(!(await call('listItems', A)).some((x) => x.sentence.startsWith(tag)), '確認用の問題を削除（後片付け）');
}

const o = await call('getOverview', A);
check(Array.isArray(o.forecast) && o.forecast.length === 7, '状況（連続' + o.streak + '日・写真' + o.photos.count + '枚 ' + (o.photos.bytes / 1e6).toFixed(1) + 'MB）');
await call('getToday', S);
await call('listItems', A);
check(Array.isArray((await call('exportTable', A, 'items', 0)).rows), 'CSV書き出し用のデータ');

console.log('\n応答時間（ミリ秒）');
for (const [fn, t] of Object.entries(times)) console.log('  ' + fn.padEnd(14) + t.join(', '));
