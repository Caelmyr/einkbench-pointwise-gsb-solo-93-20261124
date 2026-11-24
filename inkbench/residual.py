"""Compute camera-space luminance residuals against a settled white capture."""

from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw

from . import frame


def pixels(path, *, color=False):
    with Image.open(path) as photo:
        return np.array(photo.convert("RGB" if color else "L"))


def image_delta(reference, capture):
    return reference.astype(np.int16) - capture.astype(np.int16)


def zones_for(record, settings):
    if settings["zones"]:
        return settings["zones"]
    return [{"name": "Full image", "origin": [0, 0], "width": record["width"], "height": record["height"]}]


def crop(values, zone):
    x, y = zone["origin"]
    return values[y:y + zone["height"], x:x + zone["width"]]


def statistics(residual, limit):
    magnitude = np.abs(residual)
    return {
        "mean": round(float(np.mean(residual)), 3),
        "p95": round(float(np.percentile(magnitude, 95)), 3),
        "dark_share": round(float(np.mean(residual >= limit)) * 100, 3),
        "bright_share": round(float(np.mean(residual <= -limit)) * 100, 3),
    }


def measure(record, settings, library, all_frames=False):
    selected = settings["capture"]
    reference_path, _ = library.paths(record, None)
    reference = pixels(reference_path)
    zones = zones_for(record, settings)
    results = []
    for shot in record["frames"]:
        if not all_frames and selected != shot["id"]:
            continue
        _, path = library.paths(record, shot["id"])
        delta = image_delta(reference, pixels(path))
        results.append({**shot, "zones": [
            {"name": zone["name"], **statistics(crop(delta, zone), settings["limit"])}
            for zone in zones
        ]})
    return sorted(results, key=lambda row: (row["wait"], row["pattern"], row["trial"]))


def overlay(reference_path, source_path, record, settings):
    source = pixels(source_path, color=True)
    delta = image_delta(pixels(reference_path), pixels(source_path))
    intensity = np.clip(np.abs(delta) * settings["map_gain"] / 120, 0, 0.92)
    intensity[np.abs(delta) < settings["limit"]] = 0
    mask = np.zeros(delta.shape, dtype=bool)
    for zone in zones_for(record, settings):
        crop(mask, zone)[:] = True
    amount = (intensity * mask)[:, :, np.newaxis]
    dark = np.array([250, 110, 40])
    bright = np.array([35, 151, 229])
    marker = np.where((delta >= 0)[:, :, np.newaxis], dark, bright)
    output = Image.fromarray((source * (1 - amount) + marker * amount).astype(np.uint8))
    painter = ImageDraw.Draw(output)
    for zone in settings["zones"]:
        x, y = zone["origin"]
        painter.rectangle((x, y, x + zone["width"] - 1, y + zone["height"] - 1), outline="#26544d", width=2)
    return BytesIO(frame.encode(output))


def probe(reference_path, source_path, xy):
    x, y = xy
    with Image.open(reference_path) as reference, Image.open(source_path) as current:
        base = reference.getpixel((x, y))
        source = current.getpixel((x, y))
        baseline = reference.crop((x, y, x + 1, y + 1)).convert("L").getpixel((0, 0))
        observed = current.crop((x, y, x + 1, y + 1)).convert("L").getpixel((0, 0))
    return {"point": xy, "reference_rgb": base, "capture_rgb": source, "residual": baseline - observed}
