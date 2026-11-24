const el = id => document.getElementById(id);
const state = {batch: null, settings: null, report: null, view: "capture", mode: "", corner: null, point: null,
  imageObject: null, measurements: [], imageSerial: 0, measurementSerial: 0, pairStats: null};

function notice(text, error = false) {
  el("status").textContent = text;
  el("status").classList.toggle("error", error);
}

function handle(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (error) { notice(error.message || "The request failed.", true); }
  };
}

async function request(path, method = "GET", value) {
  const options = {method};
  if (value instanceof FormData) options.body = value;
  else if (value !== undefined) {
    options.headers = {"Content-Type": "application/json"};
    options.body = JSON.stringify(value);
  }
  const response = await fetch("/ink" + path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "The inspection could not be loaded.");
  }
  return response.headers.get("Content-Type")?.includes("application/json") ? response.json() : response.blob();
}

const base = () => "/batches/" + state.batch.id;
const target = () => state.report?.batch ?? state.batch;
const suffix = () => state.report ? "?report=" + state.report.id : "";
const active = () => target().frames.find(shot => shot.id === state.settings.capture);
const paired = () => Boolean(state.settings.pair?.first && state.settings.pair?.second);
function pairShot(field) {
  return target().frames.find(shot => shot.id === state.settings.pair?.[field]);
}
function pairLabel(shot) {
  return shot ? frameLabel(shot) : "Not chosen";
}
function options(select, values, current, blank) {
  select.replaceChildren(new Option(blank, ""));
  for (const [key, label] of values) select.add(new Option(label, key));
  select.value = current || "";
}
function frameLabel(shot) {
  return `${shot.wait} ms · ${shot.pattern} · trial ${shot.trial}`;
}

async function chooseBatch(batch) {
  state.batch = batch;
  state.report = null;
  state.settings = structuredClone(batch.settings);
  state.mode = "";
  state.corner = state.point = null;
  state.pairStats = null;
  el("probeRead").textContent = "";
  el("pairRead").textContent = "";
  localStorage.setItem("inkbench-batch", batch.id);
  await refreshList();
  await render();
  notice("Opened " + batch.title + ".");
}

async function refreshList() {
  const batches = await request("/batches");
  options(el("batches"), batches.map(batch => [batch.id, batch.title]), state.batch?.id, "Choose a batch");
  return batches;
}

function displayControls() {
  const record = target();
  const shot = active();
  el("desk").hidden = false;
  el("title").textContent = record.title;
  el("kind").textContent = state.report ? `Saved report · ${state.report.name}` :
    record.synthetic ? "Synthetic practice sequence" : record.prepared_source ? "Prepared reference" : "Imported reference";
  el("capture").disabled = state.report !== null;
  options(el("capture"), record.frames.map(shot => [shot.id, frameLabel(shot)]), shot?.id, "Choose a capture");
  el("cameraMeta").textContent = shot ? `${shot.filename} · ${record.width} × ${record.height} px` :
    `${record.reference_name} · ${record.width} × ${record.height} px`;
  el("limit").value = state.settings.limit;
  el("gain").value = state.settings.map_gain;
  el("delay").value = state.settings.delay;
  document.querySelectorAll(".edit").forEach(control => { control.disabled = state.report !== null; });
  el("retain").disabled ||= !shot;
  el("probe").disabled = !shot;
  const source = shot ? base() + "/captures/" + shot.id + ".png" : base() + "/reference.png";
  el("original").href = "/ink" + source + (state.report ? suffix() + "&download" : "?download");
  el("original").textContent = shot ? "Download capture" : "Download reference";
  options(el("reports"), state.batch.reports.map(report => [report.id, report.name]), state.report?.id, "Current setup");
  renderPair();
  el("reportLinks").hidden = state.report === null;
  if (state.report) {
    const path = "/ink" + base() + "/reports/" + state.report.id;
    el("csv").href = path + "/measurements.csv";
    el("map").href = path + "/map.png";
  }
  renderZones();
  renderMode();
}

function renderZones() {
  const entries = state.settings.zones.map((zone, index) => {
    const row = document.createElement("div");
    row.className = "zone-row";
    const name = document.createElement("input");
    name.value = zone.name;
    name.setAttribute("aria-label", `Zone ${index + 1} name`);
    name.title = `${zone.origin.join(", ")} · ${zone.width} × ${zone.height} px`;
    name.maxLength = 120;
    name.disabled = state.report !== null;
    name.onchange = handle(async () => {
      zone.name = name.value.trim() || `Zone ${index + 1}`;
      name.value = zone.name;
      drawMarks();
      await measure();
    });
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", "Remove " + zone.name);
    remove.disabled = name.disabled;
    remove.onclick = handle(async () => {
      state.settings.zones.splice(index, 1);
      renderZones();
      await inspect();
    });
    row.append(name, remove);
    return row;
  });
  if (!entries.length) entries.push(document.createTextNode("Measuring the full image"));
  el("zones").replaceChildren(...entries);
}

function renderPair() {
  const frames = target().frames;
  const pair = state.settings.pair;
  options(el("pairFirst"), frames.map(shot => [shot.id, frameLabel(shot)]), pair?.first, "Choose the first photo");
  options(el("pairSecond"), frames.map(shot => [shot.id, frameLabel(shot)]), pair?.second, "Choose the opposite photo");
  for (const control of [el("pairFirst"), el("pairSecond")]) control.disabled = state.report !== null;
  const stats = state.pairStats;
  el("pairStats").textContent = stats ?
    `${stats.ghost_pixels.toLocaleString()} px · ${stats.patches} patch${stats.patches === 1 ? "" : "es"} · noise ${stats.noise} DN` : "";
}

function renderMode() {
  el("board").classList.toggle("active", Boolean(state.mode) || state.view === "pair");
  el("mark").setAttribute("aria-pressed", state.mode === "zone");
  el("probe").setAttribute("aria-pressed", state.mode === "probe");
  const hint = state.mode === "zone"
    ? (state.corner ? "Select the opposite corner." : "Select the first corner.")
    : state.view === "pair" && paired()
      ? "Click any pixel in the pair view to read it in both originals."
      : state.mode === "probe" ? "Select a pixel in the image." : "Mark two corners to define an inspection zone.";
  el("modeHint").textContent = hint;
  drawMarks();
}

function drawMarks() {
  const {width, height} = target();
  const marks = state.settings.zones.map(zone => {
    const rectangle = document.createElement("div");
    rectangle.className = "zone-box";
    rectangle.style.left = 100 * zone.origin[0] / width + "%";
    rectangle.style.top = 100 * zone.origin[1] / height + "%";
    rectangle.style.width = 100 * zone.width / width + "%";
    rectangle.style.height = 100 * zone.height / height + "%";
    const title = document.createElement("span");
    title.textContent = zone.name;
    rectangle.append(title);
    return rectangle;
  });
  for (const point of [state.corner, state.point].filter(Boolean)) {
    const cursor = document.createElement("div");
    cursor.className = "pointer";
    cursor.style.left = 100 * (point[0] + 0.5) / width + "%";
    cursor.style.top = 100 * (point[1] + 0.5) / height + "%";
    marks.push(cursor);
  }
  el("marks").replaceChildren(...marks);
}

async function showImage() {
  const requested = ++state.imageSerial;
  const shot = active();
  const mode = !shot ? "reference" : state.view;
  if (mode === "pair" && !paired()) {
    state.pairStats = null;
    renderPair();
    notice("Choose the two opposite-pattern photos under Opposite pair.", true);
    return;
  }
  const url =
    mode === "pair" ? URL.createObjectURL(await request(base() + "/pair/map" + suffix(), "POST", {settings: state.settings})) :
    mode === "residual" ?
      URL.createObjectURL(await request(base() + "/map" + suffix(), "POST", {settings: state.settings})) :
      "/ink" + base() + (mode === "reference" ? "/reference.png" : "/captures/" + shot.id + ".png") + suffix();
  if (requested !== state.imageSerial) {
    if (mode === "residual" || mode === "pair") URL.revokeObjectURL(url);
    return;
  }
  if (state.imageObject) URL.revokeObjectURL(state.imageObject);
  state.imageObject = mode === "residual" || mode === "pair" ? url : null;
  el("image").src = url;
  for (const button of document.querySelectorAll("[data-view]")) {
    button.disabled = mode === "reference" && !shot && button.dataset.view !== "reference";
    button.setAttribute("aria-pressed", button.dataset.view === mode);
  }
  if (mode === "pair") await pairStats();
  drawMarks();
}

async function pairStats() {
  if (!paired()) return null;
  state.pairStats = await request(base() + "/pair/measure" + suffix(), "POST", {settings: state.settings});
  renderPair();
  return state.pairStats;
}

async function measure() {
  const requested = ++state.measurementSerial;
  const data = await request(base() + "/measure" + suffix(), "POST", {settings: state.settings});
  if (requested !== state.measurementSerial) return;
  state.measurements = data;
  showTable();
  showGraph();
}

function showTable() {
  const rows = [];
  for (const shot of state.measurements) {
    for (const zone of shot.zones) {
      const row = document.createElement("tr");
      row.classList.toggle("current", shot.id === state.settings.capture);
      const first = row.insertCell();
      const jump = document.createElement("button");
      jump.textContent = shot.wait + " ms";
      jump.disabled = state.report !== null;
      jump.onclick = handle(() => selectCapture(shot.id));
      first.append(jump);
      for (const value of [shot.pattern, shot.trial, zone.name, zone.mean, zone.p95, zone.dark_share + "%", zone.bright_share + "%"]) {
        row.insertCell().textContent = value;
      }
      rows.push(row);
    }
  }
  el("measurements").replaceChildren(...rows);
}

function showGraph() {
  const canvas = el("graph");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const groups = new Map();
  for (const shot of state.measurements) {
    shot.zones.forEach((zone, index) => {
      const key = JSON.stringify([shot.pattern, shot.trial, index]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({wait: shot.wait, value: zone.p95});
    });
  }
  const points = Array.from(groups.values()).flat();
  if (!points.length) {
    ctx.fillStyle = "#63776a";
    ctx.font = "14px system-ui";
    ctx.fillText("Add a capture to plot residual measurements.", 44, 60);
    return;
  }
  const maxDelay = Math.max(1, ...points.map(item => item.wait));
  const maxValue = Math.max(4, ...points.map(item => item.value));
  const px = delay => 47 + (canvas.width - 83) * delay / maxDelay;
  const py = value => 179 - 154 * value / maxValue;
  ctx.font = "13px system-ui";
  for (let division = 0; division <= 4; division++) {
    const value = maxValue * division / 4;
    ctx.strokeStyle = "#d6dfd4";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px(0), py(value));
    ctx.lineTo(px(maxDelay), py(value));
    ctx.stroke();
    ctx.fillStyle = "#45614d";
    ctx.fillText(value.toFixed(1), 5, py(value) + 4);
  }
  ctx.fillText("0 ms", px(0), 199);
  ctx.fillText(maxDelay + " ms", px(maxDelay) - 36, 199);
  const palette = ["#286e53", "#ad643d", "#547dad", "#8b648e", "#6e792f", "#4d555b"];
  Array.from(groups.values()).forEach((series, index) => {
    ctx.strokeStyle = ctx.fillStyle = palette[index % palette.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((item, point) => {
      if (point === 0) ctx.moveTo(px(item.wait), py(item.value));
      else ctx.lineTo(px(item.wait), py(item.value));
    });
    ctx.stroke();
    for (const item of series) {
      ctx.beginPath();
      ctx.arc(px(item.wait), py(item.value), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

async function inspect() { await Promise.all([showImage(), measure()]); }
async function render() { displayControls(); await inspect(); }

async function selectCapture(value) {
  state.settings.capture = value || null;
  el("probeRead").textContent = "";
  el("pairRead").textContent = "";
  state.point = null;
  displayControls();
  showTable();
  await showImage();
}

function pairReadout(point, result) {
  const format = rgb => rgb.join(", ");
  const direction = !result.reversed ? "same direction in both photos" :
    result.identified ? "reverses between the photos" :
    result.dark_in_both ? "dark in both" : result.below_faint ? "below blank noise" : "isolated, not painted";
  el("pairRead").innerHTML = "";
  const list = document.createElement("dl");
  const rows = [
    ["Pixel", point.join(", ")],
    ["First photo", `${format(result.first_rgb)} · L ${result.first_level} · ${result.first_residual > 0 ? "+" : ""}${result.first_residual} DN vs white`],
    ["Second photo", `${format(result.second_rgb)} · L ${result.second_level} · ${result.second_residual > 0 ? "+" : ""}${result.second_residual} DN vs white`],
    ["White", `${format(result.reference_rgb)} · L ${result.reference_level}`],
    ["Reading", `${result.anti > 0 ? "+" : ""}${result.anti} DN anti-phase · shared ${result.common > 0 ? "+" : ""}${result.common} DN · ${direction}${result.identified ? " · painted" : ""}`],
  ];
  for (const [term, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  el("pairRead").append(list);
}

async function pairProbe(point) {
  const result = await request(base() + "/pair/point" + suffix(), "POST",
    {pair: state.settings.pair, zones: state.settings.zones, limit: state.settings.limit, point});
  pairReadout(point, result);
}

el("image").onclick = handle(async event => {
  const pairView = state.view === "pair" && state.mode !== "zone";
  if (!state.mode && !pairView) return;
  const image = event.currentTarget.getBoundingClientRect();
  const {width, height} = target();
  const point = [
    Math.min(width - 1, Math.max(0, Math.floor((event.clientX - image.left) * width / image.width))),
    Math.min(height - 1, Math.max(0, Math.floor((event.clientY - image.top) * height / image.height))),
  ];
  if (pairView) {
    state.point = point;
    if (!paired()) throw new Error("Choose the two opposite-pattern photos first.");
    await pairProbe(point);
    drawMarks();
    return;
  }
  if (state.mode === "probe") {
    state.point = point;
    const source = active();
    const result = await request(base() + "/point" + suffix(), "POST", {capture: source.id, point});
    el("probeRead").textContent = `${point.join(", ")} · capture RGB ${result.capture_rgb.join(", ")} · reference RGB ${result.reference_rgb.join(", ")} · residual ${result.residual} DN`;
  } else if (state.corner) {
    const [x, y] = state.corner;
    const [px, py] = point;
    if (x === px || y === py) throw new Error("Choose a corner at least one pixel away on both axes.");
    const zones = state.settings.zones;
    zones.push({name: `Zone ${zones.length + 1}`, origin: [Math.min(x, px), Math.min(y, py)],
      width: Math.abs(x - px) + 1, height: Math.abs(y - py) + 1});
    state.corner = null;
    state.mode = "";
    renderZones();
    await inspect();
  } else state.corner = point;
  renderMode();
});

el("mark").onclick = handle(() => {
  if (state.settings.zones.length >= 8) throw new Error("Remove a zone before adding another.");
  state.mode = state.mode === "zone" ? "" : "zone";
  state.corner = null;
  renderMode();
});
for (const [field, select] of [["first", "pairFirst"], ["second", "pairSecond"]]) {
  el(select).onchange = handle(async event => {
    const first = field === "first" ? event.target.value : el("pairFirst").value;
    const second = field === "second" ? event.target.value : el("pairSecond").value;
    state.settings.pair = first && second ? {first, second} : null;
    if (first && first === second) {
      state.settings.pair = null;
      renderPair();
      throw new Error("Choose two different photos for the pair.");
    }
    state.pairStats = null;
    el("pairRead").textContent = "";
    renderPair();
    if (state.view === "pair") await showImage();
  });
}
el("probe").onclick = () => {
  state.mode = state.mode === "probe" ? "" : "probe";
  state.corner = null;
  renderMode();
};
el("capture").onchange = handle(event => selectCapture(event.target.value));
for (const [id, setting] of [["limit", "limit"], ["gain", "map_gain"], ["delay", "delay"]]) {
  el(id).onchange = handle(async event => {
    const value = event.currentTarget;
    if (!value.value || !value.checkValidity()) {
      value.value = state.settings[setting];
      throw new Error("Enter a number in the allowed range.");
    }
    state.settings[setting] = value.valueAsNumber;
    if (id === "limit") await inspect();
    if (id === "gain") await showImage();
  });
}
document.querySelectorAll("[data-view]").forEach(button => {
  button.onclick = handle(async () => {
    state.view = button.dataset.view;
    await showImage();
    renderMode();
  });
});
el("demo").onclick = handle(async () => {
  el("demo").disabled = true;
  try { await chooseBatch(await request("/demo", "POST")); }
  finally { el("demo").disabled = false; }
});
el("batches").onchange = handle(async event => {
  if (event.target.value) await chooseBatch(await request("/batches/" + event.target.value));
});
el("reports").onchange = handle(async event => {
  state.report = event.target.value ? await request(base() + "/reports/" + event.target.value) : null;
  state.settings = structuredClone(target().settings);
  state.corner = state.point = null;
  state.mode = "";
  state.pairStats = null;
  el("probeRead").textContent = "";
  el("pairRead").textContent = "";
  await render();
});
el("save").onclick = handle(async () => {
  state.batch = await request(base() + "/settings", "PUT", {revision: state.batch.revision, settings: state.settings});
  notice("Saved the active inspection setup.");
});

el("importReference").onclick = () => el("referenceDialog").showModal();
el("addCapture").onclick = () => {
  el("captureForm").elements.wait.value = state.settings.delay;
  el("captureDialog").showModal();
};
el("retain").onclick = () => el("reportDialog").showModal();
document.querySelectorAll(".cancel").forEach(button => {
  button.onclick = () => button.closest("dialog").close();
});
el("referenceForm").onsubmit = handle(async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const batch = await request("/batches", "POST", new FormData(form));
  form.reset();
  el("referenceDialog").close();
  await chooseBatch(batch);
});
el("captureForm").onsubmit = handle(async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  data.set("revision", state.batch.revision);
  state.batch = await request(base() + "/captures", "POST", data);
  state.settings.capture = state.batch.settings.capture;
  form.reset();
  el("captureDialog").close();
  await render();
  notice("Added the capture to the active batch.");
});
el("reportForm").onsubmit = handle(async event => {
  event.preventDefault();
  const form = event.currentTarget;
  state.batch = await request(base() + "/reports", "POST", {revision: state.batch.revision, settings: state.settings, name: form.elements.name.value});
  const report = state.batch.reports.at(-1);
  state.report = await request(base() + "/reports/" + report.id);
  state.settings = structuredClone(state.report.batch.settings);
  state.mode = "";
  state.corner = state.point = null;
  el("probeRead").textContent = "";
  el("reportDialog").close();
  await render();
  notice("Saved " + report.name + ".");
});

handle(async () => {
  const batches = await refreshList();
  if (!batches.length) return;
  const saved = localStorage.getItem("inkbench-batch");
  await chooseBatch(batches.find(item => item.id === saved) || batches[0]);
})();
