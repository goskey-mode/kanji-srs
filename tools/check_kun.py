"""data/kun_g*.json（訓読みの問題）の自動チェック。

  python tools/check_kun.py [--grade N] [--report path.md]

小学校で習う訓読み（文部科学省「音訓の小・中・高等学校段階別割り振り表」、data/onkun.json）の
**1つ1つに語を1つ**。各語の kun が、その語で問う訓読み。
- 答えが「字＋送り仮名」（安い・志す）か、送り仮名の無い名詞（源）なら、読み＝その訓（または訓＋送り仮名）であることを確かめる（公式の表なので、合わなければ作り直し）
- 単独では使わない訓（一＝ひと、上＝かみ、辺＝べ）は熟語（一休み・川上・海辺）で問う。読みの中にその訓（濁った形も含む）が入っていることだけ確かめ、残りは人が確認する
例文の中での読みは形態素解析（fugashi + unidic-lite）でも確かめるが、辞書側も間違えるので食い違いは「確認」に回す。
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_kanji import analyzer_reading, KANJI_RE, HIRA_RE  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DAKU = str.maketrans('かきくけこさしすせそたちつてとはひふへほ', 'がぎぐげござじずぜぞだぢづでどばびぶべぼ')
HANDAKU = str.maketrans('はひふへほ', 'ぱぴぷぺぽ')


def kata(s):
    return ''.join(chr(ord(ch) + 0x60) if 'ぁ' <= ch <= 'ゖ' else ch for ch in s)


def prompt_form(answer, reading):
    """出題表記: 漢字の部分はカタカナ、最後の送り仮名はひらがな（例: 一休み → ヒトヤスみ）"""
    okuri = re.search(r'[ぁ-ゟ]*$', answer).group()
    return kata(reading[:len(reading) - len(okuri)]) + okuri


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

    results, seen, seen_answer = [], set(), {}
    for d in data:
        c, g, k = d['char'], d['grade'], d.get('kun', '')
        s, a, r, pf = d['sentence'], d['answer'], d['reading'], d.get('prompt_form', '')
        err, rev = [], []
        if c not in onkun or onkun[c]['grade'] != g:
            err.append(f'配当表では {onkun.get(c, {}).get("grade")} 年生の字')
        if k not in kun.get(c, []):
            err.append(f'「{k}」は小学校で習う訓ではない（小学校の訓: {"・".join(kun.get(c, [])) or "なし"}）')
        if not HIRA_RE.match(r):
            err.append('読みがひらがなではない')
        simple = a.startswith(c) and (len(a) == 1 or HIRA_RE.match(a[1:]))
        if c not in a:
            err.append('答えに対象の字がない')
        elif simple:
            okuri = a[1:]
            # 表の訓が語幹だけの字もある（異＝こと → 異なる）。そのときは「表の訓＋送り仮名」も認める
            if r != k and not (okuri and r == k + okuri):
                err.append(f'読み「{r}」が訓「{k}」と合わない')
            elif okuri and not r.endswith(okuri):
                err.append('送り仮名と読みが合わない')
        else:
            # 熟語の中の訓: 読みの中にその訓（濁った形も含む）があるか
            forms = {k, k[0].translate(DAKU) + k[1:], k[0].translate(HANDAKU) + k[1:]}
            if not any(x in r for x in forms):
                err.append(f'読みの中に訓「{k}」がない')
            else:
                rev.append(f'熟語の中の訓（{c}＝{k}）')
        want = prompt_form(a, r)
        if pf != want:
            err.append(f'出題表記は「{want}」のはず')
        if a not in s:
            err.append('例文に答えがない')
        elif s.count(a) > 1:
            err.append('例文に答えが2回以上ある')
        for x in KANJI_RE.findall(s):
            if x not in onkun:
                err.append(f'小学校で習わない字「{x}」')
        if len(s) > 22:
            err.append(f'例文が長い（{len(s)}字）')
        if not d.get('meaning'):
            err.append('意味がない')
        if (c, k) in seen:
            err.append('同じ字・同じ訓が重複')
        if (a, r) in seen_answer:  # 同じ字の別の訓（音＝ね・おと）は答えが同じでも読みで区別する
            err.append(f'答えと読みが「{seen_answer[(a, r)]}」と重複')
        if a in on_answers:
            err.append('熟語の問題の答えと同じ')
        seen.add((c, k))
        seen_answer.setdefault((a, r), c)
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
            missing = [f'{c}={x}' for c, v in onkun.items() if v['grade'] == g for x in kun[c] if (c, x) not in seen]
            if missing:
                print(f'{g}年生: 未作成 {len(missing)}個 {" ".join(missing)}')

    shown = [x for x in results if not args.grade or x['grade'] == args.grade]
    shown.sort(key=lambda x: (order.get(x['char'], 9999), kun.get(x['char'], []).index(x['kun']) if x['kun'] in kun.get(x['char'], []) else 99))
    n_err = sum(1 for x in shown if x['errors'])
    n_rev = sum(1 for x in shown if x['review'] and not x['errors'])
    print(f'対象 {len(shown)}語: 作り直し {n_err} / 要確認 {n_rev} / 問題なし {len(shown) - n_err - n_rev}')
    for x in shown:
        if x['errors'] or x['review']:
            print(f"  {x['char']}={x['kun']} {x['sentence']} [{x['answer']}={x['reading']}] " + ' / '.join(x['errors'] + x['review']))

    if args.report:
        lines = ['| # | 字 | 訓 | 出題（子どもの画面） | 答え | 読み | 意味（答えの画面に表示） | 自動チェック |',
                 '|---|---|---|---|---|---|---|---|']
        for i, x in enumerate(shown, 1):
            q = x['sentence'].replace(x['answer'], '**' + (x.get('prompt_form') or kata(x['reading'])) + '**', 1)
            chk = ' / '.join(x['errors'] + x['review']) or '✓'
            lines.append(f"| {i} | {x['char']} | {x['kun']} | {q} | {x['answer']} | {x['reading']} | {x.get('meaning', '')} | {chk} |")
        Path(args.report).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return 1 if n_err else 0


if __name__ == '__main__':
    sys.exit(main())
