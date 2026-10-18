/**
 * core/servers/identity/WikiCard.js
 *
 * Pure rules for the owner's choices about the homestar's Wiki pages card. No
 * database, no Express: the settings PUT and GET /@:handle/wiki-card in
 * IdentityServer.js call these, so they can be unit-tested on their own
 * (tests/server/wiki-card.test.js).
 *
 * Both choices live in the owner's private settings envelope, next to
 * `state.mapVisibility`, because the server applies them per viewer:
 *
 *   state.wikiCardVisibility = 'anyone' | 'friends' | 'orbit' | 'private'
 *   state.wikiCardHidden     = [page objId, ...]   (never listed on the card)
 *
 * Only the CARD is gated. Wiki pages are deliberately always public (no per-page
 * visibility, WikiSerializer.js) and every one stays in the public index at
 * GET /@:handle/wiki and readable at its own address, so this changes what the
 * homestar shows, not who can read a page. The dialog says so.
 *
 * Who may see the card uses MapVisibility.canView (same four choices, same friend /
 * orbit rule). Hidden pages are stored by objId, which survives a rename.
 */

'use strict';

var mapVisibility = require('./MapVisibility');

var MAX_HIDDEN = 500;
var OBJ_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

// Returns { value } or { error } for state.wikiCardVisibility.
// undefined / null mean "never chosen" and become the default.
function normalizeVisibility(raw) {
  var r = mapVisibility.normalize(raw);
  if (r.error) return { error: 'wikiCardVisibility must be one of ' + mapVisibility.VALUES.join(', ') };
  return r;
}

// Returns { hidden } (de-duplicated, in order) or { error } for state.wikiCardHidden.
function normalizeHidden(raw) {
  if (raw === undefined || raw === null) return { hidden: [] };
  if (!Array.isArray(raw)) return { error: 'wikiCardHidden must be an array of page ids' };
  if (raw.length > MAX_HIDDEN) return { error: 'wikiCardHidden holds at most ' + MAX_HIDDEN + ' ids' };
  var seen = {}, out = [];
  for (var i = 0; i < raw.length; i++) {
    var id = raw[i];
    if (typeof id !== 'string' || !OBJ_ID_RE.test(id)) return { error: 'wikiCardHidden entries must be page ids' };
    if (!seen[id]) { seen[id] = true; out.push(id); }
  }
  return { hidden: out };
}

// The rows the card may list: everything the owner has not hidden.
// Returns { rows, hiddenCount }.
function applyHidden(rows, hidden) {
  var skip = {};
  (hidden || []).forEach(function (id) { skip[id] = true; });
  var kept = rows.filter(function (r) { return !skip[r.objId]; });
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
