-- 登録先: mistake = まちがえた問題（毎日の復習に出す）/ new = 新しい問題（チャレンジで解き、△×なら mistake に移す）
ALTER TABLE items ADD COLUMN pool TEXT NOT NULL DEFAULT 'mistake';
-- 登録したときの登録先。記録を消して作り直すとき、チャレンジで間違えた記録が残っていなければこちらに戻す
ALTER TABLE items ADD COLUMN registered_pool TEXT NOT NULL DEFAULT 'mistake';
CREATE INDEX items_pool ON items(pool, status);

-- 解いた場面: daily = 毎日の復習 / new = 新しい問題のチャレンジ（10分の枠や「もう一回」に数えない）
ALTER TABLE reviews ADD COLUMN mode TEXT NOT NULL DEFAULT 'daily';
