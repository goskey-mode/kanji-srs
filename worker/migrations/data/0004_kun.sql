-- 訓読みの問題: 1字につき訓読みの語を1つ（送り仮名つきを優先）。訓読みの無い字は空
-- item_id は音読みの語。図鑑では2語の状態をまとめて1マスに表示する
ALTER TABLE kanji ADD COLUMN kun_item_id TEXT NOT NULL DEFAULT '';
