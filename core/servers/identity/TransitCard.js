/**
 * core/servers/identity/TransitCard.js
 *
 * Pure rules for the owner's choices about the homestar's Transit card (the next
 * trains at one BART station). No database, no Express: the settings PUT and the
 * public GET /@:handle/transit in IdentityServer.js call these, so they can be
 * unit-tested on their own (tests/server/transit-card.test.js).
 *
 * Both choices live in the owner's private settings envelope, next to
 * `state.mapVisibility`, because the server applies them per viewer and a station
 * the owner keeps to friends must not sit in the public profile:
 *
 *   state.transitStation    = BART station code ('EMBR', '12TH', ...) or null for no card
 *   state.transitVisibility = 'anyone' | 'friends' | 'orbit' | 'private'
 *
 * Who may see the card uses MapVisibility.canView (same four choices, same friend /
 * orbit rule). A home station is a coarse location, so it gets the same gate as the
 * map. The server does not check the code against BART's list (that table is a
 * browser module); it only checks the shape, and the page ignores a code it does
 * not know.
 */

'use strict';

var mapVisibility = require('./MapVisibility');

// Station codes in lively.transit.BartData are 2 to 4 upper-case letters or digits
// ('12TH', 'EMBR'); a little room is left for new ones.
var STATION_RE = /^[A-Z0-9]{2,6}$/;

// Returns { value } or { error } for state.transitVisibility.
// undefined / null mean "never chosen" and become the default.
function normalizeVisibility(raw) {
  var r = mapVisibility.normalize(raw);
  if (r.error) return { error: 'transitVisibility must be one of ' + mapVisibility.VALUES.join(', ') };
  return r;
}

// Returns { value } (a code, or null for none) or { error } for state.transitStation.
function normalizeStation(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string' || !STATION_RE.test(raw)) return { error: 'transitStation must be a BART station code' };
  return { value: raw };
}

module.exports = {
  DEFAULT_VISIBILITY: mapVisibility.DEFAULT,
  normalizeVisibility: normalizeVisibility,
  normalizeStation: normalizeStation,
  canView: mapVisibility.canView
};
