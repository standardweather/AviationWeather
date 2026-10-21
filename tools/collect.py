"""Collect the AviationWeather data that browsers can't fetch directly, into site/data/.

    tfr.json       active Temporary Flight Restrictions: shapes from the FAA TFR GeoServer joined to the
                   FAA's TFR list (type and description). Neither service sends CORS headers.
    airports.json  {ICAO: [field elevation, runways]}: elevation and runways (ends, true headings, length, width and
                   the ends' positions) for airports with a 4-letter identifier, from OurAirports' public-domain
                   data (too large to load in a browser), for density altitude, crosswinds and the runway diagram.

Standard library only. A source that fails leaves its previous file (if any) in place.

    python3 tools/collect.py
"""

import csv
import io
import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "site" / "data"
UA = {"User-Agent": "AviationWeather (standardweather.github.io)"}
TFR_LIST = "https://tfr.faa.gov/tfrapi/exportTfrList"
TFR_SHAPES = ("https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature"
              "&typeName=TFR:V_TFR_LOC&maxFeatures=2000&outputFormat=application/json&srsname=EPSG:4326")
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data"


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 ** (i + 1))


def tfrs():
    listing = {t["notam_id"]: t for t in json.loads(get(TFR_LIST))}
    shapes = json.loads(get(TFR_SHAPES))
    feats = []
    for f in shapes["features"]:
        p = f["properties"]
        nid = (p.get("NOTAM_KEY") or "").split("-")[0]
        info = listing.get(nid, {})
        feats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
            "id": nid, "type": info.get("type") or p.get("LEGAL") or "", "title": p.get("TITLE") or info.get("description") or "",
            "facility": p.get("CNS_LOCATION_ID") or info.get("facility") or "", "state": p.get("STATE") or info.get("state") or "",
            "link": f"https://tfr.faa.gov/tfr3/?page=detail_{nid.replace('/', '_')}" if nid else "https://tfr.faa.gov/",
        }})
    return {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "type": "FeatureCollection", "features": feats}


def airports():
    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    elev = {}
    for r in csv.DictReader(io.StringIO(get(f"{OURAIRPORTS}/airports.csv").decode("utf-8", "replace"))):
        ident = r["gps_code"] or r["ident"]
        if len(ident) == 4 and ident.isalnum() and r["type"] not in ("closed", "heliport", "balloonport"):
            elev[ident] = num(r["elevation_ft"])
    by_ref = {}
    ends = {}
    out = {}
    for r in csv.DictReader(io.StringIO(get(f"{OURAIRPORTS}/runways.csv").decode("utf-8", "replace"))):
        ident = r["airport_ident"]
        if ident not in elev or r["closed"] == "1" or not r["le_ident"] or r["le_ident"].startswith("H"):
            continue
        length = num(r["length_ft"])
        if length is not None and length < 1000:
            continue
        pos = [num(r[k]) for k in ("le_latitude_deg", "le_longitude_deg", "he_latitude_deg", "he_longitude_deg")]
        pos = pos if None not in pos and pos[:2] != pos[2:] else None
        hdg = num(r["le_heading_degT"])
        if hdg is None and pos:
            # True bearing from the low end to the high end.
            la1, lo1, la2, lo2 = map(math.radians, pos)
            hdg = math.degrees(math.atan2(math.sin(lo2 - lo1) * math.cos(la2),
                                          math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1))) % 360
        if hdg is None:
            digits = "".join(ch for ch in r["le_ident"] if ch.isdigit())
            if not digits:
                continue
            hdg = int(digits) * 10   # magnetic, from the runway number; close enough for a crosswind estimate
        width = num(r["width_ft"])
        by_ref.setdefault(ident, []).append([r["le_ident"], r["he_ident"], round(hdg) % 360, int(length) if length else None,
                                             int(width) if width else None, pos])
        if pos:
            ends.setdefault(ident, []).extend([pos[:2], pos[2:]])
    for ident, rwy in by_ref.items():
        # Runway ends as feet east and north of the middle of all the ends, for drawing the airport's layout.
        pts = ends.get(ident)
        if pts:
            lat0 = sum(p[0] for p in pts) / len(pts)
            lon0 = sum(p[1] for p in pts) / len(pts)
            k = 364567 * math.cos(math.radians(lat0))   # feet per degree of longitude; 364,567 per degree of latitude
            for rw in rwy:
                p = rw[5]
                rw[5] = [round((p[1] - lon0) * k), round((p[0] - lat0) * 364567), round((p[3] - lon0) * k), round((p[2] - lat0) * 364567)] if p else None
        out[ident] = [elev[ident], rwy]   # [field elevation ft, [[end, other end, heading °T, length ft, width ft, [x1, y1, x2, y2] ft or null], ...]]
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in (("tfr.json", tfrs), ("airports.json", airports)):
        try:
            data = fn()
            (OUT / name).write_text(json.dumps(data, separators=(",", ":")))
            print(f"wrote {name} ({(OUT / name).stat().st_size // 1024} KB)")
        except Exception as e:
            print(f"warning: {name}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
