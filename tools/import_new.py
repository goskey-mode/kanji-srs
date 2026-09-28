"""AIで作ったデータ（漢字・作文の表現）を「新しい問題」として D1 に取り込む SQL を作る。

  python tools/import_new.py --grades 1-5 --skip-answers 貿易 > import.sql
  npx wrangler d1 execute kanji-srs --remote --config worker/wrangler.toml --file import.sql

- 漢字は書き・読みの両方のカード、作文の表現は1枚
- 出典（source）に目印を入れるので、取り消すときは
  UPDATE items SET status = 'deleted' WHERE source = '<目印>'
"""
import argparse
import glob
import json
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXPR_UNITS = {'つなぎ言葉・意見': '作文・つなぎ言葉', '気持ち・評価': '作文・気持ち', '四字熟語': '四字熟語', '慣用句・ことわざ': 'ことわざ・慣用句'}
ITEM_COLS = ['item_id', 'type', 'subject', 'unit', 'sentence', 'answer', 'reading', 'prompt_form', 'explanation', 'photo_q', 'photo_a',
             'source', 'qno', 'source_date', 'reason', 'origin', 'pool', 'registered_pool', 'created_at', 'status']
CARD_COLS = ['card_id', 'item_id', 'direction', 'stage', 'due', 'state', 'reps', 'lapses', 'last_result', 'last_reviewed_at', 'introduced_on']


def rid(prefix):
    return prefix + secrets.token_hex(9)


def q(v):
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def inserts(table, cols, rows, chunk=50):
    for i in range(0, len(rows), chunk):
        values = ',\n'.join('(' + ', '.join(q(r[c]) for c in cols) + ')' for r in rows[i:i + chunk])
        yield f'INSERT INTO {table} ({", ".join(cols)}) VALUES\n{values};'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grades', default='1-5', help='取り込む学年（例: 1-5, 6）')
    ap.add_argument('--no-expressions', action='store_true')
    ap.add_argument('--skip-answers', default='', help='すでに本番にある答え（カンマ区切り）は取り込まない')
    ap.add_argument('--tag', default='AIデータ ' + datetime.now(timezone(timedelta(hours=9))).strftime('%Y-%m-%d'))
    args = ap.parse_args()
    lo, _, hi = args.grades.partition('-')
    grades = set(range(int(lo), int(hi or lo) + 1))
    skip = {s for s in args.skip_answers.split(',') if s}

    kanji = []
    for f in sorted((ROOT / 'data').glob('kanji*.json')):
        kanji += json.loads(f.read_text(encoding='utf-8'))
    order = json.loads((ROOT / 'data' / 'grades.json').read_text(encoding='utf-8'))['grades']
    pos = {c: i for g in range(1, 7) for i, c in enumerate(order[str(g)])}
    kanji = sorted([k for k in kanji if k['grade'] in grades and k['answer'] not in skip], key=lambda k: (k['grade'], pos[k['char']]))
    exprs = []
    if not args.no_expressions:
        for f in sorted(glob.glob(str(ROOT / 'data' / 'expressions*.json'))):
            exprs += json.loads(Path(f).read_text(encoding='utf-8'))

    base = datetime.now(timezone.utc)
    items, cards = [], []

    def add(item, directions):
        item.update({'item_id': rid('i'), 'created_at': (base + timedelta(milliseconds=len(items))).isoformat(timespec='milliseconds').replace('+00:00', 'Z')})
        items.append(item)
        for d in directions:
            cards.append({'card_id': rid('c'), 'item_id': item['item_id'], 'direction': d, 'stage': 0, 'due': '', 'state': 'new',
                          'reps': 0, 'lapses': 0, 'last_result': '', 'last_reviewed_at': '', 'introduced_on': ''})

    common = {'type': 'A', 'subject': '国語', 'photo_q': '', 'photo_a': '', 'qno': '', 'source_date': '', 'reason': '', 'origin': 'その他',
              'pool': 'new', 'registered_pool': 'new', 'status': 'active', 'source': args.tag}
    for k in kanji:
        add({**common, 'unit': f"漢字{k['grade']}年生", 'sentence': k['sentence'], 'answer': k['answer'], 'reading': k['reading'],
             'prompt_form': k.get('prompt_form', ''), 'explanation': k.get('meaning', '')}, ['write', 'read'])
    for e in exprs:
        add({**common, 'unit': EXPR_UNITS[e['category']], 'sentence': e['sentence'], 'answer': e['answer'], 'reading': '', 'prompt_form': '',
             'explanation': '意味: ' + e['meaning'] + '／使う場面: ' + e['scene']}, ['single'])

    out = list(inserts('items', ITEM_COLS, items)) + list(inserts('cards', CARD_COLS, cards))
    sys.stdout.write('\n'.join(out) + '\n')
    sys.stderr.write(f'items {len(items)} (漢字 {len(kanji)} / 作文の表現 {len(exprs)}), cards {len(cards)}, 目印「{args.tag}」\n')


if __name__ == '__main__':
    main()
