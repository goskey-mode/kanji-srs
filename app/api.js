// 漢字SRS 共通部品（study.html / admin.html）
(function (global) {
  'use strict';

  var API_PREFIX = 'https://script.google.com/macros/s/';
  var KEY_API = 'kanjisrs_api';

  // localStorage は使えない環境（プライベートモード等）もあるので、失敗しても動くようにする
  var memory = {};
  function load(key) {
    try { var v = localStorage.getItem(key); if (v !== null) return v; } catch (e) { /* 使えない環境 */ }
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }
  function store(key, value) {
    memory[key] = value;
    try { localStorage.setItem(key, value); } catch (e) { /* 使えない環境ではこの読み込み中だけ保持 */ }
  }
  function remove(key) {
    delete memory[key];
    try { localStorage.removeItem(key); } catch (e) { /* 使えない環境 */ }
  }
  function loadJson(key, fallback) {
    try { var v = load(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function storeJson(key, value) { store(key, JSON.stringify(value)); }

  function validApi(u) { return typeof u === 'string' && u.indexOf(API_PREFIX) === 0 && /\/exec$/.test(u); }

  // 親が送るリンク末尾の #api=... で接続先を設定する（# 以降はサーバに送られない）
  (function readHash() {
    var m = /[#&]api=([^&]+)/.exec(location.hash);
    if (!m) return;
    var u = '';
    try { u = decodeURIComponent(m[1]); } catch (e) { /* 壊れたリンク */ }
    if (validApi(u)) store(KEY_API, u);
    history.replaceState(null, '', location.pathname + location.search);
  })();

  function getApi() { return load(KEY_API) || ''; }
  function setApi(u) { if (!validApi(u)) return false; store(KEY_API, u); return true; }

  var MESSAGES = {
    BAD_PIN: 'PINがちがいます',
    LOCKED: 'PINを何度もまちがえたので、10分ほど待ってください',
    FORBIDDEN: 'このPINではできない操作です（親用PINが必要）',
    NOT_SETUP: 'サーバーの準備（setup）がまだです',
    NOT_FOUND: '見つかりませんでした'
  };
  function message(err) {
    var m = String((err && err.message) || err);
    return MESSAGES[m] || m;
  }

  // GAS の doPost を呼ぶ。端末にログイン中の Google アカウント（子どもアカウント）の Cookie は送らない
  function call(fn, pin, args, opts) {
    var api = getApi();
    if (!validApi(api)) return Promise.reject(new Error('接続先URLが未設定です'));
    return fetch(api, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'follow',
      keepalive: !!(opts && opts.keepalive),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fn, pin: pin, args: args || [] })
    }).then(function (res) {
      if (!res.ok) throw new Error('通信エラー（HTTP ' + res.status + '）');
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (e) {
        throw new Error('サーバーの応答が読めません（GASを新しいバージョンでデプロイしたか確認）');
      }
      if (!j.ok) throw new Error(j.error);
      return j.result;
    });
  }

  function uuid() {
    if (global.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  function kata(s) {
    return String(s || '').replace(/[ぁ-ゖ]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) + 0x60); });
  }

  // 例文を「前・強調部分・後」に分ける。書き: 読みのカタカナ（または出題表記）、読み: 答えの漢字
  function promptParts(card) {
    var s = card.sentence || '';
    var i = s.indexOf(card.answer || '\u0000');
    var mark = card.direction === 'write' ? (card.prompt_form || kata(card.reading)) : card.answer;
    if (i < 0) return { before: s, mark: '', after: '' };
    return { before: s.slice(0, i), mark: mark, after: s.slice(i + card.answer.length) };
  }

  function hira(s) {
    return String(s || '').replace(/[ァ-ヶ]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0x60); });
  }

  // 塾のテストのまま「水をアビる,浴びる,あびる」と貼られた例文を「水を浴びる」に直し、
  // カタカナ部分（アビる）を出題表記として残す。読みと一致し、カタカナを含む部分だけを置き換える
  function fromTestForm(sentence, answer, reading) {
    if (!sentence || !answer || !reading || sentence.indexOf(answer) >= 0) return null;
    var hs = hira(sentence);
    var from = 0, i;
    while ((i = hs.indexOf(reading, from)) >= 0) {
      var span = sentence.slice(i, i + reading.length);
      if (/[ァ-ヶ]/.test(span)) {
        return { sentence: sentence.slice(0, i) + answer + sentence.slice(i + reading.length), prompt_form: span };
      }
      from = i + 1;
    }
    return null;
  }

  function isKanji(card) { return card.type === 'A' && !!card.reading && !!card.sentence; }

  // 長辺1600pxに縮小してJPEG化（現行ブラウザは描画時にEXIFの向きを反映する。Phase 0 で確認）
  function resizeImage(file, maxSide) {
    maxSide = maxSide || 1600;
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('画像を読み込めません')); };
      img.src = url;
    });
  }

  // 小さな DOM ヘルパー: h('div', {class: 'x', onclick: f}, [子要素 or 文字列])
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }

  function toast(text, kind) {
    var box = document.getElementById('toast');
    if (!box) return;
    box.textContent = text;
    box.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { box.className = 'toast'; }, kind === 'error' ? 6000 : 2500);
  }

  global.KS = {
    load: load, store: store, remove: remove, loadJson: loadJson, storeJson: storeJson,
    validApi: validApi, getApi: getApi, setApi: setApi, call: call, message: message,
    uuid: uuid, kata: kata, hira: hira, fromTestForm: fromTestForm, promptParts: promptParts, isKanji: isKanji, resizeImage: resizeImage,
    h: h, toast: toast
  };
})(window);
