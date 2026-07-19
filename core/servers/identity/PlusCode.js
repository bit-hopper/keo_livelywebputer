/**
 * core/servers/identity/PlusCode.js
 *
 * Server-side floor/validation for postcard location tags (Plus Codes /
 * Open Location Code). Enforces the product-level privacy invariant: a
 * location tag is never stored (or queried) more precisely than 6
 * significant digits — roughly a 5.5km x 5.5km cell at the equator (OLC
 * pair 3 resolution is 0.05 degrees) — regardless of what a client sends.
 *
 * Independent copy from the client-side helpers in
 * core/lively/identity/PostCardUtils.js (encodeLocation/sanitizeLocationCode)
 * — same rationale as that file's own header note about _pmNodeToHtml:
 * server-side validation must not trust/import client code, it re-derives
 * the same floor from scratch. This is the actual trust boundary; the
 * client-side copy is defense-in-depth, not the enforcement point.
 */

'use strict';

var OpenLocationCode = require('open-location-code').OpenLocationCode;
var olc = new OpenLocationCode();

var LOCATION_CODE_LENGTH = 6;

// Re-derives a floored (<=6-significant-digit) Plus Code from a string of
// unknown/untrusted precision: decode + re-encode at the floor length, not
// substring slicing (Plus Codes place '+' at a fixed offset and support
// shortened forms a naive truncation would mangle). Returns null if `code`
// isn't a valid, full (decodable) Plus Code.
function truncateToFloor(code) {
  if (typeof code !== 'string' || !code) return null;
  try {
    if (!olc.isValid(code) || !olc.isFull(code)) return null;
    var area = olc.decode(code);
    return olc.encode(area.latitudeCenter, area.longitudeCenter, LOCATION_CODE_LENGTH);
  } catch (e) {
    return null;
  }
}

// True only for a code that's both a valid Plus Code AND already at or
// below the 6-significant-digit floor (i.e. truncateToFloor would be a
// no-op) — useful where "reject outright" is wanted instead of "coerce."
function isValidFloorCode(code) {
  var truncated = truncateToFloor(code);
  return truncated !== null && truncated === code;
}

module.exports = {
  LOCATION_CODE_LENGTH: LOCATION_CODE_LENGTH,
  truncateToFloor: truncateToFloor,
  isValidFloorCode: isValidFloorCode
};
