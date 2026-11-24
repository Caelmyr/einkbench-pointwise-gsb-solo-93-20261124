const el = id => document.getElementById(id);
const state = {batch: null, settings: null, report: null, view: "capture", mode: "", corner: null, point: null,
  imageObject: null, measurements: [], imageSerial: 0, measurementSerial: 0,
  recommendation: null, graphHits: []};
window.state = state;
const MAX_WAIT = 60000;

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
  el("probeRead").textContent = "";
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
  el("criticalBand").disabled = state.report !== null;
  if (state.report) el("adoptWait").disabled = true;
  el("retain").disabled ||= !shot;
  el("probe").disabled = !shot;
  const source = shot ? base() + "/captures/" + shot.id + ".png" : base() + "/reference.png";
  el("original").href = "/ink" + source + (state.report ? suffix() + "&download" : "?download");
  el("original").textContent = shot ? "Download capture" : "Download reference";
  options(el("reports"), state.batch.reports.map(report => [report.id, report.name]), state.report?.id, "Current setup");
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

function renderMode() {
  el("board").classList.toggle("active", Boolean(state.mode));
  el("mark").setAttribute("aria-pressed", state.mode === "zone");
  el("probe").setAttribute("aria-pressed", state.mode === "probe");
  const hint = state.mode === "zone"
    ? (state.corner ? "Select the opposite corner." : "Select the first corner.")
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
  const url = mode === "residual" ?
    URL.createObjectURL(await request(base() + "/map" + suffix(), "POST", {settings: state.settings})) :
    "/ink" + base() + (mode === "reference" ? "/reference.png" : "/captures/" + shot.id + ".png") + suffix();
  if (requested !== state.imageSerial) {
    if (mode === "residual") URL.revokeObjectURL(url);
    return;
  }
  if (state.imageObject) URL.revokeObjectURL(state.imageObject);
  state.imageObject = mode === "residual" ? url : null;
  el("image").src = url;
  for (const button of document.querySelectorAll("[data-view]")) {
    button.disabled = mode === "reference" && !shot && button.dataset.view !== "reference";
    button.setAttribute("aria-pressed", button.dataset.view === mode);
  }
  drawMarks();
}

async function measure() {
  const requested = ++state.measurementSerial;
  const data = await request(base() + "/measure" + suffix(), "POST", {settings: state.settings});
  if (requested !== state.measurementSerial) return;
  state.measurements = data;
  showTable();
  buildRecommendation();
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

/* ---- Next wait advisor ----------------------------------------------------
   Only real captures sharing the active capture's previous pattern and trial
   are considered. A P95 inside the critical band (limit ± band) is held without
   a verdict. Each zone's unresolved window is bracketed by the last definite
   over-limit photo and the first definite pass photo at a longer wait. */

function criticalHalfBand() {
  const input = el("criticalBand");
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0) return 1;
  return value;
}

function classifyPoint(p95, limit, band) {
  if (p95 > limit + band) return "over";
  if (p95 < limit - band) return "pass";
  return "hold";
}

function buildRecommendation() {
  const shot = active();
  state.recommendation = null;
  if (!shot) return;
  const limit = state.settings.limit;
  const band = criticalHalfBand();
  const pattern = shot.pattern;
  const trial = shot.trial;
  const usedWaits = new Set();
  const series = [];
  for (const row of state.measurements) {
    if (row.pattern !== pattern || row.trial !== trial) continue;
    usedWaits.add(row.wait);
    series.push(row);
  }
  series.sort((a, b) => a.wait - b.wait || a.id.localeCompare(b.id));
  const zoneCount = state.settings.zones.length || 1;
  const zones = [];
  for (let index = 0; index < zoneCount; index++) {
    const name = series[0]?.zones[index]?.name || state.settings.zones[index]?.name || `Zone ${index + 1}`;
    const points = series.map(row => ({
      wait: row.wait,
      id: row.id,
      p95: row.zones[index]?.p95,
      verdict: classifyPoint(row.zones[index]?.p95 ?? Infinity, limit, band),
    }));
    const over = points.filter(item => item.verdict === "over");
    const passes = points.filter(item => item.verdict === "pass");
    const lastOver = over.length ? over[over.length - 1] : null;
    let firstPass = null;
    if (lastOver) firstPass = passes.find(item => item.wait > lastOver.wait) || null;
    else firstPass = passes.length ? passes[0] : null;
    const entry = {index, name, points, lastOver, firstPass, bracket: null, reason: ""};
    if (!lastOver && !firstPass) {
      entry.reason = "还没有确实超限或确实过关的照片，证据还不够。";
    } else if (!lastOver) {
      entry.reason = `缺少确实超限的一端，只有 ${firstPass.wait} ms 起过关。`;
    } else if (!firstPass) {
      entry.reason = `缺少确实过关的一端，最后一次超限在 ${lastOver.wait} ms。`;
    } else {
      entry.bracket = {low: lastOver.wait, high: firstPass.wait,
        lowId: lastOver.id, highId: firstPass.id, width: firstPass.wait - lastOver.wait};
      entry.reason = `${lastOver.wait} ms 仍超限，${firstPass.wait} ms 已过关。`;
    }
    zones.push(entry);
  }
  const brackets = zones.filter(zone => zone.bracket);
  let pick = null;
  const actionable = brackets.filter(zone => {
    const {low, high} = zone.bracket;
    for (let wait = low + 1; wait < high; wait++) {
      if (!usedWaits.has(wait)) return true;
    }
    return false;
  });
  if (actionable.length) {
    const widest = Math.max(...actionable.map(zone => zone.bracket.width));
    const candidates = [];
    for (let wait = 0; wait <= MAX_WAIT; wait++) {
      if (usedWaits.has(wait)) continue;
      let covers = 0;
      let worstAfter = 0;
      for (const zone of actionable) {
        const {low, high} = zone.bracket;
        if (wait > low && wait < high) {
          covers++;
          worstAfter = Math.max(worstAfter, Math.max(wait - low, high - wait));
        } else {
          worstAfter = Math.max(worstAfter, zone.bracket.width);
        }
      }
      candidates.push({wait, covers, worstAfter});
    }
    candidates.sort((a, b) =>
      (a.worstAfter - b.worstAfter) ||
      (b.covers - a.covers) ||
      (Math.abs(a.wait - MAX_WAIT / 2) - Math.abs(b.wait - MAX_WAIT / 2)) ||
      (a.wait - b.wait));
    const best = candidates[0];
    pick = {
      wait: best.wait,
      covers: best.covers,
      zoneCount: actionable.length,
      widestBefore: widest,
      widestAfter: best.worstAfter,
      coveredZones: actionable.filter(zone => {
        const {low, high} = zone.bracket;
        return best.wait > low && best.wait < high;
      }).map(zone => zone.name),
    };
  }
  state.recommendation = {pattern, trial, limit, band, usedWaits: [...usedWaits].sort((a, b) => a - b), zones, pick};
}
window.buildRecommendation = buildRecommendation;

function renderAdvisor() {
  const advice = state.recommendation;
  const scope = el("advisorScope");
  const zoneBox = el("advisorZones");
  const pickBox = el("advisorPick");
  const adopt = el("adoptWait");
  scope.replaceChildren();
  zoneBox.replaceChildren();
  pickBox.textContent = "";
  adopt.disabled = true;
  const shot = active();
  if (!shot) {
    scope.textContent = "先选择一张实拍照片，推荐只沿用它的前态与轮次。";
    return;
  }
  if (!advice) return;
  scope.textContent = `同一前态 ${advice.pattern} · 同一轮 trial ${advice.trial} · 阈值 ${advice.limit} DN · 临界带 ±${advice.band} DN · 已拍等待 ${advice.usedWaits.length ? advice.usedWaits.join("、") + " ms" : "无"}`;
  for (const zone of advice.zones) {
    const card = document.createElement("div");
    card.className = "advisor-zone" + (zone.bracket ? "" : " unsupported");
    const head = document.createElement("div");
    head.className = "zone-head";
    const name = document.createElement("span");
    name.textContent = zone.name;
    const stateText = document.createElement("span");
    stateText.className = "zone-state";
    stateText.textContent = zone.bracket ? `待查 ${zone.bracket.low}–${zone.bracket.high} ms` : "证据不够";
    head.append(name, stateText);
    const detail = document.createElement("div");
    detail.className = "zone-detail";
    detail.textContent = zone.reason;
    card.append(head, detail);
    if (zone.bracket) {
      const line = document.createElement("div");
      line.className = "bracket-line";
      const track = document.createElement("span");
      track.className = "track";
      const ends = document.createElement("span");
      ends.className = "ends";
      ends.append(document.createElement("i"), document.createElement("i"));
      track.append(ends);
      line.append(track);
      card.append(line);
    }
    zoneBox.append(card);
  }
  if (!advice.zones.some(zone => zone.bracket)) {
    pickBox.textContent = "没有任何检查框被两端夹住，这一轮暂不能给出待查范围内的等待。";
    return;
  }
  if (!advice.pick) {
    pickBox.textContent = "所有夹住的待查段内都没有这轮未拍过的整数毫秒等待。";
    return;
  }
  const pick = advice.pick;
  const coveredText = pick.coveredZones.length ? `可同时缩小：${pick.coveredZones.join("、")}` : "落在最宽待查段内";
  pickBox.textContent = `推荐下一张等待 ${pick.wait} ms（${coveredText}；最宽段由 ${pick.widestBefore} ms 缩到最坏 ${pick.widestAfter} ms）。`;
  adopt.disabled = false;
  adopt.dataset.wait = String(pick.wait);
}

function showGraph() {
  const canvas = el("graph");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  state.graphHits = [];
  const groups = new Map();
  for (const shot of state.measurements) {
    shot.zones.forEach((zone, index) => {
      const key = JSON.stringify([shot.pattern, shot.trial, index]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({wait: shot.wait, value: zone.p95, id: shot.id});
    });
  }
  const points = Array.from(groups.values()).flat();
  if (!points.length) {
    ctx.fillStyle = "#63776a";
    ctx.font = "14px system-ui";
    ctx.fillText("Add a capture to plot residual measurements.", 44, 60);
    return;
  }
  const advice = state.recommendation;
  const bracketWaits = advice ? advice.zones.filter(zone => zone.bracket)
    .flatMap(zone => [zone.bracket.low, zone.bracket.high]) : [];
  const recommendedWait = advice?.pick?.wait;
  const maxDelay = Math.max(1, ...points.map(item => item.wait), ...bracketWaits,
    Number.isFinite(recommendedWait) ? recommendedWait : 0);
  const maxValue = Math.max(4, ...points.map(item => item.value),
    advice ? advice.limit + advice.band : 0);
  const px = delay => 47 + (canvas.width - 83) * delay / maxDelay;
  const py = value => 179 - 154 * value / maxValue;
  const bracketTop = 201;
  const bracketStep = 6;
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
  ctx.fillText("0 ms", px(0), 197);
  ctx.fillText(maxDelay + " ms", px(maxDelay) - 36, 197);

  if (advice) {
    const limitY = py(advice.limit);
    ctx.strokeStyle = "#b4462e";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(px(0), limitY);
    ctx.lineTo(px(maxDelay), limitY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#b4462e";
    ctx.fillText("limit " + advice.limit, px(maxDelay) - 78, limitY - 5);
    const bandColor = "rgba(180,70,46,.08)";
    ctx.fillStyle = bandColor;
    const top = py(Math.min(maxValue, advice.limit + advice.band));
    const bottom = py(Math.max(0, advice.limit - advice.band));
    ctx.fillRect(px(0), top, px(maxDelay) - px(0), bottom - top);
  }

  // Evidence brackets: the wait windows actually supported by real photos.
  if (advice) {
    const bracketColors = ["#c9a06b", "#7d9bbf", "#8b648e", "#6e792f", "#ad643d", "#4d555b", "#286e53", "#a05d83"];
    advice.zones.forEach((zone, zoneIndex) => {
      if (!zone.bracket) return;
      const {low, high, lowId, highId} = zone.bracket;
      const y = bracketTop + (zoneIndex % 4) * bracketStep;
      const x1 = px(low);
      const x2 = px(high);
      const color = bracketColors[zoneIndex % bracketColors.length];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      for (const [x, id, wait] of [[x1, lowId, low], [x2, highId, high]]) {
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fcfdfa";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        state.graphHits.push({x, y, radius: 9, id, wait, zone: zone.name});
      }
    });
  }

  const palette = ["#286e53", "#ad643d", "#547dad", "#8b648e", "#6e792f", "#4d555b"];
  const verdictColor = {over: "#b4462e", pass: "#225d4a", hold: "#8a8f86"};
  Array.from(groups.entries()).forEach(([key, series], index) => {
    const [pattern, trial] = JSON.parse(key);
    const isActiveSeries = advice && pattern === advice.pattern && trial === advice.trial;
    ctx.strokeStyle = ctx.fillStyle = palette[index % palette.length];
    ctx.globalAlpha = isActiveSeries ? 1 : 0.35;
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((item, point) => {
      if (point === 0) ctx.moveTo(px(item.wait), py(item.value));
      else ctx.lineTo(px(item.wait), py(item.value));
    });
    ctx.stroke();
    for (const item of series) {
      const zoneIndex = JSON.parse(key)[2];
      const zoneAdvice = advice?.zones[zoneIndex];
      const verdict = zoneAdvice && isActiveSeries
        ? zoneAdvice.points.find(candidate => candidate.id === item.id)?.verdict
        : null;
      ctx.beginPath();
      if (verdict === "hold") {
        ctx.arc(px(item.wait), py(item.value), 4, 0, Math.PI * 2);
        ctx.fillStyle = "#fcfdfa";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = verdictColor.hold;
        ctx.stroke();
      } else if (verdict) {
        ctx.fillStyle = verdictColor[verdict];
        ctx.arc(px(item.wait), py(item.value), 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = palette[index % palette.length];
        ctx.arc(px(item.wait), py(item.value), 3, 0, Math.PI * 2);
        ctx.fill();
      }
      state.graphHits.push({x: px(item.wait), y: py(item.value), radius: 7, id: item.id,
        wait: item.wait, zone: seriesLabel(key)});
    }
    ctx.globalAlpha = 1;
  });

  if (Number.isFinite(recommendedWait)) {
    const x = px(recommendedWait);
    ctx.strokeStyle = "#7a2fa0";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 12);
    ctx.lineTo(x, 184);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#7a2fa0";
    ctx.font = "bold 13px system-ui";
    const label = `next ${recommendedWait} ms`;
    ctx.fillText(label, Math.min(x + 6, canvas.width - 92), 24);
  }
}

function seriesLabel(key) {
  const [pattern, trial, index] = JSON.parse(key);
  const zoneName = state.settings.zones[index]?.name || `Zone ${index + 1}`;
  return `${zoneName} · ${pattern} · trial ${trial}`;
}

async function inspect() { await Promise.all([showImage(), measure()]); renderAdvisor(); }
async function render() { displayControls(); await inspect(); }

async function selectCapture(value) {
  state.settings.capture = value || null;
  el("probeRead").textContent = "";
  state.point = null;
  displayControls();
  showTable();
  buildRecommendation();
  renderAdvisor();
  showGraph();
  await showImage();
}
window.selectCapture = selectCapture;

el("image").onclick = handle(async event => {
  if (!state.mode) return;
  const image = event.currentTarget.getBoundingClientRect();
  const {width, height} = target();
  const point = [
    Math.min(width - 1, Math.max(0, Math.floor((event.clientX - image.left) * width / image.width))),
    Math.min(height - 1, Math.max(0, Math.floor((event.clientY - image.top) * height / image.height))),
  ];
  if (state.mode === "probe") {
    const source = active();
    const result = await request(base() + "/point" + suffix(), "POST", {capture: source.id, point});
    state.point = point;
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
el("probe").onclick = () => {
  state.mode = state.mode === "probe" ? "" : "probe";
  state.corner = null;
  renderMode();
};
el("capture").onchange = handle(event => selectCapture(event.target.value));
el("criticalBand").onchange = handle(event => {
  const value = event.currentTarget;
  if (!value.checkValidity() || Number(value.value) < 0) {
    value.value = state.recommendation?.band ?? 1;
    throw new Error("Enter a non-negative critical band in DN.");
  }
  buildRecommendation();
  renderAdvisor();
  showGraph();
});
el("adoptWait").onclick = handle(() => {
  const wait = Number(el("adoptWait").dataset.wait);
  if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT) throw new Error("No usable recommended wait.");
  state.settings.delay = wait;
  el("delay").value = wait;
  el("captureForm").elements.wait.value = wait;
  el("captureDialog").showModal();
  notice(`已把推荐等待 ${wait} ms 带入加照窗；加入照片后才会出现新的实拍读数。`);
});
el("graph").onclick = event => {
  const rect = event.currentTarget.getBoundingClientRect();
  const scaleX = event.currentTarget.width / rect.width;
  const scaleY = event.currentTarget.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  let hit = null;
  for (const candidate of state.graphHits) {
    const distance = Math.hypot(x - candidate.x, y - candidate.y);
    if (distance <= candidate.radius && (!hit || distance < hit.distance)) hit = {...candidate, distance};
  }
  if (!hit) return;
  notice(`打开 ${hit.zone} 的 ${hit.wait} ms 实拍照片。`);
  selectCapture(hit.id);
};
el("graph").onmousemove = event => {
  const rect = event.currentTarget.getBoundingClientRect();
  const scaleX = event.currentTarget.width / rect.width;
  const scaleY = event.currentTarget.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const hovering = state.graphHits.some(candidate => Math.hypot(x - candidate.x, y - candidate.y) <= candidate.radius);
  event.currentTarget.classList.toggle("clickable", hovering);
};
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
  el("probeRead").textContent = "";
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

Object.assign(window, {renderAdvisor, showGraph, displayControls, measure});
