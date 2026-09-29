# Placeholder photos for trying the renderer before the real ones arrive.
from PIL import Image, ImageDraw
import colorsys
for i, n in enumerate(['hero', 'two', 'three', 'group']):
    W, H = (1600, 1067) if n == 'group' else (1067, 1600)
    im = Image.new('RGB', (W, H)); d = ImageDraw.Draw(im)
    for y in range(H):
        r, g, b = colorsys.hls_to_rgb((0.85 + i * 0.04) % 1, 0.25 + 0.25 * y / H, 0.35)
        d.line([(0, y), (W, y)], fill=(int(r * 255), int(g * 255), int(b * 255)))
    d.text((W / 2, H / 2), n, fill='white', anchor='mm')
    im.save(f'photos/{n}.jpg', quality=88)
