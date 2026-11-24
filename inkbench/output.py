"""Export the archived capture readings without changing coordinates."""

import csv
from io import BytesIO, StringIO

from . import residual


def table(record, library):
    content = StringIO()
    writer = csv.writer(content)
    writer.writerow(["capture_id", "original_file", "wait_ms", "trial", "previous_pattern", "inspection_zone",
                     "signed_mean_dn", "absolute_p95_dn", "dark_area_percent", "bright_area_percent"])
    for shot in residual.measure(record, record["settings"], library, all_frames=True):
        for zone in shot["zones"]:
            name = zone["name"]
            if name.startswith(("=", "+", "-", "@", "\t", "\r")):
                name = "'" + name
            filename = shot["filename"]
            if filename.startswith(("=", "+", "-", "@", "\t", "\r")):
                filename = "'" + filename
            writer.writerow([shot["id"], filename, shot["wait"], shot["trial"], shot["pattern"], name, zone["mean"],
                             zone["p95"], zone["dark_share"], zone["bright_share"]])
    return BytesIO(content.getvalue().encode("utf-8"))
