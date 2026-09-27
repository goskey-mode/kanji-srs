// app/api.js の純粋関数のテスト（ブラウザ依存部分はスタブ）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadKS(hash) {
  const store = {};
  const win = {
    location: { hash: hash || '', pathname: '/study.html', search: '' },
    history: { replaceState: (a, b, url) => { win.replaced = url; } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app', 'api.js'), 'utf8'), win);
  return { KS: win.KS, win, store };
}

test('fromTestForm: テストのままのカタカナ例文を漢字に直し、表記を残す', () => {
  const { KS } = loadKS();
  assert.deepEqual({ ...KS.fromTestForm('水をアビる', '浴びる', 'あびる') }, { sentence: '水を浴びる', prompt_form: 'アビる' });
  assert.deepEqual({ ...KS.fromTestForm('大学のコウギを受ける', '講義', 'こうぎ') }, { sentence: '大学の講義を受ける', prompt_form: 'コウギ' });
  assert.deepEqual({ ...KS.fromTestForm('試合にマケる', '負ける', 'まける') }, { sentence: '試合に負ける', prompt_form: 'マケる' });
  // すでに漢字の例文はそのまま
  assert.equal(KS.fromTestForm('大学の講義を受ける', '講義', 'こうぎ'), null);
  // ひらがなだけの一致は置き換えない（カタカナを含む部分だけ）
  assert.equal(KS.fromTestForm('こうぎをうける', '講義', 'こうぎ'), null);
  // ひらがなの一致を飛ばして、後ろのカタカナ部分を置き換える
  assert.deepEqual({ ...KS.fromTestForm('あめがふるのでアメを買う', '飴', 'あめ') }, { sentence: 'あめがふるので飴を買う', prompt_form: 'アメ' });
  assert.equal(KS.fromTestForm('関係ない文', '講義', 'こうぎ'), null);
});

test('promptParts: 書きはカタカナ（または出題表記）、読みは漢字を強調', () => {
  const { KS } = loadKS();
  const base = { sentence: '大学の講義を受ける', answer: '講義', reading: 'こうぎ' };
  assert.deepEqual({ ...KS.promptParts({ ...base, direction: 'write' }) }, { before: '大学の', mark: 'コウギ', after: 'を受ける' });
  assert.equal(KS.promptParts({ ...base, direction: 'read' }).mark, '講義');
  assert.equal(KS.promptParts({ sentence: 'スープが温かい', answer: '温かい', reading: 'あたたかい', prompt_form: 'アタタかい', direction: 'write' }).mark, 'アタタかい');
});

test('接続先: #api= で保存し、アドレス欄から消す。形式が違えば保存しない', () => {
  const url = 'https://kanji-srs.example-sub.workers.dev/api';
  const a = loadKS('#api=' + encodeURIComponent(url));
  assert.equal(a.KS.getApi(), url);
  assert.equal(a.win.replaced, '/study.html');
  const b = loadKS('#api=' + encodeURIComponent('https://evil.example/api'));
  assert.equal(b.KS.getApi(), '');
  assert.equal(b.KS.setApi('https://kanji-srs.x.workers.dev.evil.example/api'), false);
  assert.equal(b.KS.setApi('http://kanji-srs.x.workers.dev/api'), false); // http は不可（ローカル確認の 127.0.0.1 だけ許す）
  assert.equal(b.KS.setApi('http://127.0.0.1:8787/api'), true);
});
