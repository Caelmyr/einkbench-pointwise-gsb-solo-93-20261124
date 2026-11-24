"""Validate the labels, timing and camera-space inspection regions."""

import math

from image_lab.validation import Invalid

MAX_UPLOAD = 14 * 1024 * 1024
MAX_PIXELS = 4_000_000
MAX_FRAMES = 16
PATTERNS = ("Checks A", "Checks B", "Full black", "Full white")


def document(value):
    if not isinstance(value, dict):
        raise Invalid("Expected an inspection settings object.")
    return value


def text(value, fallback=""):
    return str(value or fallback).strip()[:120]


def number(value, minimum, maximum, label, integral=False):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        raise Invalid(f"{label} must be a number.") from None
    if not math.isfinite(result) or result < minimum or result > maximum:
        raise Invalid(f"{label} must be between {minimum} and {maximum}.")
    if integral:
        if not result.is_integer():
            raise Invalid(f"{label} must be a whole number.")
        return int(result)
    return result


def timing(data):
    pattern = data.get("pattern")
    if pattern not in PATTERNS:
        raise Invalid("Choose the pattern that was shown before clearing to white.")
    return {
        "wait": number(data.get("wait"), 0, 60000, "Wait in milliseconds", True),
        "trial": number(data.get("trial", 1), 1, 100, "Trial", True),
        "pattern": pattern,
    }


def point(value, width, height):
    if not isinstance(value, list) or len(value) != 2:
        raise Invalid("Select a location on the capture.")
    return [number(value[0], 0, width - 1, "Column", True),
            number(value[1], 0, height - 1, "Row", True)]


def settings(record, value):
    data = document(value)
    raw = data.get("zones", [])
    if not isinstance(raw, list) or len(raw) > 8:
        raise Invalid("The inspection can contain up to eight zones.")
    width, height = record["width"], record["height"]
    zones = []
    for index, entry in enumerate(raw):
        zone = document(entry)
        x, y = point(zone.get("origin"), width, height)
        w = number(zone.get("width"), 2, width - x, "Zone width", True)
        h = number(zone.get("height"), 2, height - y, "Zone height", True)
        zones.append({
            "name": text(zone.get("name"), f"Zone {index + 1}"),
            "origin": [x, y], "width": w, "height": h,
        })
    source = data.get("capture")
    if source is not None:
        find_frame(record, source)
    return {
        "capture": source, "zones": zones,
        "limit": number(data.get("limit", 8), 1, 255, "Residual threshold"),
        "delay": number(data.get("delay", 400), 0, 60000, "Current wait setting", True),
        "map_gain": number(data.get("map_gain", 5), 1, 20, "Map contrast"),
    }


def find_frame(record, frame_id):
    for shot in record["frames"]:
        if shot["id"] == frame_id:
            return shot
    raise Invalid("That capture no longer belongs to this batch.")
