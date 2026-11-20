#!/usr/bin/env python3
"""Typesets the recorded senate transcript as an animated GIF (needs Pillow; fonts come from macOS).

    python3 scripts/demo/senate_gif.py   ->   docs/assets/demo/senate.gif

The words are the recorded replies in docs/assets/demo/senate-transcript.json; only the layout is drawn here.
"""
import json, pathlib, textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[2]
DATA = json.loads((ROOT / "docs/assets/demo/senate-transcript.json").read_text())
W, H = 1200, 540
BG, PANEL, BORDER, TEXT, MUTED, GOLD = "#090d16", "#0f1526", "#1f2740", "#e6e8f2", "#9aa2c0", "#c9a45c"

def font(names, size):
    for name in names:
        try: return ImageFont.truetype(name, size)
        except OSError: pass
    return ImageFont.load_default()

SERIF = lambda s: font(["/System/Library/Fonts/Supplemental/Georgia.ttf", "Georgia.ttf"], s)
SANS = lambda s: font(["/System/Library/Fonts/Helvetica.ttc", "Arial.ttf"], s)
MONO = lambda s: font(["/System/Library/Fonts/Menlo.ttc", "Menlo.ttc"], s)

def wrap(draw, text, fnt, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=fnt) <= width: line = trial
        else: lines.append(line); line = word
    return lines + [line]

def frame(motion_index, shown, typing=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.text((40, 26), "CONSESSUS", font=SERIF(26), fill="#e9e2d0")
    d.text((218, 34), f"room {DATA['room']}  ·  four apps, one folder  ·  recorded replies", font=SANS(16), fill=MUTED)
    d.line((40, 68, W - 40, 68), fill=GOLD, width=1)
    motion = DATA["motions"][motion_index]
    d.rounded_rectangle((40, 84, W - 40, 168), 10, fill=PANEL, outline=BORDER)
    d.text((60, 96), f"$ consessus room send {DATA['room']} --all", font=MONO(15), fill=MUTED)
    for i, line in enumerate(wrap(d, motion["text"].replace("`", ""), SANS(19), W - 130)[:2]):
        d.text((60, 120 + i * 23), line, font=SANS(19), fill=TEXT)
    col = (W - 80 - 3 * 16) // 4
    for i, seat in enumerate(DATA["seats"]):
        x0 = 40 + i * (col + 16)
        d.rounded_rectangle((x0, 188, x0 + col, H - 40), 10, fill=PANEL, outline=BORDER)
        d.rectangle((x0, 188, x0 + col, 192), fill=seat["tint"])
        d.text((x0 + 16, 206), seat["office"], font=SERIF(22), fill=seat["tint"])
        d.text((x0 + 16, 236), seat["app"], font=SANS(15), fill=MUTED)
        d.line((x0 + 16, 264, x0 + col - 16, 264), fill=BORDER, width=1)
        if seat["id"] in shown:
            for n, line in enumerate(wrap(d, motion["replies"][seat["id"]], SANS(17), col - 32)):
                d.text((x0 + 16, 280 + n * 23), line, font=SANS(17), fill=TEXT)
        elif seat["id"] == typing:
            d.text((x0 + 16, 280), "· · ·", font=SANS(22), fill=seat["tint"])
    d.text((40, H - 28), f"motion {motion_index + 1} of {len(DATA['motions'])}", font=SANS(13), fill=MUTED)
    return img

frames, times = [], []
for m in range(len(DATA["motions"])):
    shown = []
    frames.append(frame(m, shown)); times.append(1600)
    for seat in DATA["seats"]:
        frames.append(frame(m, shown, typing=seat["id"])); times.append(450)
        shown = shown + [seat["id"]]
        frames.append(frame(m, shown)); times.append(1500)
    times[-1] = 3200
out = ROOT / "docs/assets/demo/senate.gif"
palette = [f.quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
palette[0].save(out, save_all=True, append_images=palette[1:], duration=times, loop=0, optimize=True, disposal=1)
frames[len(frames) // 4 * 3 - 1].save(ROOT / "docs/assets/demo/senate-still.png", optimize=True)
print(out, out.stat().st_size, "bytes,", len(frames), "frames,", sum(times) / 1000, "s")
