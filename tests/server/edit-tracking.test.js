// Edit tracking rules (core/servers/identity/EditTracking.js): pure, no database.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const et = require('../../core/servers/identity/EditTracking.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function card(cid, over) {
  over = over || {};
  return Object.assign({
    type: 'postcard', did: 'did:owner', objId: 'o1', visibility: 'public',
    record: { cid: cid, prevCid: null, recipients: over.recipients },
    state: over.state || {}
  }, over.env || {});
}

test('first write of a public card stamps the baseline and the share time', () => {
  const r = et.apply(null, card('c1'), T0);
  assert.equal(r.state.sharedAt, iso(T0));
  assert.equal(r.state.editBaseline, 'c1');
  assert.equal(r.state.lastWriteAt, iso(T0));
  assert.equal(r.state.editedAt, undefined);
  assert.equal(r.notify, false);
});

test('first write of a private card stamps no share time and no baseline', () => {
  const r = et.apply(null, card('c1', { env: { visibility: 'private' } }), T0);
  assert.equal(r.state.sharedAt, undefined);
  assert.equal(r.state.editBaseline, undefined);
  assert.equal(r.notify, false);
});

test('a write inside the settling window moves the baseline forward and is not an edit', () => {
  const first = et.apply(null, card('c1'), T0);
  const stored = card('c1', { state: first.state });
  const r = et.apply(stored, card('c2'), T0 + 5 * MIN);
  assert.equal(r.state.editBaseline, 'c2');
  assert.equal(r.state.editedAt, undefined);
  assert.equal(r.state.sharedAt, iso(T0));
  assert.equal(r.notify, false);
});

test('the first write after the window is an edit, keeps the baseline and asks for a notice', () => {
  const first = et.apply(null, card('c1'), T0);
  const r = et.apply(card('c1', { state: first.state }), card('c2'), T0 + 11 * MIN);
  assert.equal(r.state.editBaseline, 'c1');
  assert.equal(r.state.editedAt, iso(T0 + 11 * MIN));
  assert.equal(r.notify, true);
});

test('autosaves in the same session do not ask for another notice', () => {
  let stored = card('c1', { state: et.apply(null, card('c1'), T0).state });
  let r = et.apply(stored, card('c2'), T0 + 20 * MIN);
  assert.equal(r.notify, true);
  stored = card('c2', { state: r.state });
  r = et.apply(stored, card('c3'), T0 + 20 * MIN + 2000);
  assert.equal(r.notify, false);
  assert.equal(r.state.editedAt, iso(T0 + 20 * MIN + 2000));
  assert.equal(r.state.editBaseline, 'c1');
});

test('a gap longer than the window starts a new session', () => {
  let stored = card('c1', { state: et.apply(null, card('c1'), T0).state });
  let r = et.apply(stored, card('c2'), T0 + 20 * MIN);
  stored = card('c2', { state: r.state });
  r = et.apply(stored, card('c3'), T0 + 40 * MIN);
  assert.equal(r.notify, true);
});

test('a minor edit is still stamped but asks for no notice, and the flag is never stored', () => {
  const first = et.apply(null, card('c1'), T0);
  const incoming = card('c2', { state: { editMinor: true } });
  const r = et.apply(card('c1', { state: first.state }), incoming, T0 + 30 * MIN);
  assert.equal(r.notify, false);
  assert.equal(r.state.editedAt, iso(T0 + 30 * MIN));
  assert.equal(r.state.editMinor, undefined);
});

test('stamps sent by the client are ignored', () => {
  const first = et.apply(null, card('c1'), T0);
  const forged = card('c2', { state: { editedAt: 'x', editBaseline: 'evil', sharedAt: 'y', lastWriteAt: 'z' } });
  const r = et.apply(card('c1', { state: first.state }), forged, T0 + 30 * MIN);
  assert.equal(r.state.editBaseline, 'c1');
  assert.equal(r.state.sharedAt, iso(T0));
  assert.equal(r.state.editedAt, iso(T0 + 30 * MIN));
});

test('other state keys pass through untouched', () => {
  const r = et.apply(null, card('c1', { state: { title: 'Hi', location: '8FVC9G8F+6W' } }), T0);
  assert.equal(r.state.title, 'Hi');
  assert.equal(r.state.location, '8FVC9G8F+6W');
});

test('a card becoming readable in place (same cid) stamps the baseline', () => {
  const priv = card('c1', { env: { visibility: 'private' }, state: et.apply(null, card('c1', { env: { visibility: 'private' } }), T0).state });
  const shared = card('c1', { env: { visibility: 'shared' }, recipients: [{ did: 'did:friend' }] });
  const r = et.apply(priv, shared, T0 + 60 * MIN);
  assert.equal(r.state.sharedAt, iso(T0 + 60 * MIN));
  assert.equal(r.state.editBaseline, 'c1');
  assert.equal(r.notify, false);
});

test('an edit shortly after sharing in place is still inside the window', () => {
  const priv = card('c1', { env: { visibility: 'private' } });
  const shared = card('c1', { env: { visibility: 'shared' }, recipients: [{ did: 'did:friend' }] });
  const sharedState = et.apply(priv, shared, T0).state;
  const r = et.apply(card('c1', { env: { visibility: 'shared' }, recipients: [{ did: 'did:friend' }], state: sharedState }),
    card('c2', { env: { visibility: 'shared' }, recipients: [{ did: 'did:friend' }] }), T0 + 2 * MIN);
  assert.equal(r.state.editBaseline, 'c2');
  assert.equal(r.notify, false);
});

test('a metadata-only write is never an edit', () => {
  const first = et.apply(null, card('c1'), T0);
  const r = et.apply(card('c1', { state: first.state }), card('c1', { state: { title: 'renamed' } }), T0 + 60 * MIN);
  assert.equal(r.state.editedAt, undefined);
  assert.equal(r.state.editBaseline, 'c1');
  assert.equal(r.state.sharedAt, iso(T0));
  assert.equal(r.notify, false);
});

test('withdrawing everyone clears the stamps; sharing again starts clean', () => {
  const first = et.apply(null, card('c1'), T0);
  const edited = et.apply(card('c1', { state: first.state }), card('c2'), T0 + 30 * MIN);
  const stored = card('c2', { state: edited.state });
  const priv = et.apply(stored, card('c2', { env: { visibility: 'private' } }), T0 + 31 * MIN);
  assert.equal(priv.state.editedAt, undefined);
  assert.equal(priv.state.editBaseline, undefined);
  assert.equal(priv.state.sharedAt, undefined);
  const again = et.apply(card('c2', { env: { visibility: 'private' }, state: priv.state }),
    card('c2', { env: { visibility: 'shared' }, recipients: [{ did: 'did:friend' }] }), T0 + 90 * MIN);
  assert.equal(again.state.sharedAt, iso(T0 + 90 * MIN));
  assert.equal(again.state.editBaseline, 'c2');
});

test('a card already readable before tracking uses the replaced version as its baseline', () => {
  const legacy = card('c1', { state: { title: 'old' } });
  const r = et.apply(legacy, card('c2', { state: { title: 'old' } }), T0);
  assert.equal(r.state.editBaseline, 'c1');
  assert.equal(r.state.editedAt, iso(T0));
  assert.equal(r.notify, true);
});

test('replies, room messages and tombstones are not tracked and carry no stamps', () => {
  const reply = card('c2', { env: { replyTo: { objId: 'root' } }, state: { editedAt: 'x' } });
  assert.deepEqual(et.apply(card('c1', { env: { replyTo: { objId: 'root' } } }), reply, T0).state, {});
  const room = card('c2', { state: { kind: 'room-message', sharedAt: 'x' } });
  assert.equal(et.apply(null, room, T0).state.sharedAt, undefined);
  const tomb = card('c1', { state: { deleted: true } });
  assert.equal(et.apply(card('c1'), tomb, T0).notify, false);
});

test('visibleToOthers: the owner alone as recipient does not count', () => {
  assert.equal(et.visibleToOthers(card('c', { env: { visibility: 'shared' }, recipients: [{ did: 'did:owner' }] })), false);
  assert.equal(et.visibleToOthers(card('c', { env: { visibility: 'shared' }, recipients: [{ did: 'did:x' }] })), true);
  assert.equal(et.visibleToOthers(card('c', { env: { visibility: 'private' } })), false);
});
