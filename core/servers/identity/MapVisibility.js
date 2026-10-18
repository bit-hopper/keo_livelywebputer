/**
 * core/servers/identity/MapVisibility.js
 *
 * Pure rules for who may see a user's homestar map (the pins for their located
 * postcards). No database, no Express: the settings PUT and the located-postcards
 * listing in IdentityServer.js call these, so they can be unit-tested on their own
 * (tests/server/map-visibility.test.js).
 *
 * The choice lives in `state.mapVisibility` on the owner's private settings
 * envelope, next to `state.orbit`, so a Friends-only map is not readable by
 * everyone (`state` is server-readable on purpose, the server filters per viewer).
 *
 *   state.mapVisibility = 'anyone' | 'friends' | 'orbit' | 'private'
 *
 * It decides who gets the owner's located postcards from the map's listing
 * (GET /@:handle/postcards?hasLocation=1). It does not change who may read a card:
 * a public card's own `state.location` still travels with the card wherever the
 * card is shown, only the map is gated.
 */

'use strict';

var VALUES = ['anyone', 'friends', 'orbit', 'private'];
var DEFAULT = 'anyone';

// Returns { value } or { error } if `raw` is set to something unknown.
// undefined / null mean "never chosen" and become the default.
function normalize(raw) {
  if (raw === undefined || raw === null) return { value: DEFAULT };
  if (VALUES.indexOf(raw) === -1) return { error: 'mapVisibility must be one of ' + VALUES.join(', ') };
  return { value: raw };
}

// May viewerDid see the owner's map? The caller looks up friendship and orbit
// membership; this stays pure. The owner always may.
function canView(visibility, ownerDid, viewerDid, viewerIsFriend, viewerInOrbit) {
  if (viewerDid && viewerDid === ownerDid) return true;
  var v = VALUES.indexOf(visibility) === -1 ? DEFAULT : visibility;
  if (v === 'anyone') return true;
  if (!viewerDid) return false;
  if (v === 'friends') return !!viewerIsFriend;
  // Orbit members are always friends (Orbit.js), but a friendship that ended is
  // dropped from the orbit on read, so both are asked.
  if (v === 'orbit') return !!(viewerIsFriend && viewerInOrbit);
  return false;
}

module.exports = {
  VALUES: VALUES,
  DEFAULT: DEFAULT,
  normalize: normalize,
  canView: canView
};
