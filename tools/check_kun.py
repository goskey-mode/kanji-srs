"""data/kun_g*.json（訓読みの問題）の自動チェック。

  python tools/check_kun.py [--grade N] [--report path.md]

1字につき訓読みの語を1つ。答えは「字＋送り仮名」（安い・志す）か、送り仮名の無い名詞の訓（源・幹）。
読みは文部科学省「音訓の小・中・高等学校段階別割り振り表」（data/onkun.json）で
**小学校に割り振られた訓**であることを確かめる（ここは辞書と違って公式の表なので、合わなければ作り直し）。
例文の中での読みは形態素解析（fugashi + unidic-lite）でも確かめるが、辞書側も間違えるので食い違いは「確認」に回す。
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_kanji import analyzer_reading, hira, KANJI_RE, HIRA_RE, KANA_RE  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def kata(s):
    return ''.join(chr(ord(ch) + 0x60) if 'ぁ' <= ch <= 'ゖ' else ch for ch in s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grade', type=int)
    ap.add_argument('--report')
    args = ap.parse_args()

    onkun = json.loads((ROOT / 'data' / 'onkun.json').read_text(encoding='utf-8'))['kanji']
    order = {c: i for i, c in enumerate(onkun)}
    # 小学校で習う訓（1字下げの特別な読みは除く）
    kun = {c: [r[0] for r in v['readings'] if HIRA_RE.match(r[0]) and r[1] == '小' and len(r) == 2] for c, v in onkun.items()}
    on_answers = set()
    for f in sorted((ROOT / 'data').glob('kanji*.json')):
        on_answers |= {d['answer'] for d in json.loads(f.read_text(encoding='utf-8'))}
    data = []
    for f in sorted((ROOT / 'data').glob('kun_g*.json')):
        data += json.loads(f.read_text(encoding='utf-8'))

    import fugashi
    tagger = fugashi.Tagger()

    results, seen_char, seen_answer = [], {}, {}
    for d in data:
        c, g = d['char'], d['grade']
        s, a, r, pf = d['sentence'], d['answer'], d['reading'], d.get('prompt_form', '')
        err, rev = [], []
        if c not in onkun or onkun[c]['grade'] != g:
            err.append(f'配当表では {onkun.get(c, {}).get("grade")} 年生の字')
        okuri = a[1:]
        if not a.startswith(c) or (okuri and not HIRA_RE.match(okuri)):
            err.append('答えが「字＋送り仮名」の形ではない')
        if not HIRA_RE.match(r):
            err.append('読みがひらがなではない')
        elif r not in kun.get(c, []):
            err.append(f'小学校で習う訓ではない（小学校の訓: {"・".join(kun.get(c, [])) or "なし"}）')
        elif okuri and not r.endswith(okuri):
            err.append('送り仮名と読みが合わない')
        want_pf = kata(r[:len(r) - len(okuri)]) + okuri
        if pf != want_pf:
            err.append(f'出題表記は「{want_pf}」のはず')
        if a not in s:
            err.append('例文に答えがない')
        elif s.count(a) > 1:
            err.append('例文に答えが2回以上ある')
        for k in KANJI_RE.findall(s):
            if k not in onkun:
                err.append(f'小学校で習わない字「{k}」')
        if len(s) > 20:
            err.append(f'例文が長い（{len(s)}字）')
        if not d.get('meaning'):
            err.append('意味がない')
        if c in seen_char:
            err.append('同じ字が重複')
        if a in seen_answer:
            err.append(f'答えが「{seen_answer[a]}」と重複')
        if a in on_answers:
            err.append('音読みの問題の答えと同じ')
        seen_char[c] = True
        seen_answer.setdefault(a, c)
        # 送り仮名つきの読みがあるのに、送り仮名の無い名詞を選んでいないか（方針: 送り仮名つきを優先）
        if not okuri and any(len(x) > 1 and x != r and x[-1] in 'うくぐすつぬぶむるい' for x in kun.get(c, [])):
            rev.append('送り仮名つきの訓もある: ' + '・'.join(kun[c]))
        if a in s:
            got, why = analyzer_reading(tagger, s, a)
            if why:
                rev.append('辞書: ' + why)
            elif got != r:
                rev.append(f'辞書の読み「{got}」')
        results.append({**d, 'errors': err, 'review': rev})

    for g in range(1, 7):
        if args.grade and g != args.grade:
            continue
        if any(d['grade'] == g for d in data):
            missing = [c for c, v in onkun.items() if v['grade'] == g and kun[c] and c not in seen_char]
            if missing:
                print(f'{g}年生: 未作成 {len(missing)}字 {"".join(missing)}')

    shown = [x for x in results if not args.grade or x['grade'] == args.grade]
    shown.sort(key=lambda x: order.get(x['char'], 9999))
    n_err = sum(1 for x in shown if x['errors'])
    n_rev = sum(1 for x in shown if x['review'] and not x['errors'])
    print(f'対象 {len(shown)}字: 作り直し {n_err} / 要確認 {n_rev} / 問題なし {len(shown) - n_err - n_rev}')
    for x in shown:
        if x['errors'] or x['review']:
            print(f"  {x['char']} {x['sentence']} [{x['answer']}={x['reading']}] " + ' / '.join(x['errors'] + x['review']))

    if args.report:
        lines = ['| # | 字 | 出題（子どもの画面） | 答え | 読み | 小学校で習う訓 | 意味（答えの画面に表示） | 自動チェック |',
                 '|---|---|---|---|---|---|---|---|']
        for i, x in enumerate(shown, 1):
            q = x['sentence'].replace(x['answer'], '**' + (x.get('prompt_form') or kata(x['reading'])) + '**', 1)
            chk = ' / '.join(x['errors'] + x['review']) or '✓'
            lines.append(f"| {i} | {x['char']} | {q} | {x['answer']} | {x['reading']} | {'・'.join(kun.get(x['char'], []))} | {x.get('meaning', '')} | {chk} |")
        Path(args.report).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return 1 if n_err else 0


if __name__ == '__main__':
    sys.exit(main())
