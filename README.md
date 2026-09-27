# kanji-srs

間違えた問題（漢字・計算・記述など）を忘却曲線に沿って繰り返し出題する、家庭用の間隔反復アプリ。

- **API**: Cloudflare Workers + D1（`worker/`）。データ用と写真用の2つのデータベース
- **画面**: 静的ページ（`app/`）。GitHub Pages で配信
  - `study.html` — 子ども用（タブレット）。今日の問題 → 答え → ○△× を自己採点
  - `admin.html` — 保護者用（スマホ・PC）。登録・一覧・状況・CSV書き出し

画面は `fetch`（Cookie なし）で `POST /api {"fn","pin","args"}` を呼ぶ。PIN は子ども用（解答のみ）と保護者用（登録・修正・削除も可）の2種類。写真は署名付きURL `GET /photo/<id>` で配り、端末のキャッシュが効く。

`gas/` は以前の Google Apps Script 版（1回の通信に約1秒かかるため Workers に移行）。

## 復習のルール

- 間隔は 1 → 3 → 7 → 14 → 30 → 60 日。○で次の段階、△で同じ間隔をもう一度、×で最初から
- 60日後の復習で○なら卒業。180日後に1回だけ抜き打ち（○で完全卒業、×で復活、△は30日後に再度）
- 1日の量は既定10分（見積もり: 書き20秒・読み10秒・語句15秒・写真問題90秒）。段階の低いカードから積み、新しいカードは1日4枚まで（登録順、塾・模試の問題を先に）。あふれた分は翌日以降へ
- 1日の区切りは午前3時。連続日数は「その日の分を終えた日」で数え、休んだ日はお休みチケット（月2枚）を自動で使う
- 設定は `settings` テーブル（`wrangler d1 execute kanji-srs --remote --command "UPDATE settings SET value='6' WHERE key='new_per_day'"` など）

## 無料プランの制約への対応

- D1 は1データベース500MBまで → 写真を別データベースに分け、長辺1280px・JPEG品質0.75に縮小。保護者画面の「状況」に使用量メーター
- 1回の呼び出しで命令50個まで → 複数行の書き込みは `json_each` で1命令にまとめる
- CPU時間が短い → 集計は SQL 側で行う。CSV 書き出しは5000行ずつ

## セットアップ

```
npm install
npx wrangler login                                             # ブラウザで許可
npx wrangler d1 create kanji-srs                               # 表示された database_id を worker/wrangler.toml に
npx wrangler d1 create kanji-srs-photos                        # 同上
npx wrangler d1 migrations apply DB --remote --config worker/wrangler.toml
npx wrangler d1 migrations apply PHOTOS --remote --config worker/wrangler.toml
npx wrangler secret put STUDY_PIN --config worker/wrangler.toml   # 子ども用（6桁以上）
npx wrangler secret put ADMIN_PIN --config worker/wrangler.toml   # 保護者用（別の数字）
npm run deploy
```

端末で `https://<user>.github.io/kanji-srs/app/#api=<URLエンコードした https://kanji-srs.<subdomain>.workers.dev/api>` を開く（`#` 以降はサーバに送られず、端末に保存された後アドレス欄から消える）。PIN・データはリポジトリに含めない。

## 開発

```
npm test                                   # Worker（node:sqlite 上の D1 シム）・画面の共通部品・旧GAS版のテスト
npm run dev                                # http://127.0.0.1:8765/ で画面を確認（API は 127.0.0.1:8787）
npm run smoke -- <APIのURL> <学習PIN> <親PIN> [--readonly]   # 動いている API の通し確認と応答時間
```

ローカルの PIN は `test/dev-server.mjs` と `worker/.dev.vars`（git 管理外）で設定する。
