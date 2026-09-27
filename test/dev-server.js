// ローカル確認用: 本物の gas/Code.gs をモック上で動かし、app/ を配る
//   node test/dev-server.js [--seed]
//   画面: http://127.0.0.1:8765/study.html#api=http%3A%2F%2F127.0.0.1%3A8766%2Fmacros%2Fs%2FDEV%2Fexec
//   PIN: 学習 111111 / 親 222222
// GAS と同じく、POST は 302 で別URLへ飛ばし、そこで CORS 付きの JSON を返す
const http = require('http');
const fs = require('fs');
const path = require('path');
const { load } = require('./gas-mock');

const APP = path.join(__dirname, '..', 'app');
const m = load();
m.ctx.nowMs_ = () => Date.now();

if (process.argv.includes('--seed')) {
  const A = '222222';
  m.api('addItems', A, [
    { type: 'A', subject: '国語', unit: '漢字', sentence: '大学の講義を受ける', answer: '講義', reading: 'こうぎ', origin: '塾', source: '漢字テスト 第5回' },
    { type: 'A', subject: '国語', unit: '漢字', sentence: 'スープが温かい', answer: '温かい', reading: 'あたたかい', prompt_form: 'アタタかい', origin: '塾', make_read: true },
    { type: 'A', subject: '国語', unit: '漢字', sentence: '地域の伝統的な行事に参加して、昔からの習わしを受け継ぐ', answer: '伝統', reading: 'でんとう', origin: '模試' },
    { type: 'A', subject: '社会', sentence: '日本で一番長い川は？', answer: '信濃川', explanation: '長さ367km。2位は利根川', origin: 'その他' },
    { type: 'C', subject: '適性', sentence: '資料2のグラフから読み取れることを書く問題', answer: '条件「2つ以上」を読み落とした', explanation: '問題文の条件に線を引いてから書く', origin: '模試', reason: '読み違い' }
  ]);
  // 写真問題（無地の画像）
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const q = m.api('uploadPhoto', A, png).id;
  m.api('addItems', A, [{ type: 'B', subject: '算数', unit: '速さ', photo_q: q, answer: '12km', source: '模試 第3回', qno: '大問2(3)', reason: '読み違い', origin: '模試', explanation: '分→時の直し忘れ' }]);
  console.log('seeded');
}

// --new=10 で「1日の新しいカード上限」を変える（写真問題などを出して見た目を確かめる用）
const newArg = process.argv.find((a) => a.startsWith('--new='));
if (newArg) {
  const st = m.ctx.table_('settings');
  const row = st.rows.find((r) => r.key === 'new_per_day');
  row.value = newArg.slice(6);
  st.update(row);
}

const pending = {};
let k = 0;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/macros/s/DEV/exec') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const out = m.ctx.doPost({ postData: { contents: body } });
      const key = 'k' + (++k);
      pending[key] = out.t;
      res.writeHead(302, { 'Access-Control-Allow-Origin': '*', Location: 'http://127.0.0.1:8766/echo?key=' + key });
      res.end();
    });
    return;
  }
  if (req.url.startsWith('/echo')) {
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(pending[key] || '{"ok":false,"error":"gone"}');
    delete pending[key];
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(8766, '127.0.0.1');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(APP, p === '/' ? 'index.html' : p);
  if (!file.startsWith(APP) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  let data = fs.readFileSync(file, 'utf8');
  if (file.endsWith('api.js')) data = data.replace("'https://script.google.com/macros/s/'", "'http://127.0.0.1:8766/macros/s/'");
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}).listen(8765, '127.0.0.1');

console.log('app: http://127.0.0.1:8765/  api: http://127.0.0.1:8766/macros/s/DEV/exec');
