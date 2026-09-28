-- 漢字図鑑: 小学校で習う1026字と、その字を学ぶ問題（語）の対応。tools/link_kanji.py で作る
CREATE TABLE kanji (
  char TEXT PRIMARY KEY,
  grade INTEGER NOT NULL,
  ord INTEGER NOT NULL,          -- 学年別漢字配当表での順番
  item_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX kanji_grade ON kanji(grade, ord);

-- 定着率の推移（ダッシュボード用）。その日最初に問題を読み込んだ時点の数を1行だけ残す
--   cards_total: 練習を始めたカード（learning / spot / retired）
--   cards_retained: そのうち定着したもの（卒業、または14日以上の間隔の段階で直近が○）
CREATE TABLE snapshots (
  study_day TEXT PRIMARY KEY,
  cards_total INTEGER NOT NULL,
  cards_retained INTEGER NOT NULL
);
