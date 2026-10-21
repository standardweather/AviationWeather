# AviationWeather

Live aviation weather console for [Standard Weather](https://standardweather.github.io/AviationWeather/). Not for flight planning — use an official briefing. Everything loads in the browser from government sources:

- METAR flight categories, PIREPs, G-AIRMETs, SIGMETs, international SIGMETs, CWAs, TCF — NOAA Aviation Weather Center layers on NOAA map services
- US TAFs — NWS API (`api.weather.gov`, TAF products); other airports from the AWC TAF layer
- Radar mosaic loop — NOAA nowCOAST
- Temporary flight restrictions — FAA TFR list and shapes, collected into `site/data/tfr.json` by `tools/collect.py` (the FAA sends no CORS headers)
- Density altitude and runway crosswinds in each airport's METAR — field elevations and runways from OurAirports (public domain), in `site/data/airports.json`
- Model turbulence and icing — FutureWeather's GFS overlays for the hour nearest now
- Look back: the weather at up to six airports at a past UTC time — METARs and specials, the TAF in effect, SIGMETs, convective SIGMETs and G-AIRMETs over or near each airport, PIREPs within 100 nm and the NEXRAD composite on the map — from the Iowa Environmental Mesonet's archives (CORS-enabled), printable and as CSV

The page uses the shared theme at `/css/site.css` from the `standardweather.github.io` repo. Pushing to `main` deploys `site/` to GitHub Pages, and a half-hourly schedule reruns `tools/collect.py` so TFRs stay current.
