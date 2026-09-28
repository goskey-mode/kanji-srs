-- 読み取り行数（D1 無料枠: 1日500万行）を抑えるための索引
-- 2026-09-28、字と語の対応表（tools/link_kanji.py）が約2000語それぞれで items を全件走査し、上限を超えた
CREATE INDEX items_answer ON items(answer, reading);
-- 問題 → 字（チャレンジで同じ字の語を後回しにするため）
CREATE INDEX kanji_item ON kanji(item_id);
CREATE INDEX kanji_kun_item ON kanji_kun(item_id);
