/* AviationWeather — live aviation console for standardweather.github.io.
 *
 * Everything loads live in the browser from government services that allow cross-origin requests:
 *   NOAA map services (AWC aviation layers)  METARs, TAFs, PIREPs, G-AIRMETs, SIGMETs, international SIGMETs, CWAs, TCF
 *   nowCOAST (NOAA)                          radar mosaic loop
 */
(() => {
  "use strict";

  const AWC = "https://mapservices.weather.noaa.gov/vector/rest/services/aviation/awc_aviation_weather/MapServer";
  const L_ = { metar: 42, taf: 51, turb: 1, llws: 2, ice: 3, tcf4: 96, gairmet: 110, sigmet: 111, isigmet: 112, cwa: 113 };
  const NOWCOAST = "https://nowcoast.noaa.gov/geoserver";
  const NA = "-170,15,-50,72";            // North America and the Caribbean
  const CONUS = [[24, -125], [50, -66]];
  const RADAR_FRAMES = 12;
  const RADAR_STEP = 10 * 60000;

  const FC = { VFR: "#3fcf6a", MVFR: "#4f8dff", IFR: "#ff4d4d", LIFR: "#e65cff" };
  const fcColor = (c) => FC[c] || "#7c84a6";
  const GAIRMET = {
    "TURB-HI": ["#ff9548", "Turbulence (high)"], "TURB-LO": ["#ffbf47", "Turbulence (low)"], ICE: ["#6fe3e8", "Icing"],
    IFR: ["#b38bff", "IFR"], MT_OBSC: ["#ff7ab8", "Mountain obscuration"], SFC_WND: ["#d2b48c", "Surface wind"],
    LLWS: ["#ffd84a", "Low-level wind shear"], M_FZLVL: ["#7cb8ff", "Multiple freezing levels"], FZLVL: ["#7cb8ff", "Freezing level"],
  };
  const SIGMET_COLOR = (h) => (/CONVECTIVE/.test(h) ? "#ff4d4d" : /TURB/.test(h) ? "#ff9548" : /ICE/.test(h) ? "#6fe3e8" : /ASH|VA/.test(h) ? "#c0c0c0" : "#ff7ab8");
  const INTENSITY = { NEG: 0, SMTH: 0, LGT: 1, "LGT-MOD": 2, MOD: 3, "MOD-SEV": 4, SEV: 5, EXTRM: 6 };
  const intensityColor = (i) => ["#9aa3c0", "#ffe27a", "#ffbf47", "#ff9548", "#ff6b6b", "#ff3b30", "#e65cff"][INTENSITY[i] ?? 0];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const hhmmZ = (t) => { const d = new Date(t); return `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
  const ddhhZ = (t) => { const d = new Date(t); return `${pad(d.getUTCDate())}/${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`; };
  const awcTime = (s) => (typeof s === "number" ? s : Date.parse(String(s).replace(/\//g, "-").replace(" ", "T").replace(/\+00$/, "Z")));
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };

  const state = {
    view: "airports", station: null, metars: [], metarIndex: {}, taf: null,
    sigmets: null, isigmets: null, cwas: null, gairmets: null, gairmetOn: Object.fromEntries(Object.keys(GAIRMET).map((k) => [k, !/FZLVL/.test(k)])),
    pireps: [], tcf: null, selected: null,
    on: { metars: true, radar: true, sigmets: true, gairmets: true, pireps: true, tcf: false },
    radar: { times: [], layers: [], idx: 0, timer: null, opacity: 0.6 },
  };

  // —— Map ————————————————————————————————————————————————————————
  const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 12, preferCanvas: false }).fitBounds(CONUS);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix("");
  [["radar", 300], ["tcf", 340], ["gairmet", 380], ["sigmet", 420], ["highlight", 450], ["points", 620], ["labels", 640]]
    .forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Esri" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels", opacity: 0.85 }).addTo(map);
  map.attributionControl.addAttribution("NOAA AWC · nowCOAST");
  const canvas = L.canvas({ pane: "points", padding: 0.3 });

  const layers = {
    metars: L.layerGroup(), sigmets: L.layerGroup(), gairmets: L.layerGroup(), pireps: L.layerGroup(), tcf: L.layerGroup(),
    highlight: L.layerGroup().addTo(map),
  };
  Object.entries(state.on).forEach(([k, v]) => { if (v && layers[k]) layers[k].addTo(map); });

  // The AWC layers return points as Point or single-member MultiPoint.
  function xy(f) {
    const g = f.geometry;
    if (!g) return null;
    const c = g.type === "MultiPoint" ? g.coordinates[0] : g.coordinates;
    return c && c.length >= 2 ? { lat: c[1], lon: c[0] } : null;
  }

  function setStatus(msg) { $("status").textContent = msg || ""; $("status").hidden = !msg; }

  async function query(id, params = {}) {
    const q = new URLSearchParams({ where: "1=1", outFields: "*", f: "geojson", ...params });
    const res = await fetch(`${AWC}/${id}/query?${q}`);
    if (!res.ok) throw new Error(`AWC layer ${id}: ${res.status}`);
    const gj = await res.json();
    if (gj.error) throw new Error(gj.error.message);
    return gj;
  }

  // Layers are capped at 2,000 records per request; page through the rest.
  async function queryAll(id, params) {
    const out = [];
    for (let offset = 0; offset < 20000; offset += 2000) {
      const gj = await query(id, { ...params, resultOffset: offset, resultRecordCount: 2000 });
      out.push(...gj.features);
      if (!gj.exceededTransferLimit && !(gj.properties && gj.properties.exceededTransferLimit) && gj.features.length < 2000) break;
    }
    return out;
  }

  // —— Radar loop (same source as NowWeather) ——————————————————————————
  async function radarTimes() {
    const res = await fetch(`${NOWCOAST}/observations/weather_radar/wms?service=WMS&version=1.3.0&request=GetCapabilities&_=${Date.now()}`);
    const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
    const layer = [...xml.getElementsByTagName("Layer")].find((l) => l.getElementsByTagName("Name")[0]?.textContent === "base_reflectivity_mosaic");
    const dim = [...(layer?.getElementsByTagName("Dimension") || [])].find((d) => d.getAttribute("name") === "time");
    if (!dim) throw new Error("no radar times");
    const all = dim.textContent.trim().split(",").map((s) => s.trim()).filter(Boolean).sort();
    const picked = [];
    let next = Infinity;
    for (let i = all.length - 1; i >= 0 && picked.length < RADAR_FRAMES; i--) {
      const t = Date.parse(all[i]);
      if (t <= next) { picked.unshift(all[i]); next = t - RADAR_STEP + 60000; }
    }
    return picked;
  }
  function clearRadar() { radarLoop(false); state.radar.layers.forEach((l) => l.remove()); state.radar.layers = []; state.radar.times = []; }
  async function loadRadar(force) {
    const r = state.radar;
    if (!state.on.radar) { clearRadar(); $("t1").textContent = "Radar off"; $("t0").textContent = ""; return; }
    try {
      const times = await radarTimes();
      if (!force && times[times.length - 1] === r.times[r.times.length - 1]) return;
      clearRadar();
      r.times = times;
      r.layers = times.map((t, i) => L.tileLayer.wms(`${NOWCOAST}/observations/weather_radar/wms`, {
        layers: "base_reflectivity_mosaic", format: "image/png", transparent: true, version: "1.3.0", time: t,
        pane: "radar", opacity: i === times.length - 1 ? r.opacity : 0, tileSize: 512, attribution: "",
      }));
      r.idx = times.length - 1;
      r.layers[r.idx].addTo(map);
      $("frame").max = times.length - 1; $("frame").value = r.idx; $("t0").textContent = hhmmZ(times[0]);
      radarLabel();
    } catch { $("t1").textContent = "Radar unavailable"; }
  }
  function radarLabel() { const t = state.radar.times[state.radar.idx]; if (t) $("t1").textContent = `Radar ${hhmmZ(t)}`; }
  function radarShow(i) {
    const r = state.radar; const n = r.layers.length; if (!n) return;
    const next = (i + n) % n;
    if (!map.hasLayer(r.layers[next])) r.layers[next].addTo(map);
    r.layers[next].setOpacity(r.opacity);
    r.layers.forEach((l, j) => { if (j !== next) l.setOpacity(0); });
    r.idx = next; $("frame").value = next; radarLabel();
  }
  function radarLoop(force) {
    const r = state.radar; const playing = force ?? !r.timer;
    clearInterval(r.timer); r.timer = null;
    $("play").textContent = playing ? "❚❚" : "▶";
    $("play").setAttribute("aria-label", playing ? "Pause radar loop" : "Play radar loop");
    if (!playing || !r.layers.length) return;
    r.layers.forEach((l) => { if (!map.hasLayer(l)) l.addTo(map); });
    let hold = 0;
    r.timer = setInterval(() => { if (r.idx === r.layers.length - 1 && hold++ < 2) return; hold = 0; radarShow(r.idx + 1); }, 500);
  }
  $("play").onclick = () => radarLoop();
  $("frame").oninput = (e) => { radarLoop(false); radarShow(+e.target.value); };

  // —— METARs and TAFs ————————————————————————————————————————————————
  async function loadMetars() {
    const feats = await queryAll(L_.metar, {
      geometry: NA, geometryType: "esriGeometryEnvelope", inSR: 4326,
      outFields: "station_id,raw_text,observation_time,flight_category,temp_c,dewpoint_c,winddir,wind_speed_kt,wind_gust_kt,visibility_statute_mi,altim_in_hg,wx_string,ceiling_ft,sky_cover,cloud_base_ft_agl,sky_cover_1,cloud_base_ft_agl_1,sky_cover_2,cloud_base_ft_agl_2,vert_vis_ft",
    });
    // Keep the newest report per station.
    const idx = {};
    feats.forEach((f) => {
      const p = f.properties;
      const pos = xy(f);
      if (!p.station_id || !pos) return;
      const prev = idx[p.station_id];
      if (!prev || p.observation_time > prev.observation_time) idx[p.station_id] = { ...p, ...pos };
    });
    state.metarIndex = idx;
    state.metars = Object.values(idx);
    const newest = Math.max(...state.metars.map((m) => m.observation_time));
    $("updated").textContent = `METARs to ${hhmmZ(newest)}`;
    drawMetars();
  }

  // Smaller dots when zoomed out so 3,000 stations don't merge into a blanket.
  const dotRadius = () => (map.getZoom() <= 4 ? 2.2 : map.getZoom() <= 6 ? 3.2 : 4.6);
  let lastRadius = null;
  map.on("zoomend", () => { if (dotRadius() !== lastRadius) { lastRadius = dotRadius(); drawMetars(); } });

  function drawMetars() {
    layers.metars.clearLayers();
    for (const m of state.metars) {
      const sel = state.station === m.station_id;
      L.circleMarker([m.lat, m.lon], { renderer: canvas, radius: sel ? 7 : dotRadius(), weight: sel ? 2 : 0.6, color: sel ? "#fff" : "#060818", fillColor: fcColor(m.flight_category), fillOpacity: 0.95 })
        .on("click", () => selectStation(m.station_id, false))
        .bindTooltip(`${m.station_id} · ${m.flight_category || "—"}`, { className: "tw-tip", direction: "top", offset: [0, -4] })
        .addTo(layers.metars);
    }
  }

  // AWC's flight-category rules, applied to TAF periods (METARs already carry a category).
  function category(visStr, ceil) {
    const vis = visStr == null ? 99 : parseFloat(String(visStr).replace("+", "")) || 99;
    const c = ceil == null ? 99999 : ceil;
    if (c < 500 || vis < 1) return "LIFR";
    if (c < 1000 || vis < 3) return "IFR";
    if (c <= 3000 || vis <= 5) return "MVFR";
    return "VFR";
  }

  // TAFs: US airports from the NWS API (product TAFxxx, plain text); others from the AWC map layer.
  async function loadTaf(id) {
    if (/^K[A-Z0-9]{3}$/.test(id)) {
      const list = await (await fetch(`https://api.weather.gov/products/types/TAF/locations/${id.slice(1)}`)).json();
      const latest = (list["@graph"] || [])[0];
      if (latest) {
        const prod = await (await fetch(latest["@id"] || `https://api.weather.gov/products/${latest.id}`)).json();
        const taf = parseTaf(prod.productText || "", id);
        if (taf) return taf;
      }
    }
    const gj = await query(L_.taf, { where: `station_id='${id.replace(/'/g, "")}'`, returnGeometry: false, orderByFields: "fcst_time_from" });
    const raw = gj.features[0]?.properties.raw_text;
    return raw ? parseTaf(raw, id) : null;
  }

  // Minimal TAF decoder: splits change groups and reads wind, visibility, weather and the ceiling,
  // carrying prevailing values into TEMPO/PROB groups that don't restate them.
  function parseTaf(text, id) {
    const lines = text.replace(/\r/g, "").split("\n");
    const start = lines.findIndex((l) => new RegExp(`(^|\\s)${id}\\s+\\d{6}Z`).test(l));
    if (start < 0) return null;
    let body = [];
    for (let i = start; i < lines.length; i++) {
      body.push(lines[i].trim());
      if (/=\s*$/.test(lines[i]) || !lines[i + 1]?.trim()) break;
    }
    const raw = body.join("\n").replace(/=\s*$/, "");
    const tokens = raw.replace(/\s+/g, " ").trim().split(" ");
    const issue = tokens.find((t) => /^\d{6}Z$/.test(t));
    const base = issue ? new Date() : new Date();
    const at = (dd, hh, mm = 0) => {
      const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), +dd, +hh, +mm));
      if (d - base > 20 * 86400e3) d.setUTCMonth(d.getUTCMonth() - 1);     // month rollover
      if (base - d > 20 * 86400e3) d.setUTCMonth(d.getUTCMonth() + 1);
      return d.getTime();
    };
    const groups = [];
    let cur = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      let m;
      if ((m = t.match(/^FM(\d{2})(\d{2})(\d{2})$/))) { cur = { type: "FM", from: at(m[1], m[2], m[3]), tok: [] }; groups.push(cur); continue; }
      if (/^(TEMPO|BECMG)$/.test(t) || /^PROB\d{2}$/.test(t)) {
        const type = /^PROB/.test(t) && tokens[i + 1] === "TEMPO" ? `${t} TEMPO` : t;
        if (type.endsWith("TEMPO") && /^PROB/.test(t)) i++;
        cur = { type, tok: [] }; groups.push(cur); continue;
      }
      if (!cur && (m = t.match(/^(\d{2})(\d{2})\/(\d{2})(\d{2})$/))) { cur = { type: "BASE", from: at(m[1], m[2]), tok: [] }; groups.push(cur); continue; }
      if (cur && !cur.from && (m = t.match(/^(\d{2})(\d{2})\/(\d{2})(\d{2})$/))) { cur.from = at(m[1], m[2]); cur.to = at(m[3], m[4]); continue; }
      if (cur) cur.tok.push(t);
    }
    let prev = { wind: "—", vis: null, ceil: null, wx: "" };
    const periods = groups.map((g) => {
      const out = { from: g.from, type: g.type === "BASE" ? "Initial" : g.type };
      let vis = null, ceil = null, wind = null, wx = [];
      g.tok.forEach((t, k) => {
        let m;
        if ((m = t.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/))) wind = m[1] === "000" && m[2] === "00" ? "Calm" : `${m[1] === "VRB" ? "VRB" : `${m[1]}°`} ${+m[2]}${m[3] ? `G${+m[3]}` : ""} kt`;
        else if (/^P6SM$/.test(t)) vis = 6.1;
        else if ((m = t.match(/^(\d+)SM$/))) vis = +m[1] + (/^\d+$/.test(g.tok[k - 1] || "") ? 0 : 0);
        else if ((m = t.match(/^(\d)\/(\d)SM$/))) vis = (/^\d$/.test(g.tok[k - 1] || "") ? +g.tok[k - 1] : 0) + m[1] / m[2];
        else if ((m = t.match(/^(BKN|OVC|VV)(\d{3})/))) { const h = +m[2] * 100; if (ceil == null || h < ceil) ceil = h; }
        else if (t === "SKC" || t === "NSC") ceil = Infinity;
        else if (/^[-+]?(VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?(DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)+$/.test(t) || /^VC(SH|TS|FG|PO|SS|DS|BLSN|BLDU|BLSA)$/.test(t)) wx.push(t);
      });
      const prevailing = g.type === "BASE" || g.type === "FM";
      if (prevailing && ceil == null && g.tok.some((t) => /^(FEW|SCT)\d{3}/.test(t))) ceil = Infinity;
      const v = vis ?? prev.vis, c = ceil ?? prev.ceil;
      out.wind = wind ?? (prevailing ? "—" : prev.wind);
      out.vis = vis != null ? (vis > 6 ? "6+" : String(Math.round(vis * 100) / 100)) : prevailing ? "—" : null;
      out.ceil = ceil != null ? ceil : prevailing ? null : undefined;
      out.wx = wx.join(" ");
      out.cat = category(v, c === Infinity ? null : c);
      if (prevailing) prev = { wind: out.wind, vis: v, ceil: c, wx: out.wx };
      return out;
    }).filter((p) => p.from);
    return { raw, periods };
  }

  async function selectStation(id, fly) {
    const m = state.metarIndex[id];
    state.station = id;
    state.taf = null;
    history.replaceState(null, "", `#${id}`);
    state.view = "airports";
    setTabs();
    drawMetars();
    render();
    if (m && fly) map.flyTo([m.lat, m.lon], Math.max(map.getZoom(), 7), { duration: 0.6 });
    try { state.taf = await loadTaf(id); } catch { state.taf = null; }
    if (state.station === id) render();
  }

  function airportsView() {
    const counts = Object.fromEntries(Object.keys(FC).map((k) => [k, state.metars.filter((m) => m.flight_category === k).length]));
    const m = state.station && state.metarIndex[state.station];
    let html = `<form class="search" id="search"><input id="q" placeholder="ICAO, e.g. KMIA" aria-label="Airport identifier" autocomplete="off" value="${esc(state.station || "")}" /><button class="btn btn--secondary">Show</button></form>
      <div class="pad"><h5 class="sub">Flight categories now · ${state.metars.length} stations</h5>
      <div class="counts">${Object.entries(FC).map(([k, c]) => `<div style="color:${c}">${counts[k]}<small>${k}</small></div>`).join("")}</div>`;
    if (state.station && !m) html += `<p class="note">No current METAR for <b>${esc(state.station)}</b>.</p>`;
    if (m) {
      const wind = m.wind_speed_kt === 0 ? "Calm" : `${m.winddir ?? "VRB"}° ${m.wind_speed_kt}${m.wind_gust_kt ? ` gust ${m.wind_gust_kt}` : ""} kt`;
      html += `<h5 class="sub">${esc(m.station_id)} · METAR ${ddhhZ(m.observation_time)} · ${ago(m.observation_time)}</h5>
        <div class="raw">${esc(m.raw_text)}</div>
        <dl class="kv"><dt>Category</dt><dd><span class="fc" style="background:${fcColor(m.flight_category)}">${esc(m.flight_category || "—")}</span></dd>
          <dt>Wind</dt><dd>${esc(wind)}</dd><dt>Visibility</dt><dd>${esc(m.visibility_statute_mi ?? "—")} sm</dd>
          <dt>Ceiling</dt><dd>${m.ceiling_ft ? `${m.ceiling_ft.toLocaleString()} ft` : m.vert_vis_ft ? `VV ${m.vert_vis_ft} ft` : "None"}</dd>
          <dt>Weather</dt><dd>${esc(m.wx_string || "—")}</dd><dt>Temp / dew</dt><dd>${m.temp_c ?? "—"}° / ${m.dewpoint_c ?? "—"}° C</dd>
          <dt>Altimeter</dt><dd>${m.altim_in_hg ? `${m.altim_in_hg.toFixed(2)} inHg` : "—"}</dd></dl>`;
      const t = state.taf;
      if (t) {
        html += `<h5 class="sub">TAF</h5><table class="t"><thead><tr><th>From</th><th>Wind</th><th>Vis / ceiling</th><th></th></tr></thead><tbody>${t.periods.map((p) =>
          `<tr><td>${ddhhZ(p.from)}<small>${esc(p.type)}</small></td><td>${esc(p.wind)}</td><td>${p.vis ? `${esc(p.vis)} sm` : "—"}<small>${p.ceil && isFinite(p.ceil) ? `ceiling ${(+p.ceil).toLocaleString()} ft` : p.ceil === undefined ? "ceiling as prevailing" : "no ceiling"}${p.wx ? ` · ${esc(p.wx)}` : ""}</small></td><td><span class="fc" style="background:${fcColor(p.cat)}">${p.cat}</span></td></tr>`).join("")}</tbody></table>
          <div class="raw">${esc(t.raw)}</div>`;
      } else if (state.station) {
        html += `<p class="note">No TAF for ${esc(state.station)}.</p>`;
      }
    } else {
      html += `<p class="note">Search an airport or click a station on the map for its METAR and TAF.</p>`;
    }
    return html + `</div>`;
  }

  // —— Advisories ——————————————————————————————————————————————————
  async function loadAdvisories() {
    const [sig, isig, cwa, gair, tcf] = await Promise.all([L_.sigmet, L_.isigmet, L_.cwa, L_.gairmet, L_.tcf4].map((id) => query(id).catch(() => null)));
    state.sigmets = sig; state.isigmets = isig; state.cwas = cwa; state.gairmets = gair; state.tcf = tcf;
    drawAdvisories();
  }

  function advisoryItems() {
    const items = [];
    (state.sigmets?.features || []).forEach((f, i) => {
      const p = f.properties;
      const conv = /CONVECTIVE/.test(p.hazard);
      items.push({ key: `s${i}`, f, kind: p.airsigmet_type === "AIRMET" ? "AIRMET" : conv ? "Convective SIGMET" : "SIGMET", hazard: p.hazard, sev: p.severity,
        from: p.valid_time_from, to: p.valid_time_to, text: p.raw_text, color: SIGMET_COLOR(p.hazard) });
    });
    (state.cwas?.features || []).forEach((f, i) => {
      const p = f.properties;
      items.push({ key: `c${i}`, f, kind: "CWA", hazard: `${p.hazard}${p.qualifier ? ` · ${p.qualifier}` : ""}`, from: awcTime(p.validtimef), to: awcTime(p.validtimet), text: p.cwatext, color: "#ffffff", place: `${p.cwsu} ${p.name}` });
    });
    (state.isigmets?.features || []).forEach((f, i) => {
      const p = f.properties;
      items.push({ key: `i${i}`, f, kind: "International SIGMET", hazard: `${p.hazard}${p.qualifier ? ` · ${p.qualifier}` : ""}`, from: awcTime(p.validtimef), to: awcTime(p.validtimet), text: p.rawsigmet, color: SIGMET_COLOR(p.hazard), place: p.firname });
    });
    return items;
  }

  function drawAdvisories() {
    layers.sigmets.clearLayers(); layers.gairmets.clearLayers(); layers.tcf.clearLayers();
    for (const it of advisoryItems()) {
      L.geoJSON(it.f, { pane: "sigmet", style: { color: it.color, weight: it.kind === "CWA" ? 1.6 : 2.2, dashArray: it.kind === "CWA" ? "5 4" : null, fillColor: it.color, fillOpacity: 0.08 } })
        .bindTooltip(`${esc(it.kind)} · ${esc(it.hazard)}`, { className: "tw-tip", sticky: true })
        .on("click", () => { state.view = "advisories"; state.selected = it.key; setTabs(); render(); document.querySelector(".alert.sel")?.scrollIntoView({ block: "nearest" }); })
        .addTo(layers.sigmets);
    }
    (state.gairmets?.features || []).forEach((f) => {
      const p = f.properties;
      if (!state.gairmetOn[p.hazard]) return;
      const [c, name] = GAIRMET[p.hazard] || ["#9aa3c0", p.hazard];
      L.geoJSON(f, { pane: "gairmet", style: { color: c, weight: 1.2, dashArray: /FZLVL/.test(p.hazard) ? "2 4" : null, fillColor: c, fillOpacity: 0.12 } })
        .bindTooltip(`G-AIRMET ${esc(name)}${p.top && p.top.trim() ? ` · ${esc(p.base)}–${esc(p.top)}` : ""} · valid ${esc(String(p.validtime).slice(11, 16))}Z`, { className: "tw-tip", sticky: true })
        .addTo(layers.gairmets);
    });
    (state.tcf?.features || []).forEach((f) => {
      if (+f.properties.coverage <= 0) return;
      L.geoJSON(f, { pane: "tcf", style: { color: "#ff7ab8", weight: 1.4, fillColor: "#ff7ab8", fillOpacity: 0.15 } })
        .bindTooltip(`TCF ${esc(f.properties.fcst_hr)} · ${esc(f.properties.confidnce)}`, { className: "tw-tip", sticky: true }).addTo(layers.tcf);
    });
  }

  function advisoriesView() {
    const items = advisoryItems();
    const gfeats = state.gairmets?.features || [];
    const gcount = (h) => gfeats.filter((f) => f.properties.hazard === h).length;
    const gvalid = gfeats[0]?.properties.validtime;
    const groups = ["Convective SIGMET", "SIGMET", "AIRMET", "CWA", "International SIGMET"];
    let html = `<div class="pad"><h5 class="sub">G-AIRMETs${gvalid ? ` · valid ${esc(String(gvalid).slice(11, 16))}Z` : ""}</h5>
      <div class="chips" style="padding:0">${Object.entries(GAIRMET).filter(([k]) => gcount(k)).map(([k, [c, name]]) =>
        `<button data-gair="${k}" aria-pressed="${state.gairmetOn[k]}"><i class="dot" style="background:${c}"></i>${esc(name)}<b>${gcount(k)}</b></button>`).join("") || `<span class="note">None in effect.</span>`}</div></div>`;
    for (const g of groups) {
      const list = items.filter((i) => i.kind === g);
      if (!list.length) continue;
      html += `<div class="group open"><div class="row" style="cursor:default"><i class="sw" style="background:${list[0].color}"></i><span class="name">${esc(g)}s</span><span class="num">${list.length}</span></div>
        ${list.map((it) => `<div class="alert${state.selected === it.key ? " sel" : ""}">
          <button class="row" data-adv="${it.key}"><span class="name">${esc(it.hazard)}${it.sev ? ` · ${esc(it.sev)}` : ""}<small>${esc(it.place || "")}</small></span><span class="num">${ddhhZ(it.from)}–${hhmmZ(it.to)}</span></button>
          ${state.selected === it.key ? `<div class="alert__body"><pre>${esc(it.text)}</pre></div>` : ""}</div>`).join("")}</div>`;
    }
    if (!items.length) html += `<p class="empty">No SIGMETs or CWAs in effect.</p>`;
    return html;
  }

  // —— PIREPs (turbulence, icing, wind shear) ——————————————————————————
  async function loadPireps() {
    const sets = await Promise.all([["turb", L_.turb], ["llws", L_.llws], ["ice", L_.ice]].map(async ([kind, id]) =>
      (await query(id, { geometry: NA, geometryType: "esriGeometryEnvelope", inSR: 4326 }).catch(() => ({ features: [] }))).features.map((f) => ({ kind, ...f.properties, ...(xy(f) || { lat: null, lon: null }) }))));
    const seen = new Set();
    state.pireps = sets.flat().filter((p) => p.lat != null && !seen.has(p.raw_text + p.kind) && seen.add(p.raw_text + p.kind))
      .sort((a, b) => b.observation_time - a.observation_time);
    drawPireps();
  }

  function pirepIntensity(p) { return p.kind === "ice" ? p.icing_intensity : p.kind === "llws" ? "MOD" : p.turbulence_intensity; }

  function drawPireps() {
    layers.pireps.clearLayers();
    for (const p of state.pireps) {
      const i = pirepIntensity(p);
      if (p.kind !== "llws" && (INTENSITY[i] ?? 0) < 3) continue;   // map shows moderate or greater, plus wind shear
      const c = p.kind === "ice" ? ["#9fd8ff", "#6fb8ff", "#4f8dff", "#2f5dff", "#b38bff", "#e65cff", "#e65cff"][INTENSITY[i] ?? 0] : intensityColor(i);
      const shape = p.kind === "ice" ? `<rect x="3" y="3" width="10" height="10" transform="rotate(45 8 8)" fill="${c}" stroke="#060818" stroke-width="1"/>`
        : `<path d="M8 2 L14 13 L2 13 Z" fill="${c}" stroke="#060818" stroke-width="1"/>`;
      L.marker([p.lat, p.lon], { pane: "points", icon: L.divIcon({ className: "", iconSize: [16, 16], iconAnchor: [8, 8], html: `<svg width="16" height="16" viewBox="0 0 16 16">${shape}</svg>` }) })
        .bindPopup(`<h4>${p.kind === "ice" ? "Icing" : p.kind === "llws" ? "Wind shear" : "Turbulence"} · ${esc(i || "")}</h4><p>${esc(hhmmZ(p.observation_time))} · ${esc(p.aircraft_ref || "")} · ${p.altitude_ft_msl ? `${(+p.altitude_ft_msl).toLocaleString()} ft` : "FL unknown"}</p><p style="font-family:var(--mono)">${esc(p.raw_text)}</p>`)
        .addTo(layers.pireps);
    }
  }

  function pirepsView() {
    const rel = state.pireps.filter((p) => p.kind === "llws" || (INTENSITY[pirepIntensity(p)] ?? 0) >= 3);
    const n = (k) => state.pireps.filter((p) => p.kind === k && (k === "llws" || (INTENSITY[pirepIntensity(p)] ?? 0) > 0)).length;
    return `<div class="pad"><h5 class="sub">Reports in the last ~90 minutes</h5>
      <div class="counts"><div>${n("turb")}<small>Turbulence</small></div><div>${n("ice")}<small>Icing</small></div><div>${n("llws")}<small>Wind shear</small></div></div>
      <h5 class="sub">Moderate or greater, and wind shear</h5>
      ${rel.length ? `<table class="t"><tbody>${rel.slice(0, 150).map((p) => `<tr data-ll="${p.lat},${p.lon}"><td>${hhmmZ(p.observation_time)}</td>
        <td><span class="dot" style="background:${p.kind === "ice" ? "#4f8dff" : intensityColor(pirepIntensity(p))}"></span>${p.kind === "ice" ? `Icing ${esc(pirepIntensity(p) || "")}` : p.kind === "llws" ? "Wind shear" : `Turb ${esc(pirepIntensity(p) || "")}`}
          <small>${esc(p.aircraft_ref || "")} · ${p.altitude_ft_msl ? `${Math.round(p.altitude_ft_msl / 100)}`.padStart(3, "0").replace(/^/, "FL") : "FL?"} · ${esc((p.raw_text || "").split(" ")[0])}</small></td></tr>`).join("")}</tbody></table>`
        : `<p class="note">None reported.</p>`}
      </div>`;
  }

  // —— Sidebar ——————————————————————————————————————————————————————
  function setTabs() { document.querySelectorAll("#views button").forEach((b) => b.setAttribute("aria-selected", b.dataset.view === state.view)); }
  function render() {
    $("panel").innerHTML = state.view === "airports" ? airportsView() : state.view === "advisories" ? advisoriesView() : pirepsView();
  }
  $("views").addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) { state.view = v; setTabs(); render(); } });

  $("panel").addEventListener("submit", (e) => {
    if (e.target.id !== "search") return;
    e.preventDefault();
    let id = $("q").value.trim().toUpperCase();
    if (/^[A-Z0-9]{3}$/.test(id) && state.metarIndex[`K${id}`]) id = `K${id}`;   // allow "MIA" for KMIA
    if (id) selectStation(id, true);
  });

  $("panel").addEventListener("click", (e) => {
    const t = e.target.closest("button, tr");
    if (!t) return;
    if (t.dataset.gair) { state.gairmetOn[t.dataset.gair] = !state.gairmetOn[t.dataset.gair]; drawAdvisories(); render(); return; }
    if (t.dataset.adv) {
      state.selected = state.selected === t.dataset.adv ? null : t.dataset.adv;
      layers.highlight.clearLayers();
      render();
      const it = advisoryItems().find((x) => x.key === state.selected);
      if (it) {
        const g = L.geoJSON(it.f, { pane: "highlight", interactive: false, style: { color: "#fff", weight: 2.5, fillOpacity: 0 } }).addTo(layers.highlight);
        map.flyToBounds(g.getBounds().pad(0.3), { maxZoom: 7, duration: 0.6 });
      }
      return;
    }
    if (t.dataset.ll) {
      const [lat, lon] = t.dataset.ll.split(",").map(Number);
      map.flyTo([lat, lon], Math.max(map.getZoom(), 7), { duration: 0.6 });
    }
  });

  $("layers").addEventListener("change", (e) => {
    const k = e.target.dataset?.layer;
    if (!k) return;
    state.on[k] = e.target.checked;
    if (k === "radar") { loadRadar(true); return; }
    e.target.checked ? layers[k].addTo(map) : layers[k].remove();
  });

  // —— Load & refresh ———————————————————————————————————————————————
  async function init() {
    loadRadar(true);
    setStatus("Loading aviation weather…");
    const res = await Promise.allSettled([loadMetars(), loadAdvisories(), loadPireps()]);
    res.forEach((r) => { if (r.status === "rejected") console.error(r.reason); });
    setStatus(res[0].status === "rejected" ? "METARs unavailable — try again shortly" : "");
    const hash = location.hash.slice(1).toUpperCase();
    if (/^[A-Z0-9]{3,4}$/.test(hash)) selectStation(hash, true); else render();

    setInterval(() => loadMetars().then(() => { if (state.view === "airports") render(); }).catch(() => {}), 5 * 60000);
    setInterval(() => { loadAdvisories().then(() => { if (state.view === "advisories") render(); }).catch(() => {}); loadPireps().then(() => { if (state.view === "pireps") render(); }).catch(() => {}); }, 5 * 60000);
    setInterval(() => { if (!state.radar.timer) loadRadar(false); }, 4 * 60000);
  }

  init();
})();
