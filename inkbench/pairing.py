"""Find checker ghosting that reverses between a pair of cleared-to-white photos.

A single capture shows a signed residual against the settled white reference,
but a stain that is dark in both photos of an opposite-pattern pair cannot be
told apart from checker ghosting until the two residuals are compared.  Where
the first photo is darker than white the opposite pattern must be brighter at
the same pixel: the anti-phase component ``(first - second) / 2`` isolates the
checker term, and a shared darkening cancels out of it.

A retained patch needs one pixel that clears the user's residual threshold (so
the pattern really is present there), but its edges may be faint.  Runs of a
few anti-phase pixels join the patch even when they never reach the threshold,
which is what keeps a square edge that faded in one photo but still reads in
the other.  Lone dots, and patches whose every pixel is only as strong as the
blank noise, are left out.
"""

from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from . import frame
from .residual import pixels, zones_for

CONNECTIVITY = np.ones((3, 3), dtype=bool)
MIN_AREA = 16
MIN_RUN = 4


def noise_sigma(delta):
    """Robust per-pixel noise of a signed residual from adjacent differences."""
    sample = np.concatenate((
        np.abs(np.diff(delta, axis=0)).ravel(),
        np.abs(np.diff(delta, axis=1)).ravel(),
    )).astype(np.float32)
    if not sample.size:
        return 0.0
    return float(np.median(sample)) / (0.6745 * np.sqrt(2))


def soft_sigma(delta):
    """Noise of a lightly smoothed residual, used to follow faint edges."""
    return noise_sigma(ndimage.gaussian_filter(delta.astype(np.float32), 1.0, mode="nearest"))


def thresholds(limit, sigma):
    """Faint floor for an edge stoppage and the anchor a patch must reach.

    ``limit`` is the user's residual threshold and remains the anchor, but the
    faint continuation of a square edge only has to clear the measured noise
    and a small fraction of that threshold.  Both floors rise with the noise,
    so blank white never fills with random speckle just because the threshold
    was set below what the camera can resolve.
    """
    faint = max(1.0, 1.5 * sigma, 0.3 * limit)
    anchor = max(float(limit), 3.0 * sigma, faint + 1.0)
    return faint, anchor


def analyse(reference, first, second, limit, region=None):
    delta_first = reference.astype(np.int16) - first.astype(np.int16)
    delta_second = reference.astype(np.int16) - second.astype(np.int16)
    sigma = max(noise_sigma(delta_first), noise_sigma(delta_second))
    faint, anchor = thresholds(limit, sigma)
    # Follow faint edges on the anti-phase component itself: subtracting the
    # two photos cancels their shared shading, so no photo's own gradient can
    # pass for a square.  Measured after smoothing so a faint edge is not
    # lost to the pixel noise of either photo.
    faint = max(faint, 1.5 * soft_sigma(delta_first - delta_second))

    a = delta_first.astype(np.float32)
    b = delta_second.astype(np.float32)
    lower = np.minimum(np.abs(a), np.abs(b))
    upper = np.maximum(np.abs(a), np.abs(b))

    # Opposing signs relative to white are the whole test: a stain dark in
    # both photos fails it, and so does a location barely above blank noise.
    candidates = ((a * b) < 0) & (lower >= faint)
    anchors = candidates & (upper >= anchor)
    if region is not None:
        candidates &= region
        anchors &= region

    neighbours = (ndimage.convolve(candidates.astype(np.uint8), CONNECTIVITY,
                                   mode="constant") - candidates.astype(np.uint8))
    run = (ndimage.binary_opening(candidates, structure=np.ones((1, MIN_RUN), dtype=bool))
           | ndimage.binary_opening(candidates, structure=np.ones((MIN_RUN, 1), dtype=bool)))
    support = anchors | (candidates & (neighbours >= 2)) | run

    # Bridge one-pixel gaps between near neighbours, but label the grown mask
    # and keep only support pixels: a stain that is dark in both photos never
    # becomes support, so an edge cannot paint across it just by enclosure.
    grown = ndimage.binary_dilation(support, structure=CONNECTIVITY)
    labels, count = ndimage.label(grown, structure=CONNECTIVITY)
    area = np.bincount(labels[candidates], minlength=count + 1)
    anchored = np.bincount(labels[anchors], minlength=count + 1)
    runs = np.bincount(labels[run], minlength=count + 1)
    keep = ((anchored > 0) & (area >= MIN_AREA)) | (runs >= MIN_RUN)
    keep[0] = False
    ghost = support & keep[labels]

    anti = (a - b) / 2.0
    common = (a + b) / 2.0
    common -= np.median(common)
    return {
        "ghost": ghost, "candidates": candidates, "anchors": anchors,
        "first_darker": ghost & (anti > 0),
        "second_darker": ghost & (anti < 0),
        "anti": anti, "common": common,
        "sigma": sigma, "faint": faint, "anchor": anchor,
        "delta_first": delta_first, "delta_second": delta_second,
        "patches": int(keep.sum()),
    }


def region_for(record, settings):
    mask = np.zeros((record["height"], record["width"]), dtype=bool)
    for zone in zones_for(record, settings):
        x, y = zone["origin"]
        mask[y:y + zone["height"], x:x + zone["width"]] = True
    return mask


def summary(result):
    ghost = result["ghost"]
    return {
        "ghost_pixels": int(ghost.sum()),
        "ghost_share": round(100 * float(ghost.mean()), 3),
        "first_darker": int(result["first_darker"].sum()),
        "second_darker": int(result["second_darker"].sum()),
        "patches": result["patches"],
        "noise": round(float(result["sigma"]), 2),
        "faint_threshold": round(float(result["faint"]), 2),
        "anchor_threshold": round(float(result["anchor"]), 2),
    }


def paint(anti, ghost, base, anchor, gain):
    strength = np.clip(np.abs(anti) / max(anchor, 1.0), 0, 1.5) / 1.5
    intensity = np.where(ghost, np.clip((0.18 + 0.72 * strength) * gain / 5, 0, 0.92), 0)
    warm = np.array([250, 110, 40])
    cool = np.array([35, 151, 229])
    marker = np.where((anti > 0)[:, :, np.newaxis], warm, cool)
    return (base * (1 - intensity[:, :, np.newaxis]) + marker * intensity[:, :, np.newaxis])


def overlay(reference_path, first_path, second_path, record, settings):
    first = pixels(first_path)
    second = pixels(second_path)
    result = analyse(pixels(reference_path), first, second, settings["limit"],
                     region_for(record, settings))
    base = (pixels(first_path, color=True).astype(np.float32)
            + pixels(second_path, color=True).astype(np.float32)) / 2
    output = Image.fromarray(paint(result["anti"], result["ghost"], base,
                                   result["anchor"], settings["map_gain"]).astype(np.uint8))
    painter = ImageDraw.Draw(output)
    for zone in settings["zones"]:
        x, y = zone["origin"]
        painter.rectangle((x, y, x + zone["width"] - 1, y + zone["height"] - 1),
                          outline="#26544d", width=2)
    return BytesIO(frame.encode(output))


def probe(reference_path, first_path, second_path, xy, limit, region=None):
    x, y = xy
    reference = pixels(reference_path)
    first = pixels(first_path)
    second = pixels(second_path)
    result = analyse(reference, first, second, limit, region)
    with Image.open(reference_path) as white, \
            Image.open(first_path) as before, Image.open(second_path) as after:
        reference_rgb = list(white.convert("RGB").getpixel((x, y)))
        first_rgb = list(before.convert("RGB").getpixel((x, y)))
        second_rgb = list(after.convert("RGB").getpixel((x, y)))
    identified = bool(result["ghost"][y, x])
    stain = bool(np.abs(result["common"][y, x]) >= result["anchor"])
    faint = bool(min(abs(result["delta_first"][y, x]), abs(result["delta_second"][y, x])) < result["faint"])
    return {
        "point": [x, y],
        "reference_rgb": reference_rgb,
        "reference_level": int(reference[y, x]),
        "first_rgb": first_rgb,
        "first_level": int(first[y, x]),
        "first_residual": int(result["delta_first"][y, x]),
        "second_rgb": second_rgb,
        "second_level": int(second[y, x]),
        "second_residual": int(result["delta_second"][y, x]),
        "anti": round(float(result["anti"][y, x]), 1),
        "common": round(float(result["common"][y, x]), 1),
        "reversed": bool(result["delta_first"][y, x] * result["delta_second"][y, x] < 0),
        "identified": identified,
        "dark_in_both": stain,
        "below_faint": faint,
        "faint_threshold": round(float(result["faint"]), 2),
        "anchor_threshold": round(float(result["anchor"]), 2),
    }
