"""
AegisTrans Logo v3 - 保留原色彩漸層，純做品質增強
- 去白底（硬切，無 anti-alias 殘留）
- 微提高對比與飽和（讓漸層更鮮明）
- 加 outer glow（青綠輝光）
- 輸出 PWA 各尺寸
"""

from PIL import Image, ImageFilter, ImageEnhance, ImageChops
import os

SRC_PATH = '/mnt/user-data/uploads/Aegistrans_logo.png'
OUT_DIR = '/tmp/aegistrans_v3'
os.makedirs(OUT_DIR, exist_ok=True)

GLOW_COLOR = (84, 233, 207)  # #54E9CF 同 AegisTalk inner glow

# === 1. 載入 + 去白底 ===
print("[1] 去白底...")
src = Image.open(SRC_PATH).convert('RGBA')

def white_to_alpha(img, threshold=215):
    out = img.copy()
    data = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = data[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                data[x, y] = (0, 0, 0, 0)
    return out

cleaned = white_to_alpha(src)
bbox = cleaned.getbbox()
trimmed = cleaned.crop(bbox)
print(f"    Trim: {trimmed.size}")

# === 2. 微提高對比與飽和（讓 logo 內部漸層更鮮明）===
print("[2] 增強對比與飽和...")
# 拆 RGB 與 Alpha 分別處理
r, g, b, a = trimmed.split()
rgb = Image.merge('RGB', (r, g, b))
rgb = ImageEnhance.Contrast(rgb).enhance(1.10)      # 對比 +10%
rgb = ImageEnhance.Color(rgb).enhance(1.20)         # 飽和 +20%
r2, g2, b2 = rgb.split()
enhanced = Image.merge('RGBA', (r2, g2, b2, a))

# === 3. 建立 outer glow（從 alpha mask 模糊 + 青綠著色）===
print("[3] 建立 outer glow...")
W, H = enhanced.size

# 從 alpha 通道做 outer glow：放大 + blur，讓 glow 從 logo 邊緣向外擴散
alpha = enhanced.split()[3]
# 多層次 glow：近處強、遠處弱
glow1 = alpha.filter(ImageFilter.GaussianBlur(radius=W // 60))   # 近 glow
glow2 = alpha.filter(ImageFilter.GaussianBlur(radius=W // 30))   # 中 glow
glow3 = alpha.filter(ImageFilter.GaussianBlur(radius=W // 15))   # 遠 glow

def make_glow_layer(glow_alpha, max_alpha, color):
    layer = Image.new('RGBA', (W, H), color + (0,))
    a = glow_alpha.point(lambda v: min(max_alpha, int(v * max_alpha / 255)))
    layer.putalpha(a)
    return layer

glow_layer1 = make_glow_layer(glow1, 120, GLOW_COLOR)
glow_layer2 = make_glow_layer(glow2, 80, GLOW_COLOR)
glow_layer3 = make_glow_layer(glow3, 50, GLOW_COLOR)

# === 4. 合成（從遠到近的 glow 然後 logo 主體在最上層）===
print("[4] 合成最終圖...")
final = Image.new('RGBA', (W, H), (0, 0, 0, 0))
final = Image.alpha_composite(final, glow_layer3)
final = Image.alpha_composite(final, glow_layer2)
final = Image.alpha_composite(final, glow_layer1)
final = Image.alpha_composite(final, enhanced)

# === 5. 輸出各尺寸 ===
print("[5] 輸出各尺寸...")

def fit_square(img, size, bg, content_ratio=0.95):
    """保留一點 padding 讓 glow 不被切掉"""
    iw, ih = img.size
    target = int(size * content_ratio)
    scale = target / max(iw, ih)
    new_w, new_h = int(iw * scale), int(ih * scale)
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), bg)
    cx = (size - new_w) // 2
    cy = (size - new_h) // 2
    canvas.paste(resized, (cx, cy), resized)
    return canvas

# logo-transparent.png（高解析度，1024 max）
max_dim = 1024
scale = max_dim / max(final.size)
trans = final.resize((int(final.size[0]*scale), int(final.size[1]*scale)), Image.LANCZOS)
trans.save(f'{OUT_DIR}/logo-transparent.png', 'PNG', optimize=True)

fit_square(final, 192, (0,0,0,0), 0.95).save(f'{OUT_DIR}/logo-192.png', 'PNG', optimize=True)
fit_square(final, 512, (0,0,0,0), 0.95).save(f'{OUT_DIR}/logo-512.png', 'PNG', optimize=True)
fit_square(final, 512, (20,48,87,255), 0.70).save(f'{OUT_DIR}/logo-512-masked.png', 'PNG', optimize=True)
fit_square(final, 64, (0,0,0,0), 0.95).save(f'{OUT_DIR}/favicon.png', 'PNG', optimize=True)

print("\n=== 完成 ===")
for fn in ['favicon.png', 'logo-192.png', 'logo-512.png', 'logo-512-masked.png', 'logo-transparent.png']:
    p = f'{OUT_DIR}/{fn}'
    sz = os.path.getsize(p)
    img = Image.open(p)
    print(f"  {fn}: {img.size}, {sz:,} bytes")
