/**
 * core/servers/identity/AudienceLists.js
 *
 * Pure rules for a user's postcard audiences: their named lists and which
 * audiences each of their cards is shared with. No database, no Express: the
 * settings PUT in IdentityServer.js calls normalize(), so the rules can be
 * unit-tested on their own (tests/server/audience-lists.test.js).
 *
 * Both live in `state` on the owner's private settings envelope, next to the
 * orbit and the block list. That envelope is readable only by its owner (the
 * routes that read it for anyone else only look at the block lists), so list
 * names and named people never reach a recipient.
 *
 *   state.audienceLists = [{ id, name, memberDids: [did, ...] }, ...]
 *   state.cardAudiences = { <objId>: { tiers: ['friends'|'orbit'|'list:<id>', ...],
 *                                      people: [did, ...] }, ... }
 *
 * A card with no entry is not managed by audience sync (a public card, or a card
 * sent by hand). An entry with no tiers and no people means "only me".
 *
 * Invariants: list and person DIDs are all friends of the owner, a card's list
 * tiers refer to lists that still exist, and every collection is capped.
 */

'use strict';

var MAX_LISTS = 50;
var MAX_LIST_MEMBERS = 200;
var MAX_NAME_LENGTH = 60;
var MAX_CARDS = 5000;
var MAX_PEOPLE_PER_CARD = 200;
var BUILTIN_TIERS = ['friends', 'orbit'];
var ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function _didList(v) {
  var out = [];
  (Array.isArray(v) ? v : []).forEach(function (d) {
    if (typeof d === 'string' && d && out.indexOf(d) === -1) out.push(d);
  });
  return out;
}

function _onlyFriends(dids, friends) {
  return dids.filter(function (d) { return friends.indexOf(d) !== -1; });
}

// Returns { lists } with the invariants enforced, or { error } for a wrong shape.
// Members who are not (or are no longer) friends are dropped rather than
// rejected, for the same reason as Orbit.normalize: an unrelated settings save
// carries the stored lists along and must not fail because a friendship ended.
function normalizeLists(raw, friendDids) {
  if (raw === undefined || raw === null) return { lists: [] };
  if (!Array.isArray(raw)) return { error: 'audienceLists must be an array' };
  if (raw.length > MAX_LISTS) return { error: 'at most ' + MAX_LISTS + ' lists' };
  var friends = _didList(friendDids);
  var seenIds = [];
  var lists = [];
  for (var i = 0; i < raw.length; i++) {
    var l = raw[i];
    if (!l || typeof l !== 'object' || Array.isArray(l)) return { error: 'each list must be an object' };
    if (typeof l.id !== 'string' || !ID_PATTERN.test(l.id)) return { error: 'each list needs an id of letters, digits, - or _' };
    if (seenIds.indexOf(l.id) !== -1) return { error: 'duplicate list id' };
    seenIds.push(l.id);
    var name = typeof l.name === 'string' ? l.name.trim() : '';
    if (!name) return { error: 'each list needs a name' };
    if (name.length > MAX_NAME_LENGTH) return { error: 'a list name can have at most ' + MAX_NAME_LENGTH + ' characters' };
    if (l.memberDids !== undefined && !Array.isArray(l.memberDids)) return { error: 'memberDids must be an array' };
    var members = _onlyFriends(_didList(l.memberDids), friends);
    if (members.length > MAX_LIST_MEMBERS) return { error: 'a list can hold at most ' + MAX_LIST_MEMBERS + ' people' };
    lists.push({ id: l.id, name: name, memberDids: members });
  }
  return { lists: lists };
}

// Returns { cardAudiences }, or { error } for a wrong shape. `lists` is the
// already-normalized list array: a list tier whose list is gone is dropped, which
// leaves the card with a smaller audience (the next sync withdraws access).
function normalizeCardAudiences(raw, lists, friendDids) {
  if (raw === undefined || raw === null) return { cardAudiences: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'cardAudiences must be an object' };
  var keys = Object.keys(raw);
  if (keys.length > MAX_CARDS) return { error: 'at most ' + MAX_CARDS + ' cards' };
  var friends = _didList(friendDids);
  var listTiers = (lists || []).map(function (l) { return 'list:' + l.id; });
  var out = {};
  for (var i = 0; i < keys.length; i++) {
    var objId = keys[i];
    if (!ID_PATTERN.test(objId)) return { error: 'cardAudiences has an invalid object id' };
    var a = raw[objId];
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: 'each card audience must be an object' };
    if (a.tiers !== undefined && !Array.isArray(a.tiers)) return { error: 'tiers must be an array' };
    if (a.people !== undefined && !Array.isArray(a.people)) return { error: 'people must be an array' };
    var tiers = [];
    (a.tiers || []).forEach(function (t) {
      if (typeof t !== 'string' || tiers.indexOf(t) !== -1) return;
      if (BUILTIN_TIERS.indexOf(t) !== -1 || listTiers.indexOf(t) !== -1) tiers.push(t);
    });
    var people = _onlyFriends(_didList(a.people), friends);
    if (people.length > MAX_PEOPLE_PER_CARD) return { error: 'a card can name at most ' + MAX_PEOPLE_PER_CARD + ' people' };
    out[objId] = { tiers: tiers, people: people };
  }
  return { cardAudiences: out };
}

// Normalizes both fields of a settings `state` together (the card audiences
// depend on which lists exist). Fields the state does not carry are left absent
// in the result, so a save that never touched audiences stays untouched.
// Returns { audienceLists?, cardAudiences? } or { error }.
function normalizeState(state, friendDids) {
  var result = {};
  // The client sends the whole state, so a state without audienceLists has no
  // lists, and list tiers on a card then refer to nothing.
  var lists = [];
  if (state.audienceLists !== undefined) {
    var l = normalizeLists(state.audienceLists, friendDids);
    if (l.error) return { error: l.error };
    lists = l.lists;
    result.audienceLists = l.lists;
  }
  if (state.cardAudiences !== undefined) {
    var c = normalizeCardAudiences(state.cardAudiences, lists, friendDids);
    if (c.error) return { error: c.error };
    result.cardAudiences = c.cardAudiences;
  }
  return result;
}

module.exports = {
  MAX_LISTS: MAX_LISTS,
  MAX_LIST_MEMBERS: MAX_LIST_MEMBERS,
  MAX_NAME_LENGTH: MAX_NAME_LENGTH,
  MAX_CARDS: MAX_CARDS,
  MAX_PEOPLE_PER_CARD: MAX_PEOPLE_PER_CARD,
  BUILTIN_TIERS: BUILTIN_TIERS,
  normalizeLists: normalizeLists,
  normalizeCardAudiences: normalizeCardAudiences,
  normalizeState: normalizeState
};
