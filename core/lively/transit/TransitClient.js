/**
 * lively.transit.TransitClient
 *
 * Client-side data access for the transit map: live BART predictions (via
 * TransitProxyServer.js, which holds the real 511.org API token
 * server-side) and current weather (via Open-Meteo, called directly —
 * open-meteo.com requires no API key and serves CORS on every response, so
 * it uses the same bare-fetch idiom as Musicpod.js's noembed calls, no
 * proxy needed).
 *
 * Until a real 511.org token is configured (see TransitProxyServer.js's
 * doc comment), the proxy responds 503 — every method here falls back to
 * clearly-labeled simulated data in that case (`simulated: true` on the
 * result) rather than silently showing nothing or fabricating "live" data
 * that isn't. Simulated arrival times are deterministic per
 * (station, line, 90-second bucket) so they count down smoothly and don't
 * jump around on repeated polls.
 */

module("lively.transit.TransitClient")
  .requires("lively.transit.BartData")
  .toRun(function () {

    // Subserver routes are mounted under /nodejs/<ServerFileName>/ by
    // life_star's default baseURL (node_modules/life_star/lib/subservers.js),
    // not at the root — confirmed live the hard way: this was originally
    // "/TransitProxyServer/" and 404'd with jsdav's WebDAV-flavored
    // FileNotFound XML even after a real server restart with a real API key
    // configured, exactly the misleading symptom CLAUDE.md's "brand-new
    // route 404ing" note warns about, except the actual cause here was a
    // wrong route prefix, not a stale process.
    var PROXY_BASE = "/nodejs/TransitProxyServer/";
    var SIM_CYCLE_MS = 14 * 60 * 1000; // simulated trains arrive on a ~14min cadence per line/station, in line with typical BART headways

    // Small stable hash so simulated countdowns are deterministic per
    // (station, line) rather than random-per-call.
    function stableHash(str) {
      var h = 0;
      for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
      return Math.abs(h);
    }

    function simulatedPredictionsFor(stationAbbr) {
      var lines = lively.transit.BartData.linesAt(stationAbbr);
      var now = Date.now();
      return lines.map(function (line) {
        var seed = stableHash(stationAbbr + "|" + line.key);
        var phase = (seed % SIM_CYCLE_MS);
        var msIntoCycle = (now + phase) % SIM_CYCLE_MS;
        var msUntilNext = SIM_CYCLE_MS - msIntoCycle;
        var lastStation = line.stations[line.stations.length - 1];
        return {
          line: line.label,
          lineKey: line.key,
          destination: lively.transit.BartData.stationName(lastStation),
          stopName: lively.transit.BartData.stationName(stationAbbr),
          expectedArrival: new Date(now + msUntilNext).toISOString(),
          minutesAway: Math.max(0, Math.round(msUntilNext / 60000)),
        };
      });
    }

    lively.transit.TransitClient = {

      // thenDo(err, { predictions: [...], simulated: bool })
      stopMonitoring: function (stationAbbr, thenDo) {
        var url = PROXY_BASE + "stop-monitoring?agency=" +
          encodeURIComponent(lively.transit.BartData.agency) +
          "&stopcode=" + encodeURIComponent(stationAbbr);
        fetch(url).then(function (res) {
          if (res.status === 503) return null; // not configured — fall back below
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (data) {
          if (!data) {
            return thenDo(null, { predictions: simulatedPredictionsFor(stationAbbr), simulated: true });
          }
          thenDo(null, { predictions: data.predictions || [], simulated: false });
        }).catch(function () {
          thenDo(null, { predictions: simulatedPredictionsFor(stationAbbr), simulated: true });
        });
      },

      // thenDo(err, { vehicles: [...], simulated: bool })
      // Simulated vehicles: one per line, interpolated along that line's
      // station sequence based on wall-clock time so they visibly move on
      // repeated polls, deterministic per line (no randomness).
      vehicleMonitoring: function (thenDo) {
        var url = PROXY_BASE + "vehicle-monitoring?agency=" + encodeURIComponent(lively.transit.BartData.agency);
        fetch(url).then(function (res) {
          if (res.status === 503) return null;
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (data) {
          if (!data) return thenDo(null, { vehicles: simulatedVehicles(), simulated: true });
          thenDo(null, { vehicles: data.vehicles || [], simulated: false });
        }).catch(function () {
          thenDo(null, { vehicles: simulatedVehicles(), simulated: true });
        });
      },

      // thenDo(err, { tempC, weatherCode, windKph, isDay, simulated: false })
      // San Francisco Bay Area default coordinates unless overridden.
      currentWeather: function (lat, lon, thenDo) {
        lat = lat || 37.7749; lon = lon || -122.4194;
        var url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
          "&current_weather=true&temperature_unit=celsius&windspeed_unit=kmh";
        fetch(url).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (data) {
          var cw = data && data.current_weather;
          if (!cw) throw new Error("no current_weather in response");
          thenDo(null, {
            tempC: cw.temperature,
            weatherCode: cw.weathercode,
            windKph: cw.windspeed,
            isDay: cw.is_day === 1,
            simulated: false,
          });
        }).catch(function (err) { thenDo(err); });
      },

    };

    // ─── simulated vehicle positions (module-private helper) ──────────────────

    function simulatedVehicles() {
      var now = Date.now();
      var vehicles = [];
      lively.transit.BartData.lines.forEach(function (line) {
        if (line.stations.length < 2) return;
        var seed = stableHash(line.key);
        var legDurationMs = 20000; // 20s to "travel" between adjacent stations, for a visibly-moving demo
        var totalLegs = (line.stations.length - 1) * 2; // there-and-back loop
        var cyclePos = Math.floor(((now + seed) / legDurationMs)) % totalLegs;
        var t = (((now + seed) % legDurationMs) / legDurationMs);
        var goingForward = cyclePos < (line.stations.length - 1);
        var legIndex = goingForward ? cyclePos : (totalLegs - cyclePos - 1);
        var fromIdx = goingForward ? legIndex : legIndex + 1;
        var toIdx = goingForward ? legIndex + 1 : legIndex;
        var from = lively.transit.BartData.stations[line.stations[fromIdx]];
        var to = lively.transit.BartData.stations[line.stations[toIdx]];
        if (!from || !to) return;
        vehicles.push({
          vehicleId: "sim-" + line.key,
          line: line.label,
          lineKey: line.key,
          destination: lively.transit.BartData.stationName(
            goingForward ? line.stations[line.stations.length - 1] : line.stations[0]
          ),
          lat: from.lat + (to.lat - from.lat) * t,
          lon: from.lon + (to.lon - from.lon) * t,
          bearing: null,
        });
      });
      return vehicles;
    }

  }); // end module('lively.transit.TransitClient')
