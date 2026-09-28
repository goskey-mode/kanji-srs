-- 訓読みの問題: 小学校で習う訓読み1つにつき語を1つ（1字に複数ある。例: 角 → 角＝かど、角＝つの）
-- 図鑑では、熟語（kanji.item_id）と訓読みの語（ここ）の状態をまとめて1マスに表示する。tools/link_kanji.py で作る
CREATE TABLE kanji_kun (
  char TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,   -- 音訓割り振り表での読みの順番
  PRIMARY KEY (char, item_id)
);
