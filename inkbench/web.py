"""Serve the inspection desk and its camera-space download endpoints."""

from pathlib import Path

from flask import Blueprint, jsonify, render_template, request, send_file

from image_lab.validation import Invalid

from . import demo, frame, model, output, pairing, residual
from .store import Library


def upload_photo(field):
    photo = request.files.get(field)
    if not photo or not photo.filename:
        raise Invalid("Choose an opaque PNG or JPEG photo.")
    image = frame.decode(photo.stream.read(model.MAX_UPLOAD + 1))
    return image, model.text(Path(photo.filename).name, "capture.png")


def body():
    return model.document(request.get_json(silent=True))


def install(app, root):
    library = Library(root, app.extensions["store"])
    desk = Blueprint("ink", __name__, url_prefix="/ink")

    def picture_data(batch_id):
        report_id = request.args.get("report")
        return library.report(batch_id, report_id)["batch"] if report_id else library.batch(batch_id)

    def image_download(content, name, download=True):
        return send_file(content, mimetype="image/png", download_name=name, as_attachment=download, max_age=0)

    @app.get("/")
    def home():
        return render_template("inkbench.html", patterns=model.PATTERNS)

    @desk.get("/health")
    def health():
        return jsonify(status="ready", service="inkbench")

    @desk.get("/batches")
    def batches():
        return jsonify(library.list())

    @desk.post("/demo")
    def create_demo():
        return jsonify(demo.create(library)), 201

    @desk.post("/batches")
    def create():
        photo, name = upload_photo("reference")
        title = model.text(request.form.get("title"), Path(name).stem)
        return jsonify(library.create(title, photo, name)), 201

    @desk.post("/prepared")
    def prepared():
        data = body()
        project = model.text(data.get("project"))
        result = model.text(data.get("result"))
        preparation = app.extensions["results"]
        meta = preparation.metadata(project, result)
        if meta["stale"]:
            raise Invalid("Run photo preparation again before using the result.")
        source = preparation.image_path(project, "image", result)
        photo = frame.decode(source.read_bytes())
        return jsonify(library.create(model.text(meta.get("name"), "Prepared reference"), photo, "prepared-reference.png",
                                      source={"project": project, "result": result})), 201

    @desk.get("/batches/<batch_id>")
    def open_batch(batch_id):
        return jsonify(library.batch(batch_id))

    @desk.post("/batches/<batch_id>/captures")
    def capture(batch_id):
        photo, name = upload_photo("capture")
        revision = model.number(request.form.get("revision"), 0, 10**9, "Batch revision", True)
        return jsonify(library.append(batch_id, revision, photo, name, request.form)), 201

    def pair_paths(record, settings):
        chosen = settings["pair"]
        if chosen is None:
            raise Invalid("Choose the two opposite-pattern photos to compare.")
        reference_path, _ = library.paths(record, None)
        _, first = library.paths(record, chosen["first"])
        _, second = library.paths(record, chosen["second"])
        return reference_path, first, second

    @desk.get("/batches/<batch_id>/reference.png")
    def reference(batch_id):
        record = picture_data(batch_id)
        path, _ = library.paths(record, None)
        return image_download(path, "reference.png", "download" in request.args)

    @desk.get("/batches/<batch_id>/captures/<capture_id>.png")
    def original(batch_id, capture_id):
        record = picture_data(batch_id)
        _, path = library.paths(record, capture_id)
        return image_download(path, "capture.png", "download" in request.args)

    @desk.put("/batches/<batch_id>/settings")
    def save(batch_id):
        data = body()
        return jsonify(library.save(batch_id, data.get("revision"), data.get("settings", {})))

    @desk.post("/batches/<batch_id>/measure")
    def measure(batch_id):
        record = picture_data(batch_id)
        settings = model.settings(record, body().get("settings", {}))
        return jsonify(residual.measure(record, settings, library, all_frames=True))

    @desk.post("/batches/<batch_id>/pair/measure")
    def pair_measure(batch_id):
        record = picture_data(batch_id)
        settings = model.settings(record, body().get("settings", {}))
        reference_path, first_path, second_path = pair_paths(record, settings)
        region = pairing.region_for(record, settings)
        result = pairing.analyse(residual.pixels(reference_path), residual.pixels(first_path),
                                 residual.pixels(second_path), settings["limit"], region)
        return jsonify(pairing.summary(result))

    @desk.post("/batches/<batch_id>/pair/map")
    def pair_map(batch_id):
        record = picture_data(batch_id)
        settings = model.settings(record, body().get("settings", {}))
        reference_path, first_path, second_path = pair_paths(record, settings)
        return image_download(pairing.overlay(reference_path, first_path, second_path, record, settings),
                              "pair-residual.png", False)

    @desk.post("/batches/<batch_id>/pair/point")
    def pair_point(batch_id):
        record = picture_data(batch_id)
        change = body()
        settings = model.settings(record, {"zones": change.get("zones", []),
                                           "limit": change.get("limit", 8),
                                           "pair": change.get("pair")})
        reference_path, first_path, second_path = pair_paths(record, settings)
        point = model.point(change.get("point"), record["width"], record["height"])
        return jsonify(pairing.probe(reference_path, first_path, second_path, point,
                                     settings["limit"], pairing.region_for(record, settings)))

    @desk.post("/batches/<batch_id>/map")
    def map_image(batch_id):
        record = picture_data(batch_id)
        settings = model.settings(record, body().get("settings", {}))
        source, capture_path = library.paths(record, settings["capture"])
        if capture_path is None:
            raise Invalid("Choose a capture to inspect.")
        return image_download(residual.overlay(source, capture_path, record, settings), "residual.png", False)

    @desk.post("/batches/<batch_id>/point")
    def point_readout(batch_id):
        record = picture_data(batch_id)
        change = body()
        reference_path, source = library.paths(record, change.get("capture"))
        if source is None:
            raise Invalid("Choose a capture before probing.")
        point = model.point(change.get("point"), record["width"], record["height"])
        return jsonify(residual.probe(reference_path, source, point))

    @desk.post("/batches/<batch_id>/reports")
    def retain(batch_id):
        data = body()
        return jsonify(library.retain(batch_id, data.get("revision"), data.get("settings", {}),
                                      model.text(data.get("name"), "Refresh inspection"))), 201

    @desk.get("/batches/<batch_id>/reports/<report_id>")
    def report(batch_id, report_id):
        return jsonify(library.report(batch_id, report_id))

    @desk.get("/batches/<batch_id>/reports/<report_id>/measurements.csv")
    def csv(batch_id, report_id):
        record = library.report(batch_id, report_id)["batch"]
        return send_file(output.table(record, library), mimetype="text/csv", as_attachment=True,
                         download_name="residual-measurements.csv")

    @desk.get("/batches/<batch_id>/reports/<report_id>/map.png")
    def archived_map(batch_id, report_id):
        record = library.report(batch_id, report_id)["batch"]
        settings = record["settings"]
        source, capture_path = library.paths(record, settings["capture"])
        return image_download(residual.overlay(source, capture_path, record, settings), "residual-map.png")

    app.register_blueprint(desk)
