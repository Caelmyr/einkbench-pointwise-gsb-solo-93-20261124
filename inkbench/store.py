"""Store original pixels, reusable inspection settings and immutable captures."""

from copy import deepcopy
from pathlib import Path
from threading import RLock
from uuid import uuid4

from image_lab.validation import Conflict, Invalid

from . import frame, model


class Library:
    def __init__(self, root, storage):
        self.root = Path(root)
        self.read = storage.read
        self.write = storage.write
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()

    @staticmethod
    def key(value):
        if not isinstance(value, str) or len(value) != 32 or any(c not in "0123456789abcdef" for c in value):
            raise Invalid("That batch or report does not exist.")
        return value

    def directory(self, key):
        return self.root / self.key(key)

    def batch(self, key):
        entry = self.directory(key) / "batch.json"
        if not entry.is_file():
            raise Invalid("That batch does not exist.")
        return self.read(entry)

    def list(self):
        return [self.read(path) for path in sorted(self.root.glob("*/batch.json"),
                                                    key=lambda entry: entry.stat().st_mtime, reverse=True)]

    def create(self, title, image, filename, source=None, synthetic=False, initial=(), zones=()):
        key = uuid4().hex
        folder = self.directory(key)
        folder.mkdir()
        width, height = image.size
        record = {
            "id": key, "title": title, "width": width, "height": height,
            "reference_name": filename, "prepared_source": source,
            "synthetic": synthetic, "revision": 0, "frames": [], "reports": [],
        }
        record["settings"] = model.settings(record, {"zones": list(zones)})
        (folder / "reference.png").write_bytes(frame.encode(image))
        for picture, label, metadata in initial:
            self.add_frame(record, picture, label, metadata)
        if record["frames"]:
            record["settings"]["capture"] = record["frames"][0]["id"]
        self.write(folder / "batch.json", record)
        return record

    def add_frame(self, record, image, filename, metadata):
        if image.size != (record["width"], record["height"]):
            raise Invalid("The capture must have the same pixel dimensions as the reference.")
        if len(record["frames"]) >= model.MAX_FRAMES:
            raise Invalid("A batch can contain at most sixteen captures.")
        shot = {"id": uuid4().hex, "filename": filename, **model.timing(metadata)}
        (self.directory(record["id"]) / f"{shot['id']}.png").write_bytes(frame.encode(image))
        record["frames"].append(shot)
        return shot

    @staticmethod
    def check_revision(record, revision):
        if revision != record["revision"]:
            raise Conflict("This batch changed. Reopen it before saving.")

    def commit(self, record):
        record["revision"] += 1
        self.write(self.directory(record["id"]) / "batch.json", record)

    def append(self, key, revision, image, filename, metadata):
        with self.lock:
            record = self.batch(key)
            self.check_revision(record, revision)
            shot = self.add_frame(record, image, filename, metadata)
            record["settings"]["capture"] = shot["id"]
            self.commit(record)
            return record

    def save(self, key, revision, settings):
        with self.lock:
            record = self.batch(key)
            self.check_revision(record, revision)
            record["settings"] = model.settings(record, settings)
            self.commit(record)
            return record

    def paths(self, record, capture):
        folder = self.directory(record["id"])
        reference = folder / "reference.png"
        if not capture:
            return reference, None
        shot = model.find_frame(record, capture)
        return reference, folder / f"{shot['id']}.png"

    def retain(self, key, revision, value, name):
        with self.lock:
            record = self.batch(key)
            self.check_revision(record, revision)
            settings = model.settings(record, value)
            if settings["capture"] is None:
                raise Invalid("Select a capture before saving a report.")
            report_id = uuid4().hex
            snapshot = deepcopy(record)
            snapshot.pop("reports")
            snapshot["settings"] = settings
            report = {"id": report_id, "name": name}
            self.write(self.directory(key) / f"report-{report_id}.json", {**report, "batch": snapshot})
            record["reports"].append(report)
            record["settings"] = settings
            self.commit(record)
            return record

    def report(self, key, report_id):
        path = self.directory(key) / f"report-{self.key(report_id)}.json"
        if not path.is_file():
            raise Invalid("That report does not exist.")
        return self.read(path)
