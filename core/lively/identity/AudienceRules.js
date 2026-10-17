/**
 * lively.identity.AudienceRules
 *
 * Pure rules for who a postcard is shared with: expanding an audience (Friends,
 * Orbit, named lists, specific people) into a set of DIDs, and diffing that set
 * against a card's current record.recipients. No network, no crypto, no DOM, so
 * the logic can be unit-tested in node (tests/server/audience-rules.test.js loads
 * this file with a stub `module`). PostcardAudience.js does the I/O around it.
 *
 * An audience is { tiers: ['friends'|'orbit'|'list:<id>', ...], people: [did, ...] }.
 * The audience of a card is the UNION of everything ticked; a person who is in
 * several of the sets is one recipient, and the owner is never a recipient (the
 * owner opens a card with the key wrapped under their own KEK).
 *
 * ctx = { ownerDid, friendDids: [did] (everyone in a set must be one of these),
 *         orbitDids: [did],
 *         lists: [{ id, memberDids: [did] }] }
 */

module('lively.identity.AudienceRules')
  .requires()
  .toRun(function () {

    var TIER_FRIENDS = 'friends';
    var TIER_ORBIT = 'orbit';
    var LIST_PREFIX = 'list:';

    // Only current friends can be recipients: a list or a named person that is
    // stored with someone who is no longer a friend stands for nobody, so ending a
    // friendship withdraws access on the next sync without any settings edit.
    function pushUnique(out, did, ctx) {
      if (typeof did !== 'string' || !did || did === ctx.ownerDid) return;
      if ((ctx.friendDids || []).indexOf(did) === -1) return;
      if (out.indexOf(did) === -1) out.push(did);
    }

    // The DIDs one tier stands for right now. An unknown tier, or a list that no
    // longer exists, stands for nobody.
    function tierDids(tier, ctx) {
      if (tier === TIER_FRIENDS) return ctx.friendDids || [];
      if (tier === TIER_ORBIT) return ctx.orbitDids || [];
      if (typeof tier === 'string' && tier.indexOf(LIST_PREFIX) === 0) {
        var id = tier.slice(LIST_PREFIX.length);
        var lists = ctx.lists || [];
        for (var i = 0; i < lists.length; i++) {
          if (lists[i].id === id) return lists[i].memberDids || [];
        }
      }
      return [];
    }

    // The de-duplicated union of every tier plus the named people.
    function unionDids(audience, ctx) {
      var out = [];
      var a = audience || {};
      (a.tiers || []).forEach(function (t) {
        tierDids(t, ctx).forEach(function (d) { pushUnique(out, d, ctx); });
      });
      (a.people || []).forEach(function (d) { pushUnique(out, d, ctx); });
      return out;
    }

    // Compare a card's current recipient entries ({did, sealedDek}) with the DIDs it
    // should have. An entry with no sealedDek cannot open anything (the server's
    // addRecipient helper appends bare {did}), so it counts as missing and gets
    // sealed again.
    //   keep:   existing entries to carry over unchanged
    //   add:    DIDs that need a fresh sealed key
    //   remove: DIDs to withdraw
    //   changed: whether the recipient list differs at all
    function planRecipients(currentEntries, desiredDids) {
      var have = {};
      var currentDids = [];
      (currentEntries || []).forEach(function (e) {
        if (!e || !e.did) return;
        if (currentDids.indexOf(e.did) === -1) currentDids.push(e.did);
        if (e.sealedDek && !have[e.did]) have[e.did] = e;
      });
      var want = {};
      desiredDids.forEach(function (d) { want[d] = true; });
      var keep = [];
      var add = [];
      desiredDids.forEach(function (d) {
        if (have[d]) keep.push(have[d]); else add.push(d);
      });
      var remove = currentDids.filter(function (d) { return !want[d]; });
      return { keep: keep, add: add, remove: remove, changed: add.length > 0 || remove.length > 0 };
    }

    // 'shared' if anyone can open the card besides its owner, else 'private'.
    function visibilityFor(recipientCount) {
      return recipientCount > 0 ? 'shared' : 'private';
    }

    // What goes in the card's own state.audience, which every recipient can read:
    // only the coarse shape, never a list id, a list name or a person. `custom`
    // means a list or named people are part of the audience.
    function mirrorFor(audience) {
      var a = audience || {};
      var tiers = [];
      var custom = (a.people || []).length > 0;
      (a.tiers || []).forEach(function (t) {
        if (t === TIER_FRIENDS || t === TIER_ORBIT) {
          if (tiers.indexOf(t) === -1) tiers.push(t);
        } else {
          custom = true;
        }
      });
      var mirror = { tiers: tiers };
      if (custom) mirror.custom = true;
      return mirror;
    }

    function sameMirror(a, b) {
      return JSON.stringify(a || null) === JSON.stringify(b || null);
    }

    lively.identity = lively.identity || {};
    lively.identity.AudienceRules = {
      TIER_FRIENDS: TIER_FRIENDS,
      TIER_ORBIT: TIER_ORBIT,
      LIST_PREFIX: LIST_PREFIX,
      tierDids: tierDids,
      unionDids: unionDids,
      planRecipients: planRecipients,
      visibilityFor: visibilityFor,
      mirrorFor: mirrorFor,
      sameMirror: sameMirror
    };

  }); // end module('lively.identity.AudienceRules')
