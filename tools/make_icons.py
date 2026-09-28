"""ホーム画面用アイコン（PWA）を作る。 python tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / 'app' / 'icons'
FONT = r'C:\Windows\Fonts\BIZ-UDGothicB.ttc'
ICONS = {'study': ('漢', '#2f6fdb'), 'admin': ('管', '#3a3a38')}

for name, (ch, bg) in ICONS.items():
    for size in (192, 512):
        im = Image.new('RGB', (size, size), bg)  # 全面塗り（マスク可能アイコンの安全領域に字を収める）
        d = ImageDraw.Draw(im)
        f = ImageFont.truetype(FONT, int(size * 0.5))
        d.text((size / 2, size / 2), ch, font=f, fill='#ffffff', anchor='mm')
        im.save(OUT / f'{name}-{size}.png', optimize=True)
print('ok')
