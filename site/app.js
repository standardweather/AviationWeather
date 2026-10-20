/* AviationWeather — live aviation console for standardweather.github.io.
 *
 * Everything loads live in the browser from government services that allow cross-origin requests:
 *   NOAA map services (AWC aviation layers)  METARs, TAFs, PIREPs, G-AIRMETs, SIGMETs, international SIGMETs, CWAs, TCF
 *   nowCOAST (NOAA)                          radar mosaic loop, GOES satellite
 *   NWS API (api.weather.gov)                US TAFs, each station's newest METAR and 24-hour history,
 *                                            winds and temperatures aloft (FD bulletins)
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
  // G-AIRMETs come in three series: Sierra (IFR, mountains), Tango (turbulence, wind), Zulu (icing, freezing level).
  const GAIRMET_SERIES = {
    SIERRA: ["Sierra", ["IFR", "MT_OBSC"]],
    TANGO: ["Tango", ["TURB-HI", "TURB-LO", "SFC_WND", "LLWS"]],
    ZULU: ["Zulu", ["ICE", "FZLVL", "M_FZLVL"]],
  };
  const SERIES_OF = Object.fromEntries(Object.entries(GAIRMET_SERIES).flatMap(([k, [, hz]]) => hz.map((h) => [h, k])));
  // Each advisory product is broken down by hazard so every combination can be shown or hidden.
  const HAZ = {
    convective: ["Thunderstorms / convective", "#ff4d4d"], turb: ["Turbulence", "#ff9548"], ice: ["Icing", "#6fe3e8"],
    ifr: ["IFR / mountain obscuration", "#b38bff"], ash: ["Volcanic ash", "#c8c8c8"], tc: ["Tropical cyclone", "#ff7ab8"],
    dust: ["Dust / sandstorm", "#d2b48c"], other: ["Other", "#9aa3c0"],
  };
  const hazOf = (h) => {
    const t = String(h || "").toUpperCase();
    if (/CONV|^TS|TSGR|CB/.test(t)) return "convective";
    if (/TURB|MTW|LLWS/.test(t)) return "turb";
    if (/ICE|ICG|FZRA/.test(t)) return "ice";
    if (/IFR|OBSC|^MT|PCPN|VIS|CIG/.test(t)) return "ifr";
    if (/ASH|^VA/.test(t)) return "ash";
    if (/^TC|TROP/.test(t)) return "tc";
    if (/^DS|^SS|DUST|SAND/.test(t)) return "dust";
    return "other";
  };
  // product: [label, hazards offered, on by default]
  const ADV_PRODUCTS = {
    SIGMET: ["SIGMETs (domestic)", ["convective", "turb", "ice", "ifr", "ash", "other"], true],
    AIRMET: ["AIRMETs (text)", ["turb", "ice", "ifr", "other"], true],
    CWA: ["Center Weather Advisories", ["convective", "turb", "ice", "ifr", "other"], true],
    ISIGMET: ["International SIGMETs", ["convective", "turb", "ice", "ash", "tc", "dust", "other"], false],
  };
  const SAT = { ir: ["goes_longwave_imagery", "IR"], vis: ["goes_visible_imagery", "Visible"], wv: ["goes_water_vapor_imagery", "Water vapor"] };
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
    advOn: Object.fromEntries(Object.entries(ADV_PRODUCTS).flatMap(([prod, [, hz, on]]) => hz.map((h) => [`${prod}|${h}`, on]))),
    sat: { kind: "ir", layer: null, time: null },
    on: { metars: true, radar: true, sigmets: true, gairmets: true, pireps: true, tcf: false, winds: false },
    nws: null, winds: null, windsError: false, windFcst: "6", windAlt: "9000", route: null,
    radar: { times: [], layers: [], idx: 0, timer: null, opacity: 0.6 },
  };

  // —— Map ————————————————————————————————————————————————————————
  // A link to an airport (#KBOS) opens straight on it once METARs load, without drawing the national view first.
  const linked = /^[A-Z0-9]{3,4}$/.test(location.hash.slice(1).toUpperCase()) ? location.hash.slice(1).toUpperCase() : null;
  const map = L.map("map", { zoomControl: false, minZoom: 3, maxZoom: 12, preferCanvas: false });
  if (!linked) map.fitBounds(CONUS);
  L.control.zoom({ position: "topright" }).addTo(map);
  map.attributionControl.setPrefix("");
  [["sat", 260], ["radar", 300], ["tcf", 340], ["route", 360], ["gairmet", 380], ["sigmet", 420], ["highlight", 450], ["winds", 600], ["points", 620], ["labels", 640]]
    .forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, attribution: "Esri" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, pane: "labels", opacity: 0.85 }).addTo(map);
  map.attributionControl.addAttribution("NOAA AWC · nowCOAST");
  const canvas = L.canvas({ pane: "points", padding: 0.3 });

  const layers = {
    metars: L.layerGroup(), sigmets: L.layerGroup(), gairmets: L.layerGroup(), pireps: L.layerGroup(), tcf: L.layerGroup(),
    highlight: L.layerGroup().addTo(map), winds: L.layerGroup(), route: L.layerGroup().addTo(map),
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

  // Layers are capped at 2,000 records per request. Count first, then fetch every page at once:
  // the METAR layer takes several seconds per page, so paging one after another is slow.
  async function queryAll(id, params) {
    const q = new URLSearchParams({ where: "1=1", returnCountOnly: "true", f: "json", ...params });
    q.delete("outFields");
    const { count = 0 } = await (await fetch(`${AWC}/${id}/query?${q}`)).json();
    const pages = Array.from({ length: Math.max(1, Math.ceil(count / 2000)) }, (_, i) => i * 2000);
    const results = await Promise.all(pages.map((offset) => query(id, { ...params, resultOffset: offset, resultRecordCount: 2000 })));
    return results.flatMap((gj) => gj.features);
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
      L.circleMarker([m.lat, m.lon], { renderer: canvas, bubblingMouseEvents: false, radius: sel ? 7 : dotRadius(), weight: sel ? 2 : 0.6, color: sel ? "#fff" : "#060818", fillColor: fcColor(m.flight_category), fillOpacity: 0.95 })
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

  async function selectStation(id, fly, instant, keepView) {
    const m = state.metarIndex[id];
    state.station = id;
    state.taf = null;
    state.nws = null;
    history.replaceState(null, "", `${keepView ? location.search : location.pathname}#${id}`);
    if (!keepView) state.view = "airports";
    setTabs();
    drawMetars();
    render();
    if (m && fly) instant ? map.setView([m.lat, m.lon], 7) : map.flyTo([m.lat, m.lon], Math.max(map.getZoom(), 7), { duration: 0.6 });
    const [taf, nws] = await Promise.all([loadTaf(id).catch(() => null), loadNwsHistory(id).catch(() => null)]);
    if (state.station !== id) return;
    state.taf = taf;
    state.nws = nws || [];
    if (state.view === "airports" || state.view === "winds") render();
  }

  // The NWS API often has a station's newest METAR before NOAA's map service, plus 24 hours of history.
  async function loadNwsHistory(id) {
    const start = new Date(Date.now() - 24 * 3600e3).toISOString().replace(/\.\d+Z$/, "Z");
    const res = await fetch(`https://api.weather.gov/stations/${id}/observations?start=${start}`, { headers: { Accept: "application/geo+json" } });
    if (!res.ok) return null;
    const v = (q) => (q && q.value != null ? q.value : null);
    return (await res.json()).features.map((f) => {
      const p = f.properties;
      const vis = v(p.visibility) == null ? null : v(p.visibility) / 1609.34;
      const ceil = (p.cloudLayers || []).filter((c) => /BKN|OVC|VV/.test(c.amount) && c.base?.value != null).map((c) => c.base.value * 3.28084).sort((a, b) => a - b)[0];
      return {
        t: Date.parse(p.timestamp), raw: (p.rawMessage || "").trim(),
        wdir: v(p.windDirection), wspd: v(p.windSpeed) == null ? null : v(p.windSpeed) / 1.852, gust: v(p.windGust) == null ? null : v(p.windGust) / 1.852,
        vis, ceil: ceil ?? null, cat: vis == null && ceil == null ? null : category(vis == null ? null : vis.toFixed(2), ceil ?? null),
      };
    }).sort((a, b) => a.t - b.t);
  }

  function historyChart(obs) {
    const pts = obs.filter((o) => o.t >= Date.now() - 24 * 3600e3);
    if (pts.length < 3) return "";
    const W = 336, H = 118, L0 = 26, R0 = 6, T0 = 16, B0 = 18;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const hi = Math.max(20, Math.ceil(Math.max(...pts.map((o) => Math.max(o.gust ?? 0, o.wspd ?? 0))) / 10) * 10);
    const x = (t) => L0 + ((t - t0) / Math.max(1, t1 - t0)) * (W - L0 - R0);
    const y = (vv) => T0 + (1 - vv / hi) * (H - T0 - B0);
    const mono = 'font-family="IBM Plex Mono, monospace" font-size="9.5" fill="rgba(255,255,255,.42)"';
    let svg = "";
    // Flight-category strip along the top.
    pts.forEach((o, i) => {
      if (!o.cat) return;
      const nx = i + 1 < pts.length ? x(pts[i + 1].t) : x(o.t) + 2;
      svg += `<rect x="${x(o.t).toFixed(1)}" y="2" width="${Math.max(1, nx - x(o.t)).toFixed(1)}" height="8" fill="${fcColor(o.cat)}"/>`;
    });
    for (let vv = 0; vv <= hi; vv += hi > 40 ? 20 : 10) svg += `<line x1="${L0}" x2="${W - R0}" y1="${y(vv)}" y2="${y(vv)}" stroke="rgba(255,255,255,.07)"/><text x="${L0 - 5}" y="${y(vv) + 3}" text-anchor="end" ${mono}>${vv}</text>`;
    for (let t = Math.ceil(t0 / 21600e3) * 21600e3; t <= t1; t += 21600e3) svg += `<text x="${x(t)}" y="${H - 4}" text-anchor="middle" ${mono}>${pad(new Date(t).getUTCHours())}Z</text>`;
    const w = pts.filter((o) => o.wspd != null);
    if (w.length > 1) svg += `<polyline fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1.3" points="${w.map((o) => `${x(o.t).toFixed(1)},${y(o.wspd).toFixed(1)}`).join(" ")}"/>`;
    pts.filter((o) => o.gust != null).forEach((o) => { svg += `<circle cx="${x(o.t).toFixed(1)}" cy="${y(o.gust).toFixed(1)}" r="2.2" fill="#ff9548"/>`; });
    return `<h5 class="sub">Last 24 hours</h5><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Flight category, wind and gusts over the last 24 hours">${svg}</svg>
      <p class="note" style="margin-top:.2rem">Top strip: flight category · <span style="color:rgba(255,255,255,.7)">line</span> wind · <span style="color:#ff9548">dots</span> gusts (kt)</p>`;
  }

  // —— Winds and temperatures aloft (NWS FD bulletins) ——————————————————————
  const FD_ALTS = ["3000", "6000", "9000", "12000", "18000", "24000", "30000", "34000", "39000"];
  const FD_PRODUCTS = { 6: ["FD1", "US1"], 24: ["FD3", "US3"] };   // the NWS API doesn't carry the 12-hour FD2
  async function loadWinds() {
    const [code, loc] = FD_PRODUCTS[state.windFcst];
    const list = await (await fetch(`https://api.weather.gov/products/types/${code}/locations/${loc}`)).json();
    const latest = (list["@graph"] || [])[0];
    if (!latest) throw new Error("No winds-aloft bulletin");
    const prod = await (await fetch(latest["@id"] || `https://api.weather.gov/products/${latest.id}`)).json();
    state.winds = parseFd(prod.productText || "");
    drawWinds();
  }

  /** Decode an FD bulletin. Columns end where each altitude label ends; groups are DDff, DDff±TT, or DDffTT
   *  above 24,000 ft (temperatures negative). DD over 50 means 100 kt or more; 9900 is light and variable. */
  function parseFd(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    const hi = lines.findIndex((l) => /^FT\s+3000/.test(l));
    if (hi < 0) return { stations: [] };
    const cols = [...lines[hi].matchAll(/\d{4,5}/g)].map((m) => ({ alt: m[0], end: m.index + m[0].length }));
    const valid = (text.match(/VALID\s+(\d{6}Z)/) || [])[1];
    const use = (text.match(/FOR USE\s+([\d-]+Z)/) || [])[1];
    const based = (text.match(/BASED ON\s+(\d{6}Z)/) || [])[1];
    const stations = [];
    for (const line of lines.slice(hi + 1)) {
      const m = line.match(/^([A-Z0-9]{3})\s/);
      if (!m) continue;
      const levels = {};
      let start = 4;
      for (const c of cols) {
        const g = line.slice(start, c.end).trim();
        start = c.end;
        if (!/^\d{4}([+-]\d{2}|\d{2})?$/.test(g)) continue;
        let dd = +g.slice(0, 2), ff = +g.slice(2, 4);
        const temp = g.length === 4 ? null : /[+-]/.test(g) ? +g.slice(4) : -(+g.slice(4));
        if (dd === 99 && ff === 0) { levels[c.alt] = { lv: true, temp }; continue; }
        if (dd > 50) { dd -= 50; ff += 100; }
        levels[c.alt] = { dir: dd * 10, spd: ff, temp };
      }
      const st = state.metarIndex[`K${m[1]}`] || state.metarIndex[m[1]] || state.metarIndex[`P${m[1]}`];
      if (st) stations.push({ id: m[1], lat: st.lat, lon: st.lon, levels });
    }
    return { valid, use, based, stations };
  }

  const windText = (lv) => (!lv ? "—" : lv.lv ? "Light and variable" : `${String(lv.dir).padStart(3, "0")}° ${lv.spd} kt`);
  const tempText = (lv) => (lv?.temp != null ? `${lv.temp > 0 ? "+" : ""}${lv.temp}°C` : "—");
  const altLabel = (a) => (+a >= 18000 ? `FL${a.slice(0, 3)}` : `${(+a).toLocaleString()} ft`);

  // Standard wind barb drawn pointing into the wind: pennant 50 kt, full barb 10, half barb 5.
  function barb(dir, spd) {
    let n = Math.round(spd / 5) * 5, y = 0, parts = "";
    while (n >= 50) { parts += `<path d="M0 ${y} L10 ${y + 2.5} L0 ${y + 5} Z" fill="#fff"/>`; y += 6.5; n -= 50; }
    while (n >= 10) { parts += `<line x1="0" y1="${y}" x2="10" y2="${y - 3.5}" stroke="#fff" stroke-width="1.4"/>`; y += 3.5; n -= 10; }
    if (n >= 5) parts += `<line x1="0" y1="${y + (y ? 0 : 3.5)}" x2="5.5" y2="${y + (y ? 0 : 3.5) - 1.9}" stroke="#fff" stroke-width="1.4"/>`;
    return `<svg width="44" height="44" viewBox="-22 -22 44 44" style="overflow:visible"><g transform="rotate(${dir})"><line x1="0" y1="0" x2="0" y2="-20" stroke="#fff" stroke-width="1.4"/><g transform="translate(0,-20)">${parts}</g></g><circle r="2.2" fill="#4ad1ff" stroke="#060818" stroke-width=".8"/></svg>`;
  }

  function drawWinds() {
    layers.winds.clearLayers();
    for (const st of state.winds?.stations || []) {
      const lv = st.levels[state.windAlt];
      if (!lv) continue;
      L.marker([st.lat, st.lon], {
        pane: "winds",
        icon: L.divIcon({ className: "", iconSize: [44, 44], iconAnchor: [22, 22], html: lv.lv ? `<svg width="44" height="44" viewBox="-22 -22 44 44"><circle r="4" fill="none" stroke="#fff" stroke-width="1.4"/></svg>` : barb(lv.dir, lv.spd) }),
      }).bindTooltip(`${st.id} · ${altLabel(state.windAlt)} · ${windText(lv)}${lv.temp != null ? ` · ${tempText(lv)}` : ""}`, { className: "tw-tip", direction: "top", offset: [0, -6] }).addTo(layers.winds);
    }
    $("windAltLabel").textContent = state.winds ? altLabel(state.windAlt) : "";
  }

  function nearestFd(lat, lon) {
    let best = null;
    for (const st of state.winds?.stations || []) {
      const d = Math.hypot((st.lat - lat) * 111, (st.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180));
      if (!best || d < best.d) best = { st, d };
    }
    return best;
  }

  function windsView() {
    const w = state.winds;
    const fc = Object.keys(FD_PRODUCTS).map((k) => `<button data-wfc="${k}" aria-pressed="${state.windFcst === k}">${k} h forecast</button>`).join("");
    const alts = FD_ALTS.map((a) => `<button data-walt="${a}" aria-pressed="${state.windAlt === a}">${+a >= 18000 ? `FL${a.slice(0, 3)}` : `${+a / 1000}k`}</button>`).join("");
    let html = `<div class="satpick" style="padding:.7rem 1.25rem 0"><span>Product</span>${fc}</div>
      <div class="satpick" style="padding:.45rem 1.25rem 0;flex-wrap:wrap"><span>Map level</span>${alts}</div><div class="pad">`;
    if (!w) return html + `<p class="note">${state.windsError ? "Winds aloft unavailable right now." : "Loading winds aloft…"}</p></div>`;
    html += `<p class="note" style="margin-top:0">NWS FD forecast valid ${esc(w.valid || "—")}${w.use ? `, for use ${esc(w.use)}` : ""} · based on ${esc(w.based || "—")} data · ${w.stations.length} stations. Barbs on the map show the selected level.</p>`;
    const ref = state.station && state.metarIndex[state.station];
    const near = ref ? nearestFd(ref.lat, ref.lon) : null;
    if (near) {
      html += `<h5 class="sub">Nearest to ${esc(state.station)}: ${esc(near.st.id)} · ${Math.round(near.d / 1.852)} nm away</h5>
        <table class="t"><thead><tr><th>Altitude</th><th>Wind</th><th>Temp</th></tr></thead><tbody>${FD_ALTS.map((a) =>
          `<tr${a === state.windAlt ? ' style="background:rgba(74,209,255,.07)"' : ""}><td>${altLabel(a)}</td><td>${windText(near.st.levels[a])}</td><td>${tempText(near.st.levels[a])}</td></tr>`).join("")}</tbody></table>
        <p class="note">Blank levels are within 1,500 ft of the station (no wind) or 2,500 ft (no temperature).</p>`;
    } else {
      html += `<p class="note">Select an airport (Airports tab or the map) to see the full column at the nearest forecast station.</p>`;
    }
    return html + `</div>`;
  }

  // —— Route briefing ———————————————————————————————————————————————————
  const NM = 1.852;   // km per nautical mile
  function routeView() {
    const r = state.route;
    const width = r?.nm || 50;
    let html = `<form class="search" id="routeForm"><input id="routeQ" placeholder="Route, e.g. KMIA KATL KORD" aria-label="Route airports" autocomplete="off" value="${esc(r?.text || "")}" /><button class="btn btn--secondary">Brief</button></form>
      <div class="satpick" style="padding:0 1.25rem"><span>Corridor</span>${[25, 50, 100].map((nm) => `<button data-cor="${nm}" aria-pressed="${width === nm}">±${nm} nm</button>`).join("")}</div>`;
    if (!r) return html + `<p class="empty">Enter two or more airports, separated by spaces, to see METARs, TAFs, advisories, PIREPs and winds aloft along the route.</p>`;
    if (r.error) return html + `<p class="empty">${esc(r.error)}</p>`;
    const cats = Object.fromEntries(Object.keys(FC).map((k) => [k, r.metars.filter((m) => m.flight_category === k).length]));
    const lowCat = r.metars.filter((m) => /IFR/.test(m.flight_category || ""));
    html += `<div class="pad"><h5 class="sub">${esc(r.ids.join(" → "))} · ${Math.round(r.lengthKm / NM).toLocaleString()} nm</h5>
      <table class="t"><thead><tr><th>Airport</th><th>Now</th><th>Worst in TAF, next 12 h</th></tr></thead><tbody>${r.points.map((pt) => {
        const m = state.metarIndex[pt.id];
        const worst = pt.taf ? worstTaf(pt.taf, 12) : null;
        return `<tr data-ll="${pt.lat},${pt.lon}"><td><b style="color:#fff">${esc(pt.id)}</b><small>${m ? `METAR ${hhmmZ(m.observation_time)}` : ""}</small></td>
          <td><span class="fc" style="background:${fcColor(m?.flight_category)}">${esc(m?.flight_category || "—")}</span><small>${m ? (m.wind_speed_kt === 0 ? "Calm" : `${m.winddir ?? "VRB"}° ${m.wind_speed_kt}${m.wind_gust_kt ? `G${m.wind_gust_kt}` : ""} kt`) : ""}</small></td>
          <td>${worst ? `<span class="fc" style="background:${fcColor(worst.cat)}">${worst.cat}</span><small>from ${ddhhZ(Math.max(worst.from, Date.now()))}${worst.wx ? ` · ${esc(worst.wx)}` : ""}</small>` : pt.taf === null ? "No TAF" : "Loading…"}</td></tr>`;
      }).join("")}</tbody></table>
      <h5 class="sub">METARs within ±${r.nm} nm · ${r.metars.length}</h5>
      <div class="counts">${Object.entries(FC).map(([k, c]) => `<div style="color:${c}">${cats[k]}<small>${k}</small></div>`).join("")}</div>
      ${lowCat.length ? `<table class="t"><tbody>${lowCat.slice(0, 20).map((m) => `<tr data-ll="${m.lat},${m.lon}"><td><b style="color:#fff">${esc(m.station_id)}</b><small>${Math.round(m.along / NM)} nm along</small></td>
        <td><span class="fc" style="background:${fcColor(m.flight_category)}">${esc(m.flight_category)}</span><small>${m.ceiling_ft ? `ceiling ${m.ceiling_ft.toLocaleString()} ft · ` : ""}${esc(m.visibility_statute_mi ?? "—")} sm${m.wx_string ? ` · ${esc(m.wx_string)}` : ""}</small></td></tr>`).join("")}</tbody></table>` : ""}
      <h5 class="sub">Advisories crossing the route · ${r.advisories.length}</h5>
      ${r.advisories.map((a) => `<p class="note" style="margin:.2rem 0"><i class="dot" style="background:${a.color}"></i><b style="color:#fff">${esc(a.title)}</b><br>${esc(a.detail)}</p>`).join("") || `<p class="note">None of the advisories shown on the map cross the corridor.</p>`}
      <h5 class="sub">PIREPs in the corridor, moderate or greater · ${r.pireps.length}</h5>
      ${r.pireps.length ? `<table class="t"><tbody>${r.pireps.slice(0, 20).map((p) => `<tr data-ll="${p.lat},${p.lon}"><td>${hhmmZ(p.observation_time)}</td><td>${p.kind === "ice" ? "Icing" : p.kind === "llws" ? "Wind shear" : "Turbulence"} ${esc(pirepIntensity(p) || "")}<small>${esc(p.aircraft_ref || "")} · ${p.altitude_ft_msl ? ftToFl(p.altitude_ft_msl) : "FL?"}</small></td></tr>`).join("")}</tbody></table>` : `<p class="note">None reported.</p>`}
      <h5 class="sub">Winds aloft along the route · ${altLabel(state.windAlt)}</h5>
      ${r.winds.length ? `<p class="note" style="margin-top:0;font-family:var(--mono)">${r.winds.map((w) => `${esc(w.id)} ${w.lv.lv ? "LV" : `${String(w.lv.dir).padStart(3, "0")}/${w.lv.spd}`}`).join(" · ")}</p><p class="note">Change the level in the Winds aloft tab.</p>` : `<p class="note">${state.winds ? "No forecast stations in the corridor at this level." : "Loading…"}</p>`}
      </div>`;
    return html;
  }

  function worstTaf(taf, hours) {
    const now = Date.now(), end = now + hours * 3600e3;
    const order = ["VFR", "MVFR", "IFR", "LIFR"];
    // A period applies until the next prevailing (FM or initial) group begins.
    return taf.periods.filter((p, i) => {
      const next = taf.periods.slice(i + 1).find((q) => q.type === "FM" || q.type === "Initial");
      return p.from <= end && (next ? next.from : Infinity) > now;
    }).reduce((w, p) => (!w || order.indexOf(p.cat) > order.indexOf(w.cat) ? p : w), null);
  }

  // Distance (km) from a point to the route polyline, and how far along the route the closest point lies.
  function routeDistance(route, lat, lon) {
    const kx = Math.cos((lat * Math.PI) / 180) * 111.32, ky = 110.57;
    let best = { d: Infinity, along: 0 }, acc = 0;
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i], b = route[i + 1];
      const ax = (a.lon - lon) * kx, ay = (a.lat - lat) * ky, bx = (b.lon - lon) * kx, by = (b.lat - lat) * ky;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (len * len))) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.d) best = { d, along: acc + t * len };
      acc += len;
    }
    best.total = acc;
    return best;
  }

  function parseRoute(text) {
    return text.toUpperCase().split(/[\s,>]+|-(?=\w)/).filter(Boolean)
      .map((id) => (/^[A-Z0-9]{3}$/.test(id) && state.metarIndex[`K${id}`] ? `K${id}` : id));
  }

  async function briefRoute(text, nm) {
    const ids = parseRoute(text);
    const points = ids.map((id) => (state.metarIndex[id] ? { id, lat: state.metarIndex[id].lat, lon: state.metarIndex[id].lon, taf: undefined } : null));
    const missing = ids.filter((id, i) => !points[i]);
    history.replaceState(null, "", `?view=route&route=${encodeURIComponent(ids.join(" "))}&w=${nm}`);
    layers.route.clearLayers();
    if (ids.length < 2 || missing.length) {
      state.route = { text, nm, error: ids.length < 2 ? "Enter at least two airports." : `No current METAR for ${missing.join(", ")}, so its position isn't known. Use ICAO identifiers such as KATL.` };
      render();
      return;
    }
    const km = nm * NM;
    const lengthKm = routeDistance(points, points[0].lat, points[0].lon).total;
    const metars = state.metars.map((m) => ({ ...m, ...routeDistance(points, m.lat, m.lon) })).filter((m) => m.d <= km).sort((a, b) => a.along - b.along);
    // An advisory crosses the corridor if the route passes through it or any of its vertices lies in the corridor.
    const samples = [];
    for (let i = 0; i + 1 < points.length; i++) for (let f = 0; f <= 1; f += 0.02) samples.push([points[i].lon + (points[i + 1].lon - points[i].lon) * f, points[i].lat + (points[i + 1].lat - points[i].lat) * f]);
    const crosses = (geom) => {
      if (!geom) return false;
      if (samples.some((pt) => contains(geom, pt))) return true;
      const rings = geom.type === "Polygon" ? geom.coordinates : geom.type === "MultiPolygon" ? geom.coordinates.flat() : geom.type === "LineString" ? [geom.coordinates] : [];
      return rings.some((ring) => ring.some(([x, y]) => routeDistance(points, y, x).d <= km));
    };
    const plain = (s) => String(s).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
    const advisories = [];
    if (state.on.sigmets) advisoryItems().filter((it) => shown(it) && crosses(it.f.geometry)).forEach((it) => {
      advisories.push({ title: `${it.kind} · ${it.hazard}`, color: it.color, detail: advRows(it).filter(([k]) => k !== "Hazard").map(([k, v]) => `${k} ${plain(v)}`).join(" · ") });
    });
    if (state.on.gairmets) (state.gairmets?.features || []).filter((f) => state.gairmetOn[f.properties.hazard] && crosses(f.geometry)).forEach((f) => {
      const p = f.properties;
      const [c, name] = GAIRMET[p.hazard] || ["#9aa3c0", p.hazard];
      advisories.push({ title: `G-AIRMET ${GAIRMET_SERIES[SERIES_OF[p.hazard]]?.[0] || ""} · ${name} (+${p.forecast} h)`, color: c, detail: gairRows(p).filter(([k]) => k !== "Issued").map(([k, v]) => `${k} ${plain(v)}`).join(" · ") });
    });
    const pireps = state.pireps.filter((p) => (p.kind === "llws" || (INTENSITY[pirepIntensity(p)] ?? 0) >= 3) && routeDistance(points, p.lat, p.lon).d <= km);
    state.route = { text: ids.join(" "), nm, ids, points, lengthKm, metars, advisories, pireps, get winds() { return routeWinds(points, km); } };

    const line = points.map((pt) => [pt.lat, pt.lon]);
    const corridor = Math.max(4, (km * 1000) / (40075016 * Math.cos((points[0].lat * Math.PI) / 180) / 2 ** (map.getZoom() + 8)) * 2);
    L.polyline(line, { pane: "route", color: "#4ad1ff", weight: corridor, opacity: 0.1, lineCap: "round", lineJoin: "round", interactive: false, className: "corridor" }).addTo(layers.route);
    L.polyline(line, { pane: "route", color: "#4ad1ff", weight: 2.5, opacity: 0.95, interactive: false }).addTo(layers.route);
    points.forEach((pt) => L.circleMarker([pt.lat, pt.lon], { pane: "route", radius: 5, color: "#fff", weight: 2, fillColor: "#4ad1ff", fillOpacity: 1, interactive: false })
      .bindTooltip(pt.id, { permanent: true, direction: "right", offset: [8, 0], className: "tw-label" }).addTo(layers.route));
    state.view = "route";
    setTabs();
    render();
    map.fitBounds(L.latLngBounds(line).pad(0.15), { animate: false });
    await Promise.all(points.map(async (pt) => { pt.taf = await loadTaf(pt.id).catch(() => null); if (state.view === "route" && state.route?.points === points) render(); }));
  }

  function routeWinds(points, km) {
    return (state.winds?.stations || []).map((w) => ({ ...w, ...routeDistance(points, w.lat, w.lon), lv: w.levels[state.windAlt] }))
      .filter((w) => w.d <= km && w.lv).sort((a, b) => a.along - b.along);
  }

  // Keep the corridor band the right width in pixels as the map zooms.
  map.on("zoomend", () => {
    const r = state.route;
    if (!r?.points) return;
    layers.route.eachLayer((l) => {
      if (l.options.className !== "corridor") return;
      const km = r.nm * NM;
      l.setStyle({ weight: Math.max(4, (km * 1000) / (40075016 * Math.cos((r.points[0].lat * Math.PI) / 180) / 2 ** (map.getZoom() + 8)) * 2) });
    });
  });


  function airportsView() {
    const counts = Object.fromEntries(Object.keys(FC).map((k) => [k, state.metars.filter((m) => m.flight_category === k).length]));
    const m = state.station && state.metarIndex[state.station];
    let html = `<form class="search" id="search"><input id="q" placeholder="ICAO, e.g. KMIA" aria-label="Airport identifier" autocomplete="off" value="${esc(state.station || "")}" /><button class="btn btn--secondary">Show</button></form>
      <div class="pad"><h5 class="sub">Flight categories now · ${state.metars.length} stations</h5>
      <div class="counts">${Object.entries(FC).map(([k, c]) => `<div style="color:${c}">${counts[k]}<small>${k}</small></div>`).join("")}</div>`;
    if (state.station && !m) html += `<p class="note">No current METAR for <b>${esc(state.station)}</b>.</p>`;
    if (m) {
      // Show the NWS API's report when it's newer than the map service's (the decoded fields stay from AWC).
      const latest = (state.nws || []).filter((o) => o.raw).slice(-1)[0];
      const newer = latest && latest.t > m.observation_time + 60000 ? latest : null;
      const wind = m.wind_speed_kt === 0 ? "Calm" : `${m.winddir ?? "VRB"}° ${m.wind_speed_kt}${m.wind_gust_kt ? ` gust ${m.wind_gust_kt}` : ""} kt`;
      html += `<h5 class="sub">${esc(m.station_id)} · METAR ${ddhhZ(newer ? newer.t : m.observation_time)} · ${ago(newer ? newer.t : m.observation_time)}</h5>
        <div class="raw">${esc(newer ? newer.raw : m.raw_text)}</div>
        ${newer ? `<p class="note" style="margin:.3rem 0 0">Newest report from the NWS API; the decoded values below are from ${hhmmZ(m.observation_time)}.</p>` : ""}
        <dl class="kv"><dt>Category</dt><dd><span class="fc" style="background:${fcColor(m.flight_category)}">${esc(m.flight_category || "—")}</span></dd>
          <dt>Wind</dt><dd>${esc(wind)}</dd><dt>Visibility</dt><dd>${esc(m.visibility_statute_mi ?? "—")} sm</dd>
          <dt>Ceiling</dt><dd>${m.ceiling_ft ? `${m.ceiling_ft.toLocaleString()} ft` : m.vert_vis_ft ? `VV ${m.vert_vis_ft} ft` : "None"}</dd>
          <dt>Weather</dt><dd>${esc(m.wx_string || "—")}</dd><dt>Temp / dew</dt><dd>${m.temp_c ?? "—"}° / ${m.dewpoint_c ?? "—"}° C</dd>
          <dt>Altimeter</dt><dd>${m.altim_in_hg ? `${m.altim_in_hg.toFixed(2)} inHg` : "—"}</dd></dl>`;
      if (state.nws) html += historyChart(state.nws);
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
    const add = (o) => { o.haz = hazOf(o.rawHazard); o.color = HAZ[o.haz][1]; items.push(o); };
    (state.sigmets?.features || []).forEach((f, i) => {
      const p = f.properties;
      const airmet = p.airsigmet_type === "AIRMET";
      add({ key: `s${i}`, f, prod: airmet ? "AIRMET" : "SIGMET", kind: airmet ? "AIRMET" : /CONVECTIVE/.test(p.hazard) ? "Convective SIGMET" : "SIGMET",
        rawHazard: p.hazard, hazard: p.hazard, sev: p.severity, from: p.valid_time_from, to: p.valid_time_to, text: p.raw_text });
    });
    (state.cwas?.features || []).forEach((f, i) => {
      const p = f.properties;
      add({ key: `c${i}`, f, prod: "CWA", kind: "CWA", rawHazard: p.hazard, hazard: `${p.hazard}${p.qualifier ? ` · ${p.qualifier}` : ""}`, from: awcTime(p.validtimef), to: awcTime(p.validtimet), text: p.cwatext, place: `${p.cwsu} ${p.name}` });
    });
    (state.isigmets?.features || []).forEach((f, i) => {
      const p = f.properties;
      add({ key: `i${i}`, f, prod: "ISIGMET", kind: "International SIGMET", rawHazard: p.hazard, hazard: `${p.hazard}${p.qualifier ? ` · ${p.qualifier}` : ""}`, from: awcTime(p.validtimef), to: awcTime(p.validtimet), text: p.rawsigmet, place: p.firname });
    });
    return items;
  }
  const shown = (it) => !!state.advOn[`${it.prod}|${it.haz}`];
  // Color shows the hazard; line style shows the product.
  const LINE = { SIGMET: [2.4, null], AIRMET: [1.8, "8 4"], CWA: [1.8, "6 4"], ISIGMET: [1.4, "1 4"] };

  function drawAdvisories() {
    layers.sigmets.clearLayers(); layers.gairmets.clearLayers(); layers.tcf.clearLayers();
    for (const it of advisoryItems()) {
      if (!shown(it)) continue;
      L.geoJSON(it.f, { pane: "sigmet", style: { color: it.color, weight: LINE[it.prod][0], dashArray: LINE[it.prod][1], lineCap: "round", fillColor: it.color, fillOpacity: it.prod === "ISIGMET" ? 0.04 : 0.08 } })
        .bindTooltip(`${esc(it.kind)} · ${esc(it.hazard)} — click for details`, { className: "tw-tip", sticky: true })
        .addTo(layers.sigmets);
    }
    (state.gairmets?.features || []).forEach((f) => {
      const p = f.properties;
      if (!state.gairmetOn[p.hazard]) return;
      const [c, name] = GAIRMET[p.hazard] || ["#9aa3c0", p.hazard];
      L.geoJSON(f, { pane: "gairmet", style: { color: c, weight: 1.2, dashArray: /FZLVL/.test(p.hazard) ? "2 4" : null, fillColor: c, fillOpacity: 0.12 } })
        .bindTooltip(`G-AIRMET ${esc(GAIRMET_SERIES[SERIES_OF[p.hazard]]?.[0] || "")} · ${esc(name)} — click for details`, { className: "tw-tip", sticky: true })
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
    const check = (attr, key, on, color, label, n) =>
      `<label${n ? "" : ' style="opacity:.45"'}><input type="checkbox" ${attr}="${key}" ${on ? "checked" : ""} ${n ? "" : "disabled"} /><i class="dot" style="background:${color}"></i>${esc(label)} <b class="n">${n}</b></label>`;
    let html = `<div class="pad">`;
    for (const [prod, [label, hazards]] of Object.entries(ADV_PRODUCTS)) {
      const mine = items.filter((i) => i.prod === prod);
      if (prod === "AIRMET" && !mine.length) continue;   // text AIRMETs rarely appear; G-AIRMETs below replace them
      html += `<h5 class="sub">${esc(label)} <span class="all"><a href="#" data-allprod="${prod}" data-mode="on">All</a> · <a href="#" data-allprod="${prod}" data-mode="off">None</a></span></h5><div class="checks">${hazards.map((h) =>
        check("data-adv", `${prod}|${h}`, state.advOn[`${prod}|${h}`], HAZ[h][1], HAZ[h][0], mine.filter((i) => i.haz === h).length)).join("")}</div>`;
    }
    for (const [series, [name, hazards]] of Object.entries(GAIRMET_SERIES)) {
      html += `<h5 class="sub">G-AIRMET ${name}</h5><div class="checks">${hazards.map((h) => check("data-gair", h, state.gairmetOn[h], GAIRMET[h][0], GAIRMET[h][1], gcount(h))).join("")}</div>`;
    }
    html += `${gvalid ? `<p class="note">G-AIRMETs valid ${esc(String(gvalid).slice(8, 10))}/${esc(String(gvalid).slice(11, 13))}${esc(String(gvalid).slice(14, 16))}Z. Click any area on the map for details.</p>` : ""}</div>`;
    for (const [prod, [label]] of Object.entries(ADV_PRODUCTS)) {
      const list = items.filter((i) => i.prod === prod && shown(i));
      if (!list.length) continue;
      html += `<div class="group open"><div class="row" style="cursor:default"><i class="sw" style="background:#9aa3c0"></i><span class="name">${esc(label)}</span><span class="num">${list.length}</span></div>
        ${list.map((it) => `<div class="alert${state.selected === it.key ? " sel" : ""}">
          <button class="row" data-advkey="${it.key}"><span class="name"><i class="dot" style="background:${it.color}"></i>${esc(it.hazard)}${it.sev ? ` · ${esc(it.sev)}` : ""}<small>${esc(it.place || "")}</small></span><span class="num">${ddhhZ(it.from)}–${hhmmZ(it.to)}</span></button>
          ${state.selected === it.key ? `<div class="alert__body">${advDetailsTable(it)}<pre>${esc(it.text)}</pre></div>` : ""}</div>`).join("")}</div>`;
    }
    if (!items.length) html += `<p class="empty">No SIGMETs or CWAs in effect.</p>`;
    return html;
  }

  // —— Advisory details (sidebar and map popups) ——————————————————————
  const fl = (v) => { const t = String(v ?? "").trim(); return !t ? "" : /^\d+$/.test(t) ? (+t === 0 ? "SFC" : `FL${t.padStart(3, "0")}`) : t; };
  const ftToFl = (ft) => (ft == null || ft === "" ? "" : +ft === 0 ? "SFC" : `FL${String(Math.round(+ft / 100)).padStart(3, "0")}`);

  function advRows(it) {
    const p = it.f.properties;
    const alt = it.kind === "International SIGMET" ? [fl(p.base), fl(p.top)] : [ftToFl(p.min_ft_msl), ftToFl(p.max_ft_msl)];
    const move = p.movement_speed_kt ? `${p.movement_dir_degrees ?? ""}° ${p.movement_speed_kt} kt` : p.spd && p.spd.trim() ? `${p.dir} ${p.spd} kt${p.chng && p.chng.trim() ? ` · ${p.chng}` : ""}` : "";
    return [
      ["Hazard", `${esc(it.hazard)}${it.sev && String(it.sev).trim() ? ` · ${esc(it.sev)}` : ""}`],
      ["Valid", `${ddhhZ(it.from)} – ${ddhhZ(it.to)}`],
      // Spell out one-sided ranges so a lone top isn't read as a single level.
      ["Altitude", esc(alt[0] && alt[1] ? `${alt[0]} – ${alt[1]}` : alt[1] ? `up to ${alt[1]}` : alt[0] ? `${alt[0]} and above` : "")],
      ["Movement", esc(move)],
      ["Area", esc(it.place || "")],
    ].filter(([, v]) => v);
  }
  function advDetailsTable(it) {
    return `<dl class="kv">${advRows(it).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }

  function gairRows(p) {
    const base = fl(p.base), top = fl(p.top);
    const alt = /FZLVL/.test(p.hazard) ? (base || top ? `Freezing level ${[base, top].filter(Boolean).join(" – ")}` : "") : [base || (top ? "SFC" : ""), top].filter(Boolean).join(" – ");
    return [
      ["Severity", esc(String(p.severity || "").trim())],
      ["Due to", esc(String(p.dueto || "").trim())],
      ["Altitude", esc(alt)],
      ["Valid", `${esc(String(p.validtime).slice(8, 10))}/${esc(String(p.validtime).slice(11, 13))}${esc(String(p.validtime).slice(14, 16))}Z (+${esc(p.forecast)} h)`],
      ["Issued", `${esc(String(p.issuetime).slice(8, 10))}/${esc(String(p.issuetime).slice(11, 13))}${esc(String(p.issuetime).slice(14, 16))}Z`],
    ].filter(([, v]) => v);
  }

  // Point-in-polygon for GeoJSON Polygon/MultiPolygon ([lon, lat] rings).
  function inRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function contains(geom, pt) {
    if (!geom) return false;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
    return polys.some((rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h)));
  }

  // Click anywhere: list every visible SIGMET, AIRMET, CWA and G-AIRMET covering that point.
  map.on("click", (e) => {
    const pt = [e.latlng.lng, e.latlng.lat];
    const parts = [];
    if (state.on.sigmets) {
      advisoryItems().filter((it) => shown(it) && contains(it.f.geometry, pt)).forEach((it) => {
        parts.push(`<h4><span class="dot" style="background:${it.color}"></span>${esc(it.kind === "AIRMET" ? "AIRMET" : it.kind)}</h4>
          <table>${advRows(it).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>
          <details><summary>Full text</summary><pre>${esc(it.text)}</pre></details>
          <p><a href="#" data-showadv="${it.key}">Show in Advisories</a></p>`);
      });
    }
    if (state.on.gairmets) {
      (state.gairmets?.features || []).filter((f) => state.gairmetOn[f.properties.hazard] && contains(f.geometry, pt)).forEach((f) => {
        const p = f.properties;
        const [c, name] = GAIRMET[p.hazard] || ["#9aa3c0", p.hazard];
        parts.push(`<h4><span class="dot" style="background:${c}"></span>G-AIRMET ${esc(GAIRMET_SERIES[SERIES_OF[p.hazard]]?.[0] || p.product)} · ${esc(name)}</h4>
          <table>${gairRows(p).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`);
      });
    }
    if (state.on.tcf) {
      (state.tcf?.features || []).filter((f) => +f.properties.coverage > 0 && contains(f.geometry, pt)).forEach((f) => {
        const p = f.properties;
        parts.push(`<h4><span class="dot" style="background:#ff7ab8"></span>Convective forecast (TCF)</h4><table><tr><td>Forecast</td><td>${esc(p.fcst_hr)} · valid ${esc(String(p.validtime).slice(9, 13))}Z</td></tr>
          <tr><td>Confidence</td><td>${esc(p.confidnce)}</td></tr><tr><td>Tops</td><td>${esc(p.data || "")}</td></tr></table>`);
      });
    }
    if (!parts.length) return;
    L.popup({ maxWidth: 380, className: "adv-pop" }).setLatLng(e.latlng).setContent(parts.join("<hr>")).openOn(map);
  });
  map.on("popupopen", (e) => {
    e.popup.getElement().querySelectorAll("[data-showadv]").forEach((a) => {
      a.onclick = (ev) => {
        ev.preventDefault();
        state.view = "advisories"; state.selected = a.dataset.showadv; setTabs(); render();
        document.querySelector(".alert.sel")?.scrollIntoView({ block: "nearest" });
      };
    });
  });

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
    const views = { airports: airportsView, route: routeView, advisories: advisoriesView, pireps: pirepsView, winds: windsView };
    $("panel").innerHTML = (views[state.view] || airportsView)();
  }
  $("views").addEventListener("click", (e) => { const v = e.target.closest("[data-view]")?.dataset.view; if (v) { state.view = v; setTabs(); render(); if (v === "winds") showWinds(); } });

  // Opening the Winds aloft tab turns on the barbs.
  function showWinds() {
    if (state.on.winds) return;
    state.on.winds = true;
    document.querySelector('[data-layer="winds"]').checked = true;
    layers.winds.addTo(map);
  }

  $("panel").addEventListener("submit", (e) => {
    if (e.target.id === "routeForm") { e.preventDefault(); briefRoute($("routeQ").value, state.route?.nm || 50); return; }
    if (e.target.id !== "search") return;
    e.preventDefault();
    let id = $("q").value.trim().toUpperCase();
    if (/^[A-Z0-9]{3}$/.test(id) && state.metarIndex[`K${id}`]) id = `K${id}`;   // allow "MIA" for KMIA
    if (id) selectStation(id, true);
  });

  $("panel").addEventListener("click", (e) => {
    const t = e.target.closest("button, tr");
    if (!t) return;
    if (t.dataset.cor) {
      const text = state.route?.text || $("routeQ").value;
      if (text.trim()) briefRoute(text, +t.dataset.cor); else { state.route = null; render(); }
      return;
    }
    if (t.dataset.wfc && t.dataset.wfc !== state.windFcst) {
      state.windFcst = t.dataset.wfc; state.winds = null; render();
      loadWinds().then(render).catch(() => { state.windsError = true; render(); });
      return;
    }
    if (t.dataset.walt) { state.windAlt = t.dataset.walt; showWinds(); drawWinds(); render(); return; }
    if (t.dataset.advkey) {
      state.selected = state.selected === t.dataset.advkey ? null : t.dataset.advkey;
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

  // "All · None" next to each product heading.
  $("panel").addEventListener("click", (e) => {
    const el = e.target.closest("[data-allprod]");
    if (!el) return;
    e.preventDefault();
    const prod = el.dataset.allprod;
    const keys = ADV_PRODUCTS[prod][1].map((h) => `${prod}|${h}`);
    const turnOn = el.dataset.mode === "on";
    keys.forEach((k) => { state.advOn[k] = turnOn; });
    if (turnOn && !state.on.sigmets) { state.on.sigmets = true; document.querySelector('[data-layer="sigmets"]').checked = true; layers.sigmets.addTo(map); }
    drawAdvisories();
    render();
  });

  $("panel").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.adv) state.advOn[t.dataset.adv] = t.checked;
    else if (t.dataset.gair) state.gairmetOn[t.dataset.gair] = t.checked;
    else return;
    // Turning on any advisory type also turns on its map layer.
    const layerKey = t.dataset.gair ? "gairmets" : "sigmets";
    if (t.checked && !state.on[layerKey]) { state.on[layerKey] = true; document.querySelector(`[data-layer="${layerKey}"]`).checked = true; layers[layerKey].addTo(map); }
    drawAdvisories();
    render();
  });

  // —— Satellite (NOAA nowCOAST GOES, 5-minute imagery for the US domain) ——————
  async function loadSat() {
    const s = state.sat;
    if (s.kind === "off") { s.layer?.remove(); s.layer = null; $("satTime").textContent = ""; return; }
    const [name, label] = SAT[s.kind];
    try {
      const res = await fetch(`${NOWCOAST}/satellite/wms?service=WMS&version=1.3.0&request=GetCapabilities&_=${Math.floor(Date.now() / 120000)}`);
      const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
      const layer = [...xml.getElementsByTagName("Layer")].find((l) => l.getElementsByTagName("Name")[0]?.textContent === name);
      const time = [...(layer?.getElementsByTagName("Dimension") || [])].find((d) => d.getAttribute("name") === "time")?.getAttribute("default");
      if (state.sat.kind !== s.kind || (time && time === s.time && s.layer)) return;
      const next = L.tileLayer.wms(`${NOWCOAST}/satellite/wms`, { layers: name, format: "image/png", transparent: true, version: "1.3.0", ...(time ? { time } : {}), pane: "sat", opacity: 0.7, tileSize: 512, attribution: "" });
      next.once("load", () => { if (s.layer && s.layer !== next) s.layer.remove(); s.layer = next; });
      next.addTo(map);
      if (!s.layer) s.layer = next;
      s.time = time;
      $("satTime").textContent = time ? `${label} ${hhmmZ(time)}` : label;
    } catch {
      $("satTime").textContent = "unavailable";
    }
  }
  $("satpick").addEventListener("click", (e) => {
    const k = e.target.closest("[data-sat]")?.dataset.sat;
    if (!k) return;
    document.querySelectorAll("#satpick [data-sat]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sat === k));
    state.sat.kind = k;
    state.sat.layer?.remove(); state.sat.layer = null; state.sat.time = null;
    loadSat();
  });

  $("layers").addEventListener("change", (e) => {
    const k = e.target.dataset?.layer;
    if (!k) return;
    state.on[k] = e.target.checked;
    if (k === "radar") { loadRadar(true); return; }
    if (k === "winds" && e.target.checked && !state.winds) loadWinds().catch(() => {});
    e.target.checked ? layers[k].addTo(map) : layers[k].remove();
  });

  // —— Load & refresh ———————————————————————————————————————————————
  async function init() {
    loadRadar(true);
    loadSat();
    setStatus("Loading aviation weather…");
    // Show advisories and PIREPs as soon as they arrive; METARs take longest.
    const settle = (pr) => pr.then(() => { if (state.view !== "airports" || !linked) render(); });
    const res = await Promise.allSettled([loadMetars(), settle(loadAdvisories()), settle(loadPireps())]);
    // Winds aloft need METAR positions for the FD station identifiers.
    loadWinds().then(() => { if (["winds", "route"].includes(state.view)) render(); }).catch(() => { state.windsError = true; if (state.view === "winds") render(); });
    res.forEach((r) => { if (r.status === "rejected") console.error(r.reason); });
    setStatus(res[0].status === "rejected" ? "METARs unavailable — try again shortly" : "");
    const params = new URLSearchParams(location.search);
    const viewParam = params.get("view");
    if (["advisories", "pireps", "winds", "route"].includes(viewParam)) { state.view = viewParam; setTabs(); }
    if (viewParam === "winds") showWinds();
    if (viewParam === "route" && params.get("route")) briefRoute(params.get("route"), [25, 50, 100].includes(+params.get("w")) ? +params.get("w") : 50);
    else if (linked && state.metarIndex[linked]) selectStation(linked, true, true, state.view !== "airports");
    else { if (linked) map.fitBounds(CONUS); render(); }

    setInterval(() => loadMetars().then(() => { if (state.view === "airports") render(); }).catch(() => {}), 5 * 60000);
    setInterval(() => { loadAdvisories().then(() => { if (state.view === "advisories") render(); }).catch(() => {}); loadPireps().then(() => { if (state.view === "pireps") render(); }).catch(() => {}); }, 5 * 60000);
    setInterval(() => { if (!state.radar.timer) loadRadar(false); loadSat(); }, 4 * 60000);
    setInterval(() => loadWinds().then(() => { if (state.view === "winds") render(); }).catch(() => {}), 30 * 60000);
  }

  init();
})();
