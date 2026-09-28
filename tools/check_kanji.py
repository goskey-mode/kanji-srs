"""data/kanji*.json（1026字の例文データ）の自動チェック。

  python tools/check_kanji.py [--grade N] [--report path.md]

作り直しが必要なもの（error）と、人が確認すべきもの（review）に分けて出す。
読みの確認は形態素解析（fugashi + unidic-lite）で行うが、辞書側も読みを間違える
（例: 山道→サンドウ）ため、食い違いは「作り直し」ではなく「確認」に回す。
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KANJI_RE = re.compile(r'[一-鿿]')  # 「々」はくり返しの記号なので数えない
HIRA_RE = re.compile(r'^[ぁ-ゟー]+$')
KANA_RE = re.compile(r'^[ぁ-ゟァ-ヿー]+$')


def hira(s):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


def is_kana(s):
    return bool(s) and bool(KANA_RE.match(s))


def analyzer_reading(tagger, sentence, answer):
    """例文を解析して、答えの部分の読み（ひらがな）を返す。区切りが合わなければ None と理由"""
    start = sentence.find(answer)
    end = start + len(answer)
    pos = 0
    parts = []
    for w in tagger(sentence):
        s, e = pos, pos + len(w.surface)
        pos = e
        if e <= start or s >= end:
            continue
        kana = hira(w.feature.kana or '')
        if not kana:
            return None, '辞書に読みがない語: ' + w.surface
        surf = w.surface
        # 答えの外にはみ出した部分がかなだけなら、読みから取り除く（例: 「お金」から「お」を除く）
        if s < start:
            extra = surf[:start - s]
            if not is_kana(extra) or not kana.startswith(hira(extra)):
                return None, '区切りが合わない: ' + surf
            kana, surf = kana[len(extra):], surf[len(extra):]
        if e > end:
            extra = surf[len(surf) - (e - end):]
            if not is_kana(extra) or not kana.endswith(hira(extra)):
                return None, '区切りが合わない: ' + w.surface
            kana = kana[:len(kana) - len(extra)]
        parts.append(kana)
    return ''.join(parts), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--grade', type=int)
    ap.add_argument('--report')
    args = ap.parse_args()

    grades = json.loads((ROOT / 'data' / 'grades.json').read_text(encoding='utf-8'))['grades']
    grade_of = {c: int(g) for g, chars in grades.items() for c in chars}
    order = {c: i for i, c in enumerate(''.join(grades[str(g)] for g in range(1, 7)))}
    # data/kanji.json（1年生）と data/kanji_g2.json … kanji_g6.json（学年ごと）をまとめて読む
    data = []
    for f in sorted((ROOT / 'data').glob('kanji*.json')):
        data += json.loads(f.read_text(encoding='utf-8'))

    import fugashi
    tagger = fugashi.Tagger()

    results = []
    seen_char, seen_answer = {}, {}
    for d in data:
        c, g = d['char'], d['grade']
        err, rev = [], []
        s, a, r, pf = d['sentence'], d['answer'], d['reading'], d.get('prompt_form', '')
        if grade_of.get(c) != g:
            err.append(f'配当表では {grade_of.get(c)} 年生の字')
        if c not in a:
            err.append('答えに対象の字がない')
        if a not in s:
            err.append('例文に答えがない')
        elif s.count(a) > 1:
            err.append('例文に答えが2回以上ある')
        if not HIRA_RE.match(r):
            err.append('読みがひらがなではない')
        if pf and not KANA_RE.match(pf):
            err.append('出題表記がかなではない')
        if pf and hira(pf) != r:
            err.append(f'出題表記「{pf}」と読みが合わない')
        okuri = re.sub(r'^.*[一-鿿]', '', a)
        if okuri and not pf:
            err.append('送り仮名がある語に出題表記がない')
        # 例文・答えのほかの漢字は、小学校で習う1026字ならどの学年でもよい（2026-09-28 方針変更）。それ以外はひらがなにする
        for k in KANJI_RE.findall(s):
            if k not in grade_of:
                err.append(f'小学校で習わない字「{k}」')
        if len(a) < 2:
            err.append('答えが1文字（語にする）')
        if len(s) > 20:
            err.append(f'例文が長い（{len(s)}字）')
        if c in seen_char:
            err.append('同じ字が重複')
        if a in seen_answer:
            err.append(f'答えが「{seen_answer[a]}」と重複')
        seen_char[c] = True
        seen_answer.setdefault(a, c)
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
        missing = [c for c in grades[str(g)] if c not in seen_char]
        if missing and any(d['grade'] == g for d in data):
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
        kata = lambda s: ''.join(chr(ord(ch) + 0x60) if 'ぁ' <= ch <= 'ゖ' else ch for ch in s)
        lines = ['| # | 字 | 出題（子どもの画面） | 答え | 読み | 意味（答えの画面に表示） | 自動チェック |', '|---|---|---|---|---|---|---|']
        for i, x in enumerate(shown, 1):
            pf = x.get('prompt_form') or kata(x['reading'])
            q = x['sentence'].replace(x['answer'], '**' + pf + '**', 1)
            chk = ' / '.join(x['errors'] + x['review']) or '✓'
            lines.append(f"| {i} | {x['char']} | {q} | {x['answer']} | {x['reading']} | {x.get('meaning', '')} | {chk} |")
        Path(args.report).write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return 1 if n_err else 0


if __name__ == '__main__':
    sys.exit(main())
