/**
 * core/servers/TransitProxyServer.js
 *
 * Server-side proxy for the 511.org SF Bay Open Data real-time transit API
 * (StopMonitoring / VehicleMonitoring), used by the transit map morph
 * (lively.transit.TransitMapMorph / TransitClient.js). 511.org's API does
 * support CORS directly (Access-Control-Allow-Origin: * on GET responses),
 * so this proxy exists purely to keep the API token server-side rather than
 * shipping it to every browser — same rationale, and same shape, as
 * KlipyProxyServer.js.
 *
 * Key comes from (checked in this order):
 *   - process.env.TRANSIT_511_API_KEY
 *   - core/apis/511-api.json — { "apiKey": "..." }, gitignored, same
 *     placeholder-file pattern as core/apis/klipy-api.json.
 * If neither is set, the routes below respond 503 with a clear message
 * instead of throwing — TransitClient.js falls back to a clearly-labeled
 * simulated-data mode rather than erroring the whole map.
 *
 * Response normalization note: 511.org's real-time endpoints return the
 * SIRI standard's StopMonitoringDelivery/VehicleMonitoringDelivery shape
 * (ServiceDelivery.StopMonitoringDelivery[].MonitoredStopVisit[].Monitored-
 * VehicleJourney.{LineRef,DestinationName,MonitoredCall.{ExpectedArrival-
 * Time,...}}, and the VehicleMonitoring equivalent with VehicleLocation).
 * This was confirmed against the general SIRI spec and third-party sample
 * parsers, but NOT against a live 511.org response — no API token was
 * available while building this (see [[project convention]]: verify before
 * asserting). The normalizers below defensively handle both the
 * "delivery is a single object" and "delivery is a one-element array" SIRI
 * shapes, but should be re-checked against a real response once a token is
 * in place, the same caveat KlipyProxyServer.js left for its own response
 * shape.
 */

'use strict';

var https = require('https');
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');
var querystring = require('querystring');

var FETCH_TIMEOUT_MS = 8000;
var MAX_RESPONSE_BYTES = 1024 * 1024;
var API_HOST = 'api.511.org';

var apiKey = process.env.TRANSIT_511_API_KEY || null;
(function loadApiKeyFromConfigFile() {
  if (apiKey) return;
  try {
    var raw = fs.readFileSync(
      path.join(process.env.WORKSPACE_LK || process.cwd(), 'core/apis/511-api.json'),
      'utf8'
    );
    var parsed = JSON.parse(raw);
    if (parsed.apiKey && parsed.apiKey.indexOf('REPLACE_WITH') !== 0) {
      apiKey = parsed.apiKey;
    }
  } catch (e) { /* file missing or not yet filled in — stays unconfigured */ }
})();

// GET https://api.511.org/transit/<endpoint>?api_key=<key>&<query>&format=json
// Calls thenDo(err, parsedJson).
function transitRequest(endpoint, query, thenDo) {
  if (!apiKey) return thenDo(new Error('not-configured'));

  var qs = querystring.stringify(Object.assign({ api_key: apiKey, format: 'json' }, query));
  var reqPath = '/transit/' + endpoint + '?' + qs;

  var called = false;
  function done(err, data) {
    if (called) return;
    called = true;
    thenDo(err || null, data);
  }

  var req = https.get(
    { hostname: API_HOST, path: reqPath, timeout: FETCH_TIMEOUT_MS },
    function (res) {
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          return done(new Error('511.org response exceeded ' + MAX_RESPONSE_BYTES + ' bytes'));
        }
        chunks.push(chunk);
      });
      res.on('end', function () {
        var raw = Buffer.concat(chunks);
        // 511.org gzips its responses regardless of whether the request
        // sent an Accept-Encoding header (confirmed live: the raw body
        // starts with the gzip magic bytes 0x1f 0x8b) — Node's https
        // module does no automatic decompression, so this has to happen
        // explicitly before treating the body as UTF-8 text.
        try {
          if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw);
        } catch (e) {
          return done(new Error('Failed to gunzip 511.org response: ' + e.message));
        }
        // 511.org's JSON responses are UTF-8 with a leading BOM — strip it
        // before JSON.parse, which otherwise throws on the stray character.
        var bodyText = raw.toString('utf8').replace(/^﻿/, '');
        if (res.statusCode !== 200) {
          return done(new Error('511.org responded HTTP ' + res.statusCode + ': ' + bodyText.slice(0, 500)));
        }
        try {
          done(null, JSON.parse(bodyText));
        } catch (e) {
          done(new Error('Malformed JSON from 511.org: ' + e.message));
        }
      });
      res.on('error', function (err) { done(err); });
    }
  );
  req.on('timeout', function () { req.destroy(new Error('Timed out contacting 511.org')); });
  req.on('error', function (err) { done(err); });
}

// SIRI wraps most sub-objects in a one-element array in some feeds and as a
// bare object in others — normalize both to a plain array.
function asArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

// BART's real LineRef values look like "Orange-S" / "Yellow-N" (color name,
// dash, direction) — confirmed live against a real response. Extracting the
// color prefix gives the same key vocabulary as lively.transit.BartData's
// own line.key (YELLOW/ORANGE/RED/GREEN/BLUE/GREY), so the client can look
// up its own canonical label/color instead of showing 511's much more
// verbose PublishedLineName ("Richmond to Berryessa/North San Jose").
function lineKeyFromRef(lineRef) {
  return lineRef ? lineRef.split('-')[0].toUpperCase() : null;
}

// StopMonitoring's real root is ServiceDelivery directly; VehicleMonitoring's
// real root wraps that one level deeper in Siri — confirmed live, both
// against real responses, not assumed from spec alone (this pair of
// endpoints is NOT symmetric, despite looking like it should be).
function normalizeStopMonitoring(raw) {
  var delivery = raw && raw.ServiceDelivery && asArray(raw.ServiceDelivery.StopMonitoringDelivery)[0];
  var visits = delivery ? asArray(delivery.MonitoredStopVisit) : [];
  return visits.map(function (visit) {
    var mvj = visit.MonitoredVehicleJourney || {};
    var call = mvj.MonitoredCall || {};
    var expected = call.ExpectedArrivalTime || call.AimedArrivalTime || null;
    return {
      line: mvj.PublishedLineName || mvj.LineRef || '?',
      lineKey: lineKeyFromRef(mvj.LineRef),
      destination: mvj.DestinationName || '',
      stopName: call.StopPointName || '',
      expectedArrival: expected,
      minutesAway: expected ? Math.max(0, Math.round((new Date(expected) - Date.now()) / 60000)) : null,
    };
  });
}

function normalizeVehicleMonitoring(raw) {
  var serviceDelivery = raw && ((raw.Siri && raw.Siri.ServiceDelivery) || raw.ServiceDelivery);
  var delivery = serviceDelivery && asArray(serviceDelivery.VehicleMonitoringDelivery)[0];
  var activities = delivery ? asArray(delivery.VehicleActivity) : [];
  return activities.map(function (activity) {
    var mvj = activity.MonitoredVehicleJourney || {};
    var loc = mvj.VehicleLocation || {};
    return {
      vehicleId: mvj.VehicleRef || null,
      line: mvj.PublishedLineName || mvj.LineRef || '?',
      lineKey: lineKeyFromRef(mvj.LineRef),
      destination: mvj.DestinationName || '',
      lat: loc.Latitude != null ? parseFloat(loc.Latitude) : null,
      lon: loc.Longitude != null ? parseFloat(loc.Longitude) : null,
      bearing: mvj.Bearing != null ? parseFloat(mvj.Bearing) : null,
    };
  }).filter(function (v) { return v.lat != null && v.lon != null; });
}

function sendNotConfigured(res) {
  res.status(503).json({
    error: 'Live transit data is not configured yet — add a real 511.org API token to core/apis/511-api.json (or set TRANSIT_511_API_KEY).',
  });
}

module.exports = function (route, app) {

  app.get(route + 'stop-monitoring', function (req, res) {
    var agency = (req.query.agency || '').toString().slice(0, 20);
    var stopcode = (req.query.stopcode || '').toString().slice(0, 20);
    if (!agency || !stopcode) return res.status(400).json({ error: 'agency and stopcode are required' });
    transitRequest('StopMonitoring', { agency: agency, stopcode: stopcode }, function (err, data) {
      if (err) return err.message === 'not-configured' ? sendNotConfigured(res) : res.status(502).json({ error: String(err.message || err) });
      res.json({ predictions: normalizeStopMonitoring(data) });
    });
  });

  app.get(route + 'vehicle-monitoring', function (req, res) {
    var agency = (req.query.agency || '').toString().slice(0, 20);
    if (!agency) return res.status(400).json({ error: 'agency is required' });
    transitRequest('VehicleMonitoring', { agency: agency }, function (err, data) {
      if (err) return err.message === 'not-configured' ? sendNotConfigured(res) : res.status(502).json({ error: String(err.message || err) });
      res.json({ vehicles: normalizeVehicleMonitoring(data) });
    });
  });

  app.get(route, function (req, res) { res.end('TransitProxyServer is running!'); });
};
