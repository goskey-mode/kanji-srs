"""漢字図鑑の対応表（kanji テーブル: 字 → その字を学ぶ問題）を作る SQL を出す。

  python tools/link_kanji.py > link.sql
  npx wrangler d1 execute kanji-srs --remote --config worker/wrangler.toml --file link.sql

- 1026字すべての行を作る（学年・配当表の順番つき）。何度実行してもよい（上書き）
- item_id = 音読みの語（data/kanji*.json）、kun_item_id = 訓読みの語（data/kun_g*.json。訓読みの無い字は空）
- 問題は答え（語）で探す。AIデータで取り込んだ問題を優先し、
  なければ親が登録した同じ答えの問題（例: 塾で間違えた「貿易」「設ける」）につなぐ
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def q(v):
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def find(col):
    return f"""COALESCE((SELECT item_id FROM items
    WHERE answer = {col} AND {col} <> '' AND type = 'A' AND status <> 'deleted'
    ORDER BY source LIKE 'AIデータ%' DESC, created_at LIMIT 1), '')"""


def main():
    order = json.loads((ROOT / 'data' / 'grades.json').read_text(encoding='utf-8'))['grades']
    words, kun = {}, {}
    for f in sorted((ROOT / 'data').glob('kanji*.json')):
        for k in json.loads(f.read_text(encoding='utf-8')):
            words[k['char']] = k['answer']
    for f in sorted((ROOT / 'data').glob('kun_g*.json')):
        for k in json.loads(f.read_text(encoding='utf-8')):
            kun[k['char']] = k['answer']
    rows = []
    for g in range(1, 7):
        for i, ch in enumerate(order[str(g)]):
            rows.append((ch, g, i, words.get(ch, ''), kun.get(ch, '')))
    out = []
    for n in range(0, len(rows), 100):
        values = ',\n'.join('(' + ', '.join(q(v) for v in r) + ')' for r in rows[n:n + 100])
        out.append(f"""INSERT INTO kanji (char, grade, ord, item_id, kun_item_id)
SELECT column1, column2, column3, {find('column4')}, {find('column5')}
FROM (VALUES
{values})
WHERE true
ON CONFLICT(char) DO UPDATE SET grade = excluded.grade, ord = excluded.ord, item_id = excluded.item_id, kun_item_id = excluded.kun_item_id;""")
    sys.stdout.write('\n'.join(out) + '\n')
    missing = [r[0] for r in rows if not r[3]]
    sys.stderr.write(f'{len(rows)}字（音読みの語が無い字: {len(missing)} {"".join(missing)}／訓読みの語がある字: {sum(1 for r in rows if r[4])}）\n')


if __name__ == '__main__':
    main()
