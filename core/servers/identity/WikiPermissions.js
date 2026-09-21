/**
 * core/servers/identity/WikiPermissions.js
 *
 * Who may edit a constellation wiki page. One rule, used by every place the
 * server has to decide: the persisted-save path (PUT /@:handle/:objId), the
 * edit-token route that gates the live-edit sync room, and the sync room
 * itself (LiveDocSyncServer.js, via a token minted from this rule's result).
 *
 * The setting lives in the page's own signed state:
 *
 *   envelope.state.editPolicy = { mode, handles? }
 *     mode: 'members'     — any constellation member with write access (the
 *                           behaviour before this setting existed; also what
 *                           an absent editPolicy means)
 *           'controllers' — the page's author and the constellation's controllers
 *           'handles'     — the page's author and the listed handles only
 *                           (controllers are NOT implicitly included)
 *     handles: lowercase handles/domains without '@', 1..MAX_HANDLES, only for
 *              mode 'handles'. Resolved handle -> DID at check time (not
 *              stored as DIDs), since a handle can change hands.
 *
 * The page's author (envelope.did, fixed at genesis) can always edit and is
 * the only one who can change the policy. A non-member can never edit,
 * whatever the policy says. Personal (constellation-less) pages have no
 * policy: only the author writes them.
 */

'use strict';

var handleRegistry = require('./HandleRegistry');
var constellationRegistry = require('./ConstellationRegistry');

var MODES = ['members', 'controllers', 'handles'];
var MAX_HANDLES = 50;
// Registered handles and verified domains ("tinylil.world"): lowercase letters,
// digits, '_', '-', '.', not starting with a separator.
var HANDLE_RE = /^[a-z0-9_][a-z0-9_.-]{0,63}$/;

function _cleanHandle(h) {
  return String(h).trim().replace(/^@/, '').toLowerCase();
}

// Canonical form of a policy (missing/unknown -> members), so two policies can
// be compared with policiesEqual. Assumes validatePolicy already accepted it
// where the input is untrusted; unknown modes fall back to 'members' rather
// than throwing so an old or odd stored value can't lock anyone out.
function normalizePolicy(p) {
  if (!p || typeof p !== 'object' || MODES.indexOf(p.mode) === -1) return { mode: 'members' };
  if (p.mode !== 'handles') return { mode: p.mode };
  var seen = {};
  var handles = (Array.isArray(p.handles) ? p.handles : [])
    .map(_cleanHandle)
    .filter(function (h) { if (!h || seen[h]) return false; seen[h] = true; return true; })
    .sort();
  return { mode: 'handles', handles: handles };
}

function policiesEqual(a, b) {
  return JSON.stringify(normalizePolicy(a)) === JSON.stringify(normalizePolicy(b));
}

// Returns null if the policy is acceptable (or absent), else an error string.
// For an incoming, untrusted envelope: absent is fine (means 'members'), but a
// present policy must be well-formed.
function validatePolicy(p) {
  if (p === undefined || p === null) return null;
  if (typeof p !== 'object' || Array.isArray(p)) return 'editPolicy must be an object';
  if (MODES.indexOf(p.mode) === -1) return 'editPolicy.mode must be one of: ' + MODES.join(', ');
  if (p.mode !== 'handles') {
    if (p.handles !== undefined && !(Array.isArray(p.handles) && p.handles.length === 0)) {
      return 'editPolicy.handles is only allowed with mode "handles"';
    }
    return null;
  }
  if (!Array.isArray(p.handles) || p.handles.length === 0) {
    return 'editPolicy.handles must list at least one handle';
  }
  if (p.handles.length > MAX_HANDLES) return 'editPolicy.handles is limited to ' + MAX_HANDLES + ' handles';
  for (var i = 0; i < p.handles.length; i++) {
    if (typeof p.handles[i] !== 'string' || !HANDLE_RE.test(_cleanHandle(p.handles[i]))) {
      return 'editPolicy.handles contains an invalid handle: ' + String(p.handles[i]).slice(0, 40);
    }
  }
  return null;
}

// Calls cb(err, { allowed: bool, reason: string|null }) — never an error just
// because access is denied. `existing` is the stored envelope; `constellation`
// is its constellation record (or null for a personal page); `did` may be null
// for an anonymous caller.
//
// reason (when denied): 'anonymous' | 'not-member' | 'controllers-only' |
// 'not-listed' — lets a route return a message that names why.
function canEditWikiPage(existing, did, constellation, cb) {
  if (!did) return cb(null, { allowed: false, reason: 'anonymous' });
  if (existing.did === did) return cb(null, { allowed: true, reason: null });
  if (!constellation || !constellationRegistry.canWrite(constellation, did)) {
    return cb(null, { allowed: false, reason: 'not-member' });
  }

  var policy = normalizePolicy(existing.state && existing.state.editPolicy);
  if (policy.mode === 'members') return cb(null, { allowed: true, reason: null });
  if (policy.mode === 'controllers') {
    return cb(null, constellationRegistry.isController(constellation, did)
      ? { allowed: true, reason: null }
      : { allowed: false, reason: 'controllers-only' });
  }

  // 'handles': resolve each listed handle to a DID and compare. Bounded by
  // MAX_HANDLES; stops as soon as one matches.
  var pending = policy.handles.length;
  if (pending === 0) return cb(null, { allowed: false, reason: 'not-listed' });
  var done = false;
  policy.handles.forEach(function (h) {
    handleRegistry.resolve(h, function (err, resolvedDid) {
      if (done) return;
      if (err) { done = true; return cb(err); }
      if (resolvedDid === did) { done = true; return cb(null, { allowed: true, reason: null }); }
      if (--pending === 0) { done = true; cb(null, { allowed: false, reason: 'not-listed' }); }
    });
  });
}

var REASON_MESSAGES = {
  anonymous: 'Sign in to edit this page.',
  'not-member': 'Forbidden: not a member of this constellation with write access',
  'controllers-only': 'Forbidden: only the page\'s author and this constellation\'s controllers can edit this page',
  'not-listed': 'Forbidden: only the page\'s author and the handles they listed can edit this page',
};

module.exports = {
  MODES: MODES,
  MAX_HANDLES: MAX_HANDLES,
  normalizePolicy: normalizePolicy,
  policiesEqual: policiesEqual,
  validatePolicy: validatePolicy,
  canEditWikiPage: canEditWikiPage,
  REASON_MESSAGES: REASON_MESSAGES,
};
