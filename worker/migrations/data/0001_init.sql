-- データ用データベース（問題・カード・解答・日ごとの記録・設定）
CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT '',
  sentence TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  reading TEXT NOT NULL DEFAULT '',
  prompt_form TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  photo_q TEXT NOT NULL DEFAULT '',
  photo_a TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  qno TEXT NOT NULL DEFAULT '',
  source_date TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'その他',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE cards (
  card_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  stage INTEGER NOT NULL DEFAULT 0,
  due TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new',
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_result TEXT NOT NULL DEFAULT '',
  last_reviewed_at TEXT NOT NULL DEFAULT '',
  introduced_on TEXT NOT NULL DEFAULT ''
);
CREATE INDEX cards_item ON cards(item_id);
CREATE INDEX cards_state_due ON cards(state, due);
CREATE INDEX cards_introduced ON cards(introduced_on);

CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  study_day TEXT NOT NULL,
  result TEXT NOT NULL,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  stage_before INTEGER NOT NULL,
  stage_after INTEGER NOT NULL
);
CREATE INDEX reviews_card ON reviews(card_id);
CREATE INDEX reviews_day ON reviews(study_day);

CREATE TABLE days (
  study_day TEXT PRIMARY KEY,
  completed INTEGER NOT NULL DEFAULT 0,
  cards_done INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  freeze_used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES
  ('daily_seconds', '600'), ('new_per_day', '4'), ('day_start_hour', '3'), ('freezes_per_month', '2'),
  ('sec_read', '10'), ('sec_write', '20'), ('sec_single', '15'), ('sec_photo', '90');

-- PIN の失敗回数（10回で10分ロック）
CREATE TABLE auth_fail (k TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);

-- 写真URLの署名鍵など（初回に自動生成。APIからは読めない）
CREATE TABLE secrets (k TEXT PRIMARY KEY, v TEXT NOT NULL);
