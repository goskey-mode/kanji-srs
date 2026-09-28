"""漢字図鑑の対応表（kanji: 字 → 熟語、kanji_kun: 字 → 訓読みの語）を作る SQL を出す。

  python tools/link_kanji.py > link.sql
  npx wrangler d1 execute kanji-srs --remote --config worker/wrangler.toml --file link.sql

- 1026字すべての行を作る（学年・配当表の順番つき）。何度実行してもよい（上書き・作り直し）
- kanji.item_id = 熟語（data/kanji*.json）、kanji_kun = 訓読みの語（data/kun_g*.json。1字に複数、訓読みの無い字は無し）
- 問題は答えと読みで探す。AIデータで取り込んだ問題を優先し、
  なければ親が登録した同じ語の問題（例: 塾で間違えた「貿易」「設ける」）につなぐ
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def q(v):
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def find(answer, reading):
    """答えと読みで問題を探す（同じ字の別の訓は答えが同じこともある: 音＝ね・おと）"""
    return f"""COALESCE((SELECT item_id FROM items
    WHERE answer = {answer} AND reading = {reading} AND {answer} <> '' AND type = 'A' AND status <> 'deleted'
    ORDER BY source LIKE 'AIデータ%' DESC, created_at LIMIT 1), '')"""


def values(rows):
    return ',\n'.join('(' + ', '.join(q(v) for v in r) + ')' for r in rows)


def main():
    order = json.loads((ROOT / 'data' / 'grades.json').read_text(encoding='utf-8'))['grades']
    onkun = json.loads((ROOT / 'data' / 'onkun.json').read_text(encoding='utf-8'))['kanji']
    words = {}
    for f in sorted((ROOT / 'data').glob('kanji*.json')):
        for k in json.loads(f.read_text(encoding='utf-8')):
            words[k['char']] = (k['answer'], k['reading'])
    kun = []
    for f in sorted((ROOT / 'data').glob('kun_g*.json')):
        for k in json.loads(f.read_text(encoding='utf-8')):
            reads = [r[0] for r in onkun[k['char']]['readings']]
            kun.append((k['char'], k['answer'], k['reading'], reads.index(k['kun'])))
    rows = []
    for g in range(1, 7):
        for i, ch in enumerate(order[str(g)]):
            a, r = words.get(ch, ('', ''))
            rows.append((ch, g, i, a, r))
    out = []
    for n in range(0, len(rows), 100):
        out.append(f"""INSERT INTO kanji (char, grade, ord, item_id)
SELECT column1, column2, column3, {find('column4', 'column5')}
FROM (VALUES
{values(rows[n:n + 100])})
WHERE true
ON CONFLICT(char) DO UPDATE SET grade = excluded.grade, ord = excluded.ord, item_id = excluded.item_id;""")
    # 訓読みの語は作り直す（見つからない語は入れない）
    out.append('DELETE FROM kanji_kun;')
    for n in range(0, len(kun), 100):
        out.append(f"""INSERT INTO kanji_kun (char, item_id, ord)
SELECT column1, id, column4 FROM (SELECT column1, column4, {find('column2', 'column3')} AS id
FROM (VALUES
{values(kun[n:n + 100])})) WHERE id <> '';""")
    sys.stdout.write('\n'.join(out) + '\n')
    missing = [r[0] for r in rows if not r[3]]
    sys.stderr.write(f'{len(rows)}字（熟語の語が無い字: {len(missing)} {"".join(missing)}）／訓読みの語 {len(kun)}\n')


if __name__ == '__main__':
    main()
