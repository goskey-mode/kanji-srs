-- 写真用データベース（無料プランは1データベース500MBまでのため、データ用と分ける）
CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
