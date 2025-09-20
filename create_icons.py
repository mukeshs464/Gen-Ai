from PIL import Image, ImageDraw, ImageFont
import os
os.makedirs('icons', exist_ok=True)
sizes = [16, 32, 48, 128]
for s in sizes:
    img = Image.new('RGBA', (s, s), (67,97,238,255))
    draw = ImageDraw.Draw(img)
    # try to draw a center letter 'S' if a truetype font is available; otherwise draw circle
    try:
        font_size = max(8, s * 3 // 4)
        fnt = ImageFont.truetype('arial.ttf', font_size)
        w, h = draw.textsize('S', font=fnt)
        draw.text(((s - w) / 2, (s - h) / 2), 'S', font=fnt, fill=(255,255,255,255))
    except Exception:
        draw.ellipse((s*0.18, s*0.18, s*0.82, s*0.82), fill=(255,255,255,255))
    path = os.path.join('icons', f'{s}.png')
    img.save(path)
    print('Created', path)
