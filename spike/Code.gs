// 漢字SRS Phase 0 技術検証（スパイク）
// 検証したいこと:
//   1. タブレットからログインなしでWebアプリを開けるか
//   2. スプレッドシートへの読み書きの往復時間
//   3. 300件の一括読み込み時間
//   4. 写真の縮小→Drive保存→読み戻しの時間（drive.file スコープで動くか）

// setup() を実行する前に6桁以上の数字を入れる。実行後は空に戻してよい（値はスクリプトプロパティに保存される）
const SETUP_PIN = '';

const PHOTO_FOLDER_NAME = 'KanjiSRS_photos';
const LOG_SHEET = 'spike_log';
const BULK_SHEET = 'spike_bulk';

function setup() {
  if (!/^\d{6,}$/.test(SETUP_PIN)) {
    throw new Error('SETUP_PIN に6桁以上の数字を入れてから実行してください');
  }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('PIN', SETUP_PIN);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [LOG_SHEET, BULK_SHEET].forEach(function (name) {
    if (!ss.getSheetByName(name)) ss.insertSheet(name);
  });
  ss.getSheetByName(LOG_SHEET).getRange(1, 1, 1, 3).setValues([['at', 'kind', 'detail']]);

  let folderId = props.getProperty('PHOTO_FOLDER_ID');
  if (!folderId) {
    folderId = Drive.Files.create(
      { name: PHOTO_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
      null,
      { fields: 'id' }
    ).id;
    props.setProperty('PHOTO_FOLDER_ID', folderId);
  }
  // 作ったフォルダを drive.file スコープで読み直せるかも確認する
  const folderName = Drive.Files.get(folderId, { fields: 'name' }).name;
  Logger.log('OK: sheets=%s,%s folder=%s (%s)', LOG_SHEET, BULK_SHEET, folderName, folderId);
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('漢字SRS 技術検証')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 外部（GitHub Pages）に置いた画面からの JSON API。
// 13歳未満の Google 子どもアカウントでは script.google.com の画面自体が開けないため、
// 画面は別ホストに置き、ここはデータの出し入れだけを受け持つ。
// 要求: POST text/plain {"fn": "apiPing", "pin": "...", "args": [...]}
const API_ = {
  apiPing: apiPing,
  apiWriteRead: apiWriteRead,
  apiSeedBulk: apiSeedBulk,
  apiLoadBulk: apiLoadBulk,
  apiUploadPhoto: apiUploadPhoto,
  apiGetPhoto: apiGetPhoto
};

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    if (!Object.prototype.hasOwnProperty.call(API_, req.fn)) throw new Error('UNKNOWN_FN');
    out = { ok: true, result: API_[req.fn].apply(null, [req.pin].concat(req.args || [])) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// 「全員（匿名）」公開なので、全APIでPINを確認する。
// 失敗10回で10分ロック（スクリプト全体で共有。検証用の簡易実装）
function checkPin_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinFails') || 0);
  if (fails >= 10) throw new Error('LOCKED: PINの失敗が続いたため10分間ロック中');
  const expected = PropertiesService.getScriptProperties().getProperty('PIN');
  if (!expected) throw new Error('NOT_SETUP: setup() が未実行');
  if (String(pin) !== expected) {
    cache.put('pinFails', String(fails + 1), 600);
    throw new Error('BAD_PIN');
  }
}

// DriveApp は drive.file スコープでは動かない（ドライブ全体の権限を要求する）ため、
// Drive API（Advanced Service v3）と UrlFetchApp で必要最小限の権限のまま操作する
function photoFolderId_() {
  const id = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  if (!id) throw new Error('NOT_SETUP: setup() が未実行');
  return id;
}

// ※ google.script.run は Date を返せない（結果が null になる）ので、戻り値は文字列と数値だけにする

function apiPing(pin) {
  checkPin_(pin);
  return { serverTime: Date.now() };
}

function apiWriteRead(pin, detail) {
  checkPin_(pin);
  const t0 = Date.now();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  sh.appendRow([new Date(), 'write', String(detail).slice(0, 500)]);
  const last = sh.getLastRow();
  const readBack = sh.getRange(last, 3).getDisplayValue();
  return { row: last, readBack: readBack, serverMs: Date.now() - t0 };
}

function apiSeedBulk(pin, n) {
  checkPin_(pin);
  n = Math.min(Math.max(Number(n) || 300, 1), 3000);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BULK_SHEET);
  sh.clearContents();
  const rows = [['id', 'prompt', 'answer', 'stage', 'due']];
  for (let i = 1; i <= n; i++) {
    rows.push(['c' + i, '例文' + i + 'のコウギを受ける', '講義', i % 6, '2026-10-01']);
  }
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  return { rows: n };
}

function apiLoadBulk(pin) {
  checkPin_(pin);
  const t0 = Date.now();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BULK_SHEET);
  // getValues() だと日付セルが Date になり返せないため、表示値で読む
  const values = sh.getDataRange().getDisplayValues();
  return { rows: values.slice(1), serverMs: Date.now() - t0 };
}

function apiUploadPhoto(pin, dataUrl) {
  checkPin_(pin);
  const t0 = Date.now();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl));
  if (!m) throw new Error('BAD_IMAGE');
  const bytes = Utilities.base64Decode(m[2]);
  const name = 'spike_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.jpg';
  const file = Drive.Files.create(
    { name: name, parents: [photoFolderId_()], mimeType: m[1] },
    Utilities.newBlob(bytes, m[1], name),
    { fields: 'id' }
  );
  return { id: file.id, bytes: bytes.length, serverMs: Date.now() - t0 };
}

function apiGetPhoto(pin, id) {
  checkPin_(pin);
  const t0 = Date.now();
  id = String(id);
  if (!/^[\w-]+$/.test(id)) throw new Error('NOT_FOUND');
  // 写真フォルダ外のファイルは返さない
  const meta = Drive.Files.get(id, { fields: 'parents,mimeType' });
  if (!meta.parents || meta.parents.indexOf(photoFolderId_()) < 0) throw new Error('NOT_FOUND');
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
  });
  return {
    dataUrl: 'data:' + meta.mimeType + ';base64,' + Utilities.base64Encode(res.getContent()),
    serverMs: Date.now() - t0
  };
}
