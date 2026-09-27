// GAS の SpreadsheetApp / Drive / Utilities などを最小限まねるモック。Code.gs を vm 上で動かす
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeSheet(name) {
  let grid = [];
  let maxRows = 1000;
  const sheet = {
    name,
    grid: () => grid,
    getMaxRows: () => maxRows,
    insertRowsAfter: (after, n) => { maxRows += n; },
    getLastRow: () => {
      for (let i = grid.length - 1; i >= 0; i--) if (grid[i] && grid[i].some((v) => v !== '')) return i + 1;
      return 0;
    },
    setFrozenRows: () => {},
    getDataRange: () => ({
      // 実物と同じく、' 始まりの値は ' を外して表示する
      getDisplayValues: () => grid.map((r) => (r || []).map((v) => (typeof v === 'string' && v[0] === "'" ? v.slice(1) : String(v))))
    }),
    getRange: (r, c, nr = 1, nc = 1) => {
      if (r + nr - 1 > maxRows) throw new Error('Range out of bounds: ' + name);
      return {
        setNumberFormat: () => {},
        setValues: (vals) => {
          if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error('size mismatch');
          vals.forEach((row, i) => {
            grid[r - 1 + i] = grid[r - 1 + i] || [];
            row.forEach((v, j) => {
              if (typeof v !== 'string') throw new Error('non-string cell value: ' + v);
              grid[r - 1 + i][c - 1 + j] = v;
            });
          });
        }
      };
    }
  };
  return sheet;
}

function load(opts = {}) {
  const sheets = {};
  const files = {};
  const props = {};
  const cache = {};
  let n = 0;
  let uuid = 0;
  const jst = (ms) => new Date(ms + 9 * 3600000).toISOString();
  const ss = {
    getSheetByName: (x) => sheets[x] || null,
    insertSheet: (x) => (sheets[x] = makeSheet(x)),
    deleteSheet: (s) => { delete sheets[s.name]; }
  };
  const ctx = {
    console,
    Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; },
      deleteProperty: (k) => { delete props[k]; }
    }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    Drive: { Files: {
      create(res, blob) { const id = 'id' + (++n); files[id] = { ...res, bytes: blob && blob.bytes }; return { id }; },
      get(id) { const f = files[id]; if (!f) throw new Error('404'); return { name: f.name, parents: f.parents, mimeType: f.mimeType }; }
    } },
    UrlFetchApp: { fetch(url) { const id = /files\/([^?]+)/.exec(url)[1]; return { getContent: () => files[id].bytes }; } },
    ScriptApp: { getOAuthToken: () => 'tok' },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ t, setMimeType() { return this; } }) },
    Utilities: {
      base64Decode: (s) => Buffer.from(s, 'base64'),
      base64Encode: (b) => Buffer.from(b).toString('base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      getUuid: () => String(++uuid).padStart(12, '0') + '-0000-4000-8000-000000000000',
      formatDate: (d, tz, fmt) => {
        const s = jst(d.getTime());
        if (fmt === 'yyyy-MM-dd') return s.slice(0, 10);
        if (fmt === 'yyyyMMdd_HHmmss') return s.slice(0, 10).replace(/-/g, '') + '_' + s.slice(11, 19).replace(/:/g, '');
        throw new Error('fmt ' + fmt);
      }
    }
  };
  let src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  src = src.replace("const SETUP_STUDY_PIN = '';", "const SETUP_STUDY_PIN = '111111';")
    .replace("const SETUP_ADMIN_PIN = '';", "const SETUP_ADMIN_PIN = '222222';");
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  if (opts.setup !== false) ctx.setup();
  // 時刻を固定して動かす
  let now = Date.parse('2026-10-01T10:00:00+09:00');
  ctx.nowMs_ = () => now;
  const api = (fn, pin, ...args) => {
    const out = JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ fn, pin, args }) } }).t);
    if (!out.ok) throw new Error(out.error);
    return out.result;
  };
  return {
    ctx, sheets, files, props, cache, api,
    setNow: (iso) => { now = Date.parse(iso); },
    getNow: () => now
  };
}

module.exports = { load };
