"""Create a labeled, synthetic capture series for practicing inspection."""

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def generate():
    width, height = 740, 470
    y, x = np.mgrid[0:height, 0:width]
    rng = np.random.default_rng(23)
    noise = rng.normal(0, 0.75, (height, width))
    gradient = 224 - 13 * (x / width) - 5 * (y / height) + 3 * np.sin(y / 38)
    base = np.stack([gradient + noise + 4, gradient + noise + 2, gradient + noise - 4], axis=-1)
    base[:83] *= 0.18
    base[388:] *= 0.18
    base[:, :52] *= 0.18
    base[:, 686:] *= 0.18
    base[:, 52:58] -= 10
    base[83:88] -= 11
    ifc = [(76, 118, 340, 354), (398, 118, 662, 354)]
    influence = np.zeros((height, width))
    checker = np.zeros((height, width))
    for index, (left, top, right, bottom) in enumerate(ifc):
        patch = (x >= left) & (x < right) & (y >= top) & (y < bottom)
        grid = (((x - left) // 37 + (y - top) // 36) % 2) == 0
        edge = np.maximum(0, np.sin((x - left - 8) / 21) * 0.22 + 0.78)
        checker[patch] = np.where(grid[patch], 1, -1) * (1.0 if index == 0 else 0.78) * edge[patch]
        influence[patch] = 1
    fixed_dust = ((x - 603) ** 2 + (y - 245) ** 2 < 5 ** 2) | ((x - 113) ** 2 + (y - 268) ** 2 < 3 ** 2)
    fine_line = (x > 439) & (x < 447) & (y >= 156) & (y < 328)

    def picture(array):
        image = Image.fromarray(np.clip(array, 0, 255).astype(np.uint8))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((46, 75, 693, 393), radius=12, outline="#8f9386", width=2)
        draw.text((53, 42), "DISPLAY LAB   /   EP-021", fill="#bbcab5", font=ImageFont.load_default(size=18))
        draw.text((53, 415), "SYNTHETIC TEST CAPTURE", fill="#abb49d", font=ImageFont.load_default(size=15))
        draw.line((578, 429, 652, 429), fill="#c4cbba", width=3)
        draw.text((654, 421), "10 mm", fill="#abb49d", font=ImageFont.load_default(size=14))
        return image

    white = picture(base)
    captures = []
    for pattern, polarity in (("Checks A", 1), ("Checks B", -1)):
        for wait, amount in [(120, 22), (240, 12), (400, 6), (650, 2)]:
            flicker = rng.normal(0, 0.7, (height, width))
            changed = polarity * amount * checker + influence * (1.3 + flicker)
            changed[fixed_dust] += 13
            changed[fine_line] += polarity * (amount * 0.75)
            captures.append((picture(base - changed[:, :, np.newaxis]), f"{pattern[-1]}-{wait:03d}ms.png",
                             {"wait": wait, "trial": 1, "pattern": pattern}))
    zones = [{"name": "Left field", "origin": [76, 118], "width": 264, "height": 236},
             {"name": "Right field", "origin": [398, 118], "width": 264, "height": 236}]
    return white, captures, zones


def create(library):
    reference, captures, zones = generate()
    return library.create("EP-021 · Synthetic refresh sequence", reference, "settled-white.png",
                          synthetic=True, initial=captures, zones=zones)
