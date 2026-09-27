# 漢字SRS Phase 0 技術検証

漢字の間隔反復学習アプリの基盤検証。データは Google Apps Script（GAS）＋スプレッドシート＋Drive、画面は静的ホスティング（GitHub Pages）に置く。

## 構成

- `Code.gs` / `appsscript.json` — GAS 側。PIN 確認・スプレッドシート読み書き・写真保存。`doGet`（GAS 上で画面表示）と `doPost`（JSON API）の両方を持つ
- `index.html` — 検証画面。GAS 上で開くと `google.script.run`、それ以外で開くと `fetch` で `doPost` を呼ぶ

### なぜ画面を GAS の外に置くか

13歳未満の Google 子どもアカウント（Family Link）でログインしている端末では、`script.google.com` の Web アプリが「Can't access this service」で開けない。画面を別ホストに置き、`fetch` は `credentials: 'omit'`（端末の Google アカウントの Cookie を送らない）で GAS を呼ぶ。GAS は「自分（デプロイした人）として実行」されるので、データはすべて保護者のアカウントに保存される。

### 権限を絞る理由

`DriveApp` は `drive.file`（このアプリが作ったファイルだけ）では動かず、ドライブ全体の権限を要求する。匿名公開の Web アプリにドライブ全体の権限を持たせないため、Drive API（Advanced Service v3）＋ UrlFetchApp で `drive.file` のまま操作する。

## 検証項目

| # | 項目 | 目標 |
|---|---|---|
| T1 | 通信の往復（5回平均） | 1500ms以下 |
| T2 | スプレッドシートへの書き込み→読み戻し | 2500ms以下 |
| T3 | 300件の一括読み込み | 3000ms以下 |
| T4 | 写真の縮小→Drive保存→読み戻し | 保存5000ms・読み戻し3000ms以下、向きが正しい |

## GAS のセットアップ

1. Google スプレッドシートを新規作成 →「拡張機能」→「Apps Script」
2. プロジェクトの設定 →「appsscript.json マニフェスト ファイルをエディタで表示する」
3. `appsscript.json`・`Code.gs`・HTML ファイル `index` にそれぞれ貼り付け
4. `SETUP_PIN` に6桁以上の数字を入れて `setup` を実行（権限は3つ: 特定のDriveファイル・このスプレッドシート・外部サービス接続）。実行後 `SETUP_PIN` は空に戻してよい
5. デプロイ → ウェブアプリ（実行ユーザー: 自分 / アクセス: 全員）
6. コードを更新したら「デプロイを管理」→ 鉛筆 → バージョン「新バージョン」→ デプロイ（URLは変わらない）

## 端末での使い方

GitHub Pages の画面を、接続先（GAS の Web app URL）付きで開く:

```
https://<user>.github.io/kanji-srs/spike/#api=<URLエンコードした Web app URL>
```

`#` 以降はサーバに送られず、端末の localStorage に保存された後アドレス欄から消える。接続先 URL はリポジトリにコミットしない。

## うまくいかないとき

- `GASの応答がJSONではありません` → GAS を「新バージョン」でデプロイし直したか確認
- `Required permissions: .../auth/drive` → **ドライブ全体の権限には切り替えない**（上記「権限を絞る理由」）
- PIN を10回間違えると10分ロックされる
