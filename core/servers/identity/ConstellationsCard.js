/**
 * core/servers/identity/ConstellationsCard.js
 *
 * Pure rules for the owner's choices about the homestar's Constellations card. No
 * database, no Express: the settings PUT and the public membership listing in
 * IdentityServer.js call these, so they can be unit-tested on their own
 * (tests/server/constellations-card.test.js).
 *
 * Both choices live in the owner's private settings envelope, next to `state.orbit`
 * and `state.mapVisibility`, because the server applies them per viewer and a hidden
 * constellation's name must not sit in the public profile:
 *
 *   state.constellationsVisibility = 'anyone' | 'friends' | 'orbit' | 'private'
 *   state.constellationsHidden     = [constellation name, ...]   (never shown on the card)
 *
 * Who may see the card uses MapVisibility.canView (the same four choices and the same
 * friend / orbit rule); only the names of the state keys differ. This gates the card,
 * not the data: a public constellation's members are still readable on the
 * constellation itself.
 */

'use strict';

var mapVisibility = require('./MapVisibility');

var MAX_HIDDEN = 200;
// Same shape a constellation name is created with (ConstellationRegistry.isValidName
// also rejects reserved names; a hidden entry only needs to be a plausible name).
var NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Returns { value } or { error } for state.constellationsVisibility.
// undefined / null mean "never chosen" and become the default.
function normalizeVisibility(raw) {
  var r = mapVisibility.normalize(raw);
  if (r.error) return { error: 'constellationsVisibility must be one of ' + mapVisibility.VALUES.join(', ') };
  return r;
}

// Returns { hidden } (de-duplicated, in order) or { error } for state.constellationsHidden.
function normalizeHidden(raw) {
  if (raw === undefined || raw === null) return { hidden: [] };
  if (!Array.isArray(raw)) return { error: 'constellationsHidden must be an array of constellation names' };
  if (raw.length > MAX_HIDDEN) return { error: 'constellationsHidden holds at most ' + MAX_HIDDEN + ' names' };
  var seen = {}, out = [];
  for (var i = 0; i < raw.length; i++) {
    var n = raw[i];
    if (typeof n !== 'string' || !NAME_RE.test(n)) return { error: 'constellationsHidden entries must be constellation names' };
    if (!seen[n]) { seen[n] = true; out.push(n); }
  }
  return { hidden: out };
}

// The rows the card may show: everything the owner has not hidden.
// Returns { rows, hiddenCount }.
function applyHidden(rows, hidden) {
  var skip = {};
  (hidden || []).forEach(function (n) { skip[n] = true; });
  var kept = rows.filter(function (r) { return !skip[r.name]; });
  return { rows: kept, hiddenCount: rows.length - kept.length };
}

module.exports = {
  MAX_HIDDEN: MAX_HIDDEN,
  DEFAULT_VISIBILITY: mapVisibility.DEFAULT,
  normalizeVisibility: normalizeVisibility,
  normalizeHidden: normalizeHidden,
  applyHidden: applyHidden,
  canView: mapVisibility.canView
};
