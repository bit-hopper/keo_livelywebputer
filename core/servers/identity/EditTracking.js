/**
 * core/servers/identity/EditTracking.js
 *
 * Pure rules for deciding when a write to a postcard counts as an "edit" of a card
 * other people can already read. No database, no Express: the postcard branch of
 * PUT /@:handle/:objId calls apply(), so the rules can be unit-tested on their own
 * (tests/server/edit-tracking.test.js).
 *
 * The server stamps four fields into the card's `state`. `state` is not covered by
 * the owner's signature (the client's integrity check leaves it out), so the server
 * can write it without a re-sign, and it never trusts what the client sent for them.
 *
 *   sharedAt     when the card first became readable by someone other than its owner
 *   editBaseline cid of the version a reader's diff starts from: the version current
 *                when the card was first shared, moved forward while the card is still
 *                inside the settling window. A reader with a later recipient `sinceCid`
 *                (signed, set by the owner's client) uses whichever is newer.
 *   lastWriteAt  time of the last content write
 *   editedAt     time of the last content write that counted as an edit
 *
 * Rules (homestar.md 4.6):
 *  - The first SETTLE_MS after a card is shared are not edits: writes in that window
 *    move the baseline forward to the version just written, and stamp nothing else.
 *  - After that, a content write is an edit. Writes less than SETTLE_MS after the last
 *    one belong to the same edit session (autosave fires every couple of seconds);
 *    only the first write of a session asks for a notice.
 *  - A card that stops being readable by others forgets all of it, so sharing it again
 *    starts clean.
 *  - A write that changes only metadata (same cid) never counts as an edit, but can
 *    still change who may read the card, and so can set or clear the stamps.
 *  - The owner can mark a write minor (`state.editMinor: true`, never stored): it is
 *    still an edit, shown by the marker and the diff, but asks for no notice.
 */

'use strict';

var SETTLE_MS = 10 * 60 * 1000;
var STAMPS = ['sharedAt', 'editBaseline', 'lastWriteAt', 'editedAt'];

// Can anyone but the owner read this version?
function visibleToOthers(env) {
  if (!env) return false;
  if (env.visibility === 'public') return true;
  var rs = env.record && env.record.recipients;
  return !!(Array.isArray(rs) && rs.some(function (r) { return r && r.did && r.did !== env.did; }));
}

// Only ordinary cards are tracked: not replies, room messages or other kinds, and
// not a tombstone.
function isTracked(env) {
  if (!env || env.type !== 'postcard') return false;
  if (env.replyTo && env.replyTo.objId) return false;
  var st = env.state || {};
  if (st.kind || st.deleted) return false;
  return true;
}

function _ms(iso) {
  var t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return isNaN(t) ? null : t;
}

// existing: the stored latest envelope, or null for a first write.
// incoming: the envelope about to be stored.
// nowMs: Date.now().
// Returns { state, notify }: the state to store (a copy of the incoming one with the
// stamps decided here, and the transient `editMinor` removed) and whether this write
// starts an edit session that readers should be told about.
function apply(existing, incoming, nowMs) {
  var state = Object.assign({}, incoming.state || {});
  var minor = state.editMinor === true;
  delete state.editMinor;
  STAMPS.forEach(function (k) { delete state[k]; });

  if (!isTracked(incoming) || (existing && !isTracked(existing))) {
    return { state: state, notify: false };
  }

  var now = new Date(nowMs).toISOString();
  var prev = (existing && existing.state) || {};
  var content = !existing || existing.record.cid !== incoming.record.cid;
  var visNow = visibleToOthers(incoming);
  var visBefore = !!existing && visibleToOthers(existing);

  function keep(k) { if (prev[k] !== undefined && prev[k] !== null) state[k] = prev[k]; }
  state.lastWriteAt = content ? now : prev.lastWriteAt;
  if (state.lastWriteAt === undefined) delete state.lastWriteAt;

  if (!visNow) {
    // Not readable by anyone else: nothing to compare against later.
    return { state: state, notify: false };
  }

  if (!visBefore) {
    // Just became readable: this version is where every reader starts.
    state.sharedAt = now;
    state.editBaseline = incoming.record.cid;
    return { state: state, notify: false };
  }

  keep('sharedAt');
  keep('editBaseline');
  keep('editedAt');
  if (!content) return { state: state, notify: false };

  var sharedMs = _ms(prev.sharedAt);
  if (sharedMs !== null && nowMs - sharedMs <= SETTLE_MS) {
    state.editBaseline = incoming.record.cid;
    delete state.editedAt;
    return { state: state, notify: false };
  }

  // A card that was already readable before this was tracked has no baseline: the
  // version being replaced is the best one there is.
  if (!state.editBaseline) state.editBaseline = existing.record.cid;
  var lastMs = _ms(prev.lastWriteAt);
  var gap = lastMs === null ? Infinity : nowMs - lastMs;
  var newSession = !prev.editedAt || gap > SETTLE_MS;
  state.editedAt = now;
  return { state: state, notify: newSession && !minor };
}

module.exports = {
  SETTLE_MS: SETTLE_MS,
  STAMPS: STAMPS,
  visibleToOthers: visibleToOthers,
  isTracked: isTracked,
  apply: apply
};
