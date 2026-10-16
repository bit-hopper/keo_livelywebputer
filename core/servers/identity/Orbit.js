/**
 * core/servers/identity/Orbit.js
 *
 * Pure rules for a user's orbit (their close friends, shown on the homestar and
 * usable as a postcard audience). No database, no Express: the settings PUT and
 * GET /@:handle/orbit in IdentityServer.js call these, so they can be unit-tested
 * on their own (tests/server/orbit.test.js).
 *
 * The orbit lives in `state.orbit` on the owner's private settings envelope, not
 * in the public profile, so a Friends-only orbit is not readable by everyone.
 * `state` is server-readable on purpose (the server filters the list per viewer),
 * the same reason the block list lives there.
 *
 *   state.orbit = { visibility: 'anyone' | 'friends' | 'private',
 *                   members: [did, ...], pinned: [did, ...] }
 *
 * Invariants: members are all friends of the owner, pinned is a subset of members,
 * and at most MAX_PINNED are pinned.
 */

'use strict';

var MAX_PINNED = 3;
var MAX_MEMBERS = 200;
var VISIBILITIES = ['anyone', 'friends', 'private'];
var DEFAULT_VISIBILITY = 'friends';

function _didList(v) {
  var out = [];
  (Array.isArray(v) ? v : []).forEach(function (d) {
    if (typeof d === 'string' && d && out.indexOf(d) === -1) out.push(d);
  });
  return out;
}

// Returns { orbit } with the invariants enforced, or { error } if `raw` is not
// the right shape at all. Members who are not (or are no longer) friends are
// dropped rather than rejected: an unrelated settings save (the block list)
// carries the stored orbit along, and must not start failing because a
// friendship ended in the meantime.
// friendDids: the owner's current friends' DIDs.
function normalize(raw, friendDids) {
  if (raw === undefined || raw === null) {
    return { orbit: { visibility: DEFAULT_VISIBILITY, members: [], pinned: [] } };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'orbit must be an object' };
  var visibility = raw.visibility === undefined ? DEFAULT_VISIBILITY : raw.visibility;
  if (VISIBILITIES.indexOf(visibility) === -1) {
    return { error: 'orbit.visibility must be one of ' + VISIBILITIES.join(', ') };
  }
  if (raw.members !== undefined && !Array.isArray(raw.members)) return { error: 'orbit.members must be an array' };
  if (raw.pinned !== undefined && !Array.isArray(raw.pinned)) return { error: 'orbit.pinned must be an array' };

  var friends = _didList(friendDids);
  var members = _didList(raw.members).filter(function (d) { return friends.indexOf(d) !== -1; });
  if (members.length > MAX_MEMBERS) return { error: 'orbit can hold at most ' + MAX_MEMBERS + ' members' };
  var pinned = _didList(raw.pinned).filter(function (d) { return members.indexOf(d) !== -1; }).slice(0, MAX_PINNED);
  return { orbit: { visibility: visibility, members: members, pinned: pinned } };
}

// May viewerDid see the member list? `viewerIsFriend` is whether viewerDid is a
// friend of the owner (the caller looks that up; this stays pure).
function canView(orbit, ownerDid, viewerDid, viewerIsFriend) {
  if (viewerDid && viewerDid === ownerDid) return true;
  var visibility = (orbit && orbit.visibility) || DEFAULT_VISIBILITY;
  if (visibility === 'anyone') return true;
  if (visibility === 'friends') return !!(viewerDid && viewerIsFriend);
  return false;
}

module.exports = {
  MAX_PINNED: MAX_PINNED,
  MAX_MEMBERS: MAX_MEMBERS,
  VISIBILITIES: VISIBILITIES,
  DEFAULT_VISIBILITY: DEFAULT_VISIBILITY,
  normalize: normalize,
  canView: canView
};
