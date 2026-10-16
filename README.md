# AviationWeather

Live aviation weather console for [Standard Weather](https://standardweather.github.io/AviationWeather/). Not for flight planning — use an official briefing. Everything loads in the browser from government sources:

- METAR flight categories, PIREPs, G-AIRMETs, SIGMETs, international SIGMETs, CWAs, TCF — NOAA Aviation Weather Center layers on NOAA map services
- US TAFs — NWS API (`api.weather.gov`, TAF products); other airports from the AWC TAF layer
- Radar mosaic loop — NOAA nowCOAST

The page uses the shared theme at `/css/site.css` from the `standardweather.github.io` repo. Pushing to `main` deploys `site/` to GitHub Pages.
