// ローカル確認用: worker/src を node:sqlite 上の D1 シムで動かし、app/ を配る
//   node test/dev-server.mjs [--seed] [--new=10]
//   画面: http://127.0.0.1:8765/study.html#api=http%3A%2F%2F127.0.0.1%3A8787%2Fapi
//   PIN: 学習 111111 / 親 222222
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/src/index.js';
import { createD1 } from './d1-shim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'app');
const MIG = path.join(here, '..', 'worker', 'migrations');
const env = {
  DB: createD1(path.join(MIG, 'data')),
  PHOTOS: createD1(path.join(MIG, 'photos')),
  STUDY_PIN: '111111', ADMIN_PIN: '222222',
  ALLOWED_ORIGINS: 'http://127.0.0.1:8765'
};

async function call(fn, ...args) {
  const res = await worker.fetch(new Request('http://127.0.0.1:8787/api', { method: 'POST', body: JSON.stringify({ fn, pin: '222222', args }) }), env);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}

const newArg = process.argv.find((a) => a.startsWith('--new='));
if (newArg) env.DB.raw.prepare("UPDATE settings SET value = ? WHERE key = 'new_per_day'").run(newArg.slice(6));

if (process.argv.includes('--seed')) {
  await call('addItems', [
    { type: 'A', subject: '国語', unit: '漢字', sentence: '大学の講義を受ける', answer: '講義', reading: 'こうぎ', origin: '塾', source: '漢字テスト 第5回' },
    { type: 'A', subject: '国語', unit: '漢字', sentence: 'スープが温かい', answer: '温かい', reading: 'あたたかい', prompt_form: 'アタタかい', origin: '塾', make_read: true },
    { type: 'A', subject: '国語', unit: '漢字', sentence: '地域の伝統的な行事に参加して、昔からの習わしを受け継ぐ', answer: '伝統', reading: 'でんとう', origin: '模試' },
    { type: 'A', subject: '社会', sentence: '日本で一番長い川は？', answer: '信濃川', explanation: '長さ367km。2位は利根川', origin: 'その他' },
    { type: 'C', subject: '適性', sentence: '資料2のグラフから読み取れることを書く問題', answer: '条件「2つ以上」を読み落とした', explanation: '問題文の条件に線を引いてから書く', origin: '模試', reason: '読み違い' }
  ]);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const q = (await call('uploadPhoto', png)).id;
  await call('addItems', [{ type: 'B', subject: '算数', unit: '速さ', photo_q: q, answer: '12km', source: '模試 第3回', qno: '大問2(3)', reason: '読み違い', origin: '模試', explanation: '分→時の直し忘れ' }]);
  await call('addItems', [
    { type: 'A', subject: '国語', unit: '漢字1年生', sentence: '話し合いで円満に解決する', answer: '円満', reading: 'えんまん', explanation: '争いがなく、おだやかなこと', pool: 'new', origin: 'その他' },
    { type: 'A', subject: '国語', unit: '漢字1年生', sentence: '五感を使って観察する', answer: '五感', reading: 'ごかん', explanation: '見る・聞く・かぐ・味わう・さわるの五つの感覚', pool: 'new', origin: 'その他' },
    { type: 'A', subject: '国語', unit: '漢字1年生', sentence: '人の考え方は千差万別だ', answer: '千差万別', reading: 'せんさばんべつ', explanation: 'いろいろなちがいがあること', pool: 'new', origin: 'その他' },
    { type: 'A', subject: '国語', unit: '作文表現', sentence: '雨（　　）、多くの人がマラソン大会に集まった。', answer: 'にもかかわらず', explanation: '意味: 〜なのに／使う場面: 予想とちがう結果になったことを書くとき', pool: 'new', origin: 'その他' }
  ]);
  console.log('seeded');
}

// API（Cloudflare Workers の代わり）
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request('http://127.0.0.1:8787' + req.url, {
    method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body
  }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, '127.0.0.1');

// 画面（GitHub Pages の代わり）
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(APP, p === '/' ? 'index.html' : p);
  if (!file.startsWith(APP) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(8765, '127.0.0.1');

console.log('app: http://127.0.0.1:8765/  api: http://127.0.0.1:8787/api');
