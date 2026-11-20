# AviationWeather

Live aviation weather console for [Standard Weather](https://standardweather.github.io/AviationWeather/). Not for flight planning — use an official briefing. Everything loads in the browser from government sources:

- METAR flight categories, PIREPs, G-AIRMETs, SIGMETs, international SIGMETs, CWAs, TCF — NOAA Aviation Weather Center layers on NOAA map services
- US TAFs — NWS API (`api.weather.gov`, TAF products); other airports from the AWC TAF layer. Each airport's TAF also draws as a flight-category timeline (prevailing groups on top, TEMPO, PROB and BECMG under them, to the end of the TAF or 30 hours), and the Route tab stacks one per airport on a shared time axis
- Radar mosaic loop — NOAA nowCOAST
- Temporary flight restrictions — FAA TFR list and shapes, collected into `site/data/tfr.json` by `tools/collect.py` (the FAA sends no CORS headers)
- Graphics with each airport's METAR: cloud layers and heights with the estimated freezing level, visibility and ceiling against the flight-category limits, the runways to scale with the wind and each runway end's headwind, tailwind and crosswind, temperature and dewpoint spread, and present weather in plain words
- Density altitude and runway winds — field elevations and runways (headings, lengths, widths and end positions) from OurAirports (public domain), in `site/data/airports.json`
- Model turbulence and icing — FutureWeather's GFS overlays for the hour nearest now
- Winds and temperatures aloft — GFS model winds at the old NWS FD bulletin points and levels (3,000 ft to FL390), 6, 12 or 24 hours ahead, written by FutureWeather's `make_airmetcast.py`. The NWS retired its US winds aloft bulletin along with the NAM, so this is model output, not an official forecast
- PIREP heatmap (PIREPs tab): turbulence or icing reports over the last 3, 6 or 12 hours, below or above FL180, summed into 1° cells by intensity, from the Iowa Environmental Mesonet's national PIREP archive (`pireps.py`, CORS-enabled)
- Look back: the weather at up to six airports at a past UTC time — METARs and specials, the TAF in effect, SIGMETs, convective SIGMETs and G-AIRMETs over or near each airport, PIREPs within 100 nm and the NEXRAD composite on the map — from the Iowa Environmental Mesonet's archives (CORS-enabled), printable and as CSV

The page uses the shared theme at `/css/site.css` from the `standardweather.github.io` repo. Pushing to `main` deploys `site/` to GitHub Pages, and a half-hourly schedule reruns `tools/collect.py` so TFRs stay current.
