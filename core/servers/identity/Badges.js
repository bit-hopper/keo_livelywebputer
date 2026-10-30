/**
 * core/servers/identity/Badges.js
 *
 * Pure rules for the badge row on a user's homestar (badges.md): a typed place, the
 * transit lines they ride, a school or community, a library, a sports team. No
 * database, no Express: the settings PUT and GET /@:handle/badges in IdentityServer.js
 * call these, so they can be unit-tested on their own (tests/server/badges.test.js).
 *
 * The list lives in the owner's private settings envelope, next to `state.orbit` and
 * `state.mapVisibility`, because the server applies each badge's own visibility per
 * viewer and a badge the owner keeps to friends (a Friends-only place above all) must
 * not sit in the public profile:
 *
 *   state.badges = [ { id, kind, visibility, label, ... }, ... ]    (array order = display order)
 *
 * Shapes by kind (all text is control-character-stripped, whitespace-collapsed, trimmed
 * and length-limited; extra keys are dropped):
 *   place    { label }                                     at most one, always moved to index 0
 *   transit  { agency, label, color, textColor }           agency and label may each be empty, not both
 *   team     { label, abbr (1-3 A-Z0-9), color, textColor }
 *   school   { label, color, textColor }
 *   library  { label, abbr (1-4 A-Z0-9) }                  no colours stored (a fixed brown stamp)
 *
 * Every badge that carries a colour carries a text colour too, and the pair must reach
 * WCAG 4.5:1 (contrastRatio). The server enforces it so a client cannot store an
 * unreadable badge.
 *
 * Who may see a badge uses MapVisibility.canView (the same four choices, the same friend
 * / orbit rule), applied PER BADGE. A viewer who may see none gets an empty list; the
 * response carries no marker or count of what was hidden.
 */

'use strict';

var mapVisibility = require('./MapVisibility');

var MAX = 20;
var KINDS = ['place', 'transit', 'team', 'school', 'library'];
var ID_RE = /^[a-z0-9]{6,12}$/;
var HEX_RE = /^#[0-9A-Fa-f]{6}$/;
var MIN_CONTRAST = 4.5;

// The synthetic id given to a place read through from the old public profile.location.
// It fails ID_RE on purpose, so a PUT that still carries it is rejected and the client
// has to give the badge a real id when it saves.
var LEGACY_ID = '_legacy';

var LIMITS = { label: 40, agency: 24, transitLabel: 24 };

// Same cleaning the homestar always applied to a typed location: control characters
// become spaces, runs of whitespace collapse, ends are trimmed, then it is cut to `max`.
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// WCAG relative luminance of '#RRGGBB'.
function luminance(hex) {
  var n = parseInt(hex.slice(1), 16);
  var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
    var c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

// WCAG contrast ratio (1 to 21) between two '#RRGGBB' colours.
function contrastRatio(hexA, hexB) {
  var a = luminance(hexA), b = luminance(hexB);
  var hi = Math.max(a, b), lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// Checks and upper-cases one colour pair. Returns { color, textColor } or { error }.
function normalizeColors(raw) {
  var c = raw.color, t = raw.textColor;
  if (typeof c !== 'string' || !HEX_RE.test(c)) return { error: 'color must be a #RRGGBB colour' };
  if (typeof t !== 'string' || !HEX_RE.test(t)) return { error: 'textColor must be a #RRGGBB colour' };
  c = c.toUpperCase(); t = t.toUpperCase();
  var ratio = contrastRatio(c, t);
  if (ratio < MIN_CONTRAST) {
    return { error: 'color ' + c + ' and textColor ' + t + ' have contrast ' + ratio.toFixed(2) + ':1, at least ' + MIN_CONTRAST + ':1 is required' };
  }
  return { color: c, textColor: t };
}

// Upper-cases then checks an abbreviation of 1..maxLen letters or digits.
function normalizeAbbr(raw, maxLen) {
  if (typeof raw !== 'string') return { error: 'abbr must be 1 to ' + maxLen + ' letters or digits' };
  var a = raw.trim().toUpperCase();
  if (!new RegExp('^[A-Z0-9]{1,' + maxLen + '}$').test(a)) return { error: 'abbr must be 1 to ' + maxLen + ' letters or digits' };
  return { abbr: a };
}

// One badge. Returns { badge } or { error } (the message does not echo the badge back).
function normalizeOne(raw, index) {
  var where = 'badges[' + index + ']';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: where + ' must be an object' };
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return { error: where + '.id must be 6 to 12 lowercase letters or digits' };
  if (KINDS.indexOf(raw.kind) === -1) return { error: where + '.kind must be one of ' + KINDS.join(', ') };
  var vis = mapVisibility.normalize(raw.visibility);
  if (vis.error) return { error: where + '.visibility must be one of ' + mapVisibility.VALUES.join(', ') };

  var out = { id: raw.id, kind: raw.kind, visibility: vis.value };
  var r;
  if (raw.kind === 'transit') {
    out.agency = cleanText(raw.agency, LIMITS.agency);
    out.label = cleanText(raw.label, LIMITS.transitLabel);
    if (!out.agency && !out.label) return { error: where + ' (transit) needs an agency or a line' };
    r = normalizeColors(raw);
    if (r.error) return { error: where + ': ' + r.error };
    out.color = r.color; out.textColor = r.textColor;
    return { badge: out };
  }

  out.label = cleanText(raw.label, LIMITS.label);
  if (!out.label) return { error: where + '.label is required' };
  if (raw.kind === 'team' || raw.kind === 'school') {
    if (raw.kind === 'team') {
      r = normalizeAbbr(raw.abbr, 3);
      if (r.error) return { error: where + ': ' + r.error };
      out.abbr = r.abbr;
    }
    r = normalizeColors(raw);
    if (r.error) return { error: where + ': ' + r.error };
    out.color = r.color; out.textColor = r.textColor;
  } else if (raw.kind === 'library') {
    r = normalizeAbbr(raw.abbr, 4);
    if (r.error) return { error: where + ': ' + r.error };
    out.abbr = r.abbr;
  }
  // place: nothing else is kept
  return { badge: out };
}

// Validates and cleans a whole state.badges. Returns { badges } or { error }.
// undefined / null mean "none". At most MAX badges, ids unique, at most one place;
// the place (if any) is moved to index 0 whatever order it arrived in, the rest keep
// their order.
function normalize(raw) {
  if (raw === undefined || raw === null) return { badges: [] };
  if (!Array.isArray(raw)) return { error: 'badges must be an array' };
  if (raw.length > MAX) return { error: 'badges holds at most ' + MAX + ' badges' };
  var seen = {}, out = [], place = null;
  for (var i = 0; i < raw.length; i++) {
    var r = normalizeOne(raw[i], i);
    if (r.error) return { error: r.error };
    var b = r.badge;
    if (seen[b.id]) return { error: 'badges[' + i + '].id is a duplicate' };
    seen[b.id] = true;
    if (b.kind === 'place') {
      if (place) return { error: 'badges holds at most one place' };
      place = b;
    } else {
      out.push(b);
    }
  }
  if (place) out.unshift(place);
  return { badges: out };
}

// The synthetic place for an owner who has no place badge yet but still has the old
// public profile.location: it is what the profile already showed everyone, so reading
// it through exposes nothing new. Returns the badge or null.
function legacyPlace(profileLocation) {
  var label = cleanText(profileLocation, LIMITS.label);
  if (!label) return null;
  return { id: LEGACY_ID, kind: 'place', visibility: 'anyone', label: label };
}

// `badges` (already normalized) with the legacy place at index 0 when there is no real
// place badge and the profile still has a location. Once a real place badge exists the
// profile's location is ignored, even if it still holds an old value.
function withLegacyPlace(badges, profileLocation) {
  badges = badges || [];
  for (var i = 0; i < badges.length; i++) if (badges[i].kind === 'place') return badges;
  var legacy = legacyPlace(profileLocation);
  return legacy ? [legacy].concat(badges) : badges;
}

// The badges this viewer may see, in order. `relation` is
// { ownerDid, viewerDid (null when signed out), isFriend, inOrbit }. The owner sees all.
// Badges keep their `visibility` here; stripForViewer removes it for non-owners.
function filterForViewer(badges, relation) {
  return (badges || []).filter(function (b) {
    return mapVisibility.canView(b.visibility, relation.ownerDid, relation.viewerDid, relation.isFriend, relation.inOrbit);
  });
}

// A non-owner is not told how a badge is shared.
function stripForViewer(badge) {
  var out = {};
  Object.keys(badge).forEach(function (k) { if (k !== 'visibility') out[k] = badge[k]; });
  return out;
}

// What GET /@:handle/badges sends: the owner gets everything with `visibility`, anyone
// else only what they may see, without `visibility`.
function forViewer(badges, relation) {
  var isOwner = !!(relation.viewerDid && relation.viewerDid === relation.ownerDid);
  if (isOwner) return { badges: badges || [], isOwner: true };
  return { badges: filterForViewer(badges, relation).map(stripForViewer), isOwner: false };
}

module.exports = {
  MAX: MAX,
  KINDS: KINDS,
  LEGACY_ID: LEGACY_ID,
  MIN_CONTRAST: MIN_CONTRAST,
  cleanText: cleanText,
  contrastRatio: contrastRatio,
  normalize: normalize,
  legacyPlace: legacyPlace,
  withLegacyPlace: withLegacyPlace,
  filterForViewer: filterForViewer,
  stripForViewer: stripForViewer,
  forViewer: forViewer
};
