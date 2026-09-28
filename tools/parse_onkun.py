"""文部科学省「音訓の小・中・高等学校段階別割り振り表」（平成29年3月）の PDF から data/onkun.json を作る。

  curl -o onkun.pdf https://www.mext.go.jp/a_menu/shotou/new-cs/__icsFiles/afieldfile/2017/05/15/1385768.pdf
  python tools/parse_onkun.py onkun.pdf      （pip install pdfplumber が必要）

表は3段組み。各段の「字・学年・読み・小/中/高の○」の横位置が一定なので、文字の座標から組み立てる。
読み取り後、学年別の字数（80/160/200/202/193/191）が合うかを出力するので確かめる。
"""
import pdfplumber, json, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
CJK = re.compile(r'^[㐀-鿿豈-﫿]$')
out = {}          # char -> {grade, readings:[[reading, school, indented]]}
order = []
cur = None
with pdfplumber.open(sys.argv[1] if len(sys.argv) > 1 else 'onkun.pdf') as pdf:
    for pi, pg in enumerate(pdf.pages[1:], start=2):
        ws = pg.extract_words()
        hdr = [w for w in ws if w['text'] == '小学校']
        if len(hdr) != 3:
            continue  # 表ではないページ（付表など）
        for g, h in enumerate(sorted(hdr, key=lambda w: w['x0'])):
            base = h['x0'] - 112.3          # 字の欄の左端
            sch = {'小': h['x0'] + 9.6, '中': h['x0'] + 49.9, '高': h['x0'] + 89.6}
            col = [w for w in ws if base - 5 <= w['x0'] < base + 235 and w['top'] > h['top'] + 5]
            rows = {}
            for w in col:
                rows.setdefault(round(w['top']), []).append(w)
            for top in sorted(rows):
                r = rows[top]
                kan = [w for w in r if w['x0'] < base + 15 and CJK.match(w['text'])]
                grd = [w for w in r if base + 18 <= w['x0'] < base + 35 and w['text'].isdigit()]
                rd = [w for w in r if base + 45 <= w['x0'] < base + 105]
                mk = [w for w in r if w['text'] == '○']
                if kan:
                    cur = kan[0]['text']
                    if cur not in out:
                        out[cur] = {'grade': int(grd[0]['text']) if grd else 0, 'readings': []}
                        order.append(cur)
                if rd and mk and cur:
                    m = mk[0]['x0'] + 4.7
                    school = min(sch, key=lambda k: abs(sch[k] - m))
                    out[cur]['readings'].append([rd[0]['text'], school, rd[0]['x0'] - base > 53])
                elif rd or (mk and not kan):
                    print('WARN p%d g%d top%d %s' % (pi, g, top, [w['text'] for w in r]), file=sys.stderr)
meta = {'source': '文部科学省「音訓の小・中・高等学校段階別割り振り表」（平成29年3月） https://www.mext.go.jp/a_menu/shotou/new-cs/1385768.htm',
        'note': '小学校の1026字のみ。読みは音=カタカナ・訓=ひらがな。段階は 小/中/高。「特別」は表で1字下げの（特別な・用法の狭い）読み。tools/parse_onkun.py で PDF の座標から読み取り、学年別の字数（80/160/200/202/193/191）と字の一覧が学年別漢字配当表と一致することを確認済み'}
elem = {c: {'grade': out[c]['grade'], 'readings': [[r[0], r[1]] + (['特別'] if r[2] else []) for r in out[c]['readings']]} for c in order if out[c]['grade']}
json.dump({'meta': meta, 'kanji': elem}, open(ROOT / 'data' / 'onkun.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
el = [c for c in order if out[c]['grade']]
print('kanji', len(order), 'elementary', len(el), 'by grade', {g: sum(1 for c in el if out[c]['grade'] == g) for g in range(1, 7)})
print('no readings', [c for c in order if not out[c]['readings']][:20])
