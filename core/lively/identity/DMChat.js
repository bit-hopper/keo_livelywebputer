/**
 * core/lively/identity/DMChat.js
 *
 * P2P E2EE direct messages — v1 slice of the design in p2pchat.md (repo
 * root). This pass implements the store-and-forward mailbox path only
 * (p2pchat.md §5/§6): a real WebRTC live data-channel path is deliberately
 * deferred to a follow-up pass, same staged approach the rooms feature's
 * own chat-then-video build took (see project-spaces-rooms-feature
 * memory). Every message still goes end-to-end encrypted through
 * /@:handle/dm/mailbox either way — there is no plaintext-relay fallback.
 *
 * Crypto (p2pchat.md §4, "one encryption plane" per Encryption.md):
 *   - Confidentiality: lively.identity.crypto.sealForRecipient/openSealedBox
 *     (X25519 sealed box, the same primitive postcards/files already use
 *     for DEK-wrapping) — no new crypto primitive introduced.
 *   - Authenticity: a real JWS signature by the sender's soft signing key
 *     (mirrors PostCardSerializer.js's own _signEnvelopeIfPossible), since
 *     sealForRecipient alone is an anonymous sealed box with no sender
 *     binding (confirmed by reading Crypto.js).
 *   - Gate: friend-gated server-side (FriendRegistry.areFriends) on both
 *     the mailbox POST and (once built) DM signaling — nothing new to
 *     design for "who can message whom," per p2pchat.md §1.
 *
 * Storage: IndexedDB only (p2pchat.md §7) — the server-side mailbox row is
 * deleted as soon as a message is decrypted and saved locally. No
 * cross-device history sync (same accepted limitation Encryption.md §9
 * already carries for postcards/files' per-device X25519 keys).
 *
 * UI: classic lively.morphic.Window chrome (proven drag/resize/close —
 * see the note below on why a from-scratch custom window shell was NOT
 * used here) wrapping a from-scratch, softer-styled content area (rounded
 * message bubbles, avatar, accent color) — the actual "new style" ground
 * for this session's other goal, deliberately scoped to the CONTENT area
 * rather than the window chrome itself. Reusing Window's own title
 * bar/close/drag avoids re-deriving two things this codebase has already
 * had to debug the hard way: (a) WarpDrop.md's bringToFront/remove()
 * teardown-ordering trap — addMorph() calls remove() on a morph that
 * already has an owner (confirmed by reading Core.js:284), so any custom
 * close/remove teardown here would hit the exact same hazard the moment
 * .comeForward() is called right after creation; (b) reinventing
 * title-bar-drag-only dragging correctly. Both are real, verifiable-later
 * follow-ups if a fully custom window shell is wanted, not skipped by
 * accident.
 */

module('lively.identity.DMChat')
  .requires(
    'lively.identity.Crypto',
    'lively.identity.DID',
    'lively.identity.WebAuthn',
    'lively.identity.PostCardUtils',
    'lively.persistence.BuildSpec',
  )
  .toRun(function () {

    Object.extend(lively.identity.DMChat, {

      // ─── window registry ────────────────────────────────────────────────

      _windows: {},       // peerHandle -> content-box morph
      _inboxWindow: null, // content-box morph
      _pollTimerId: null,
      _myDevicePub: null,       // cached for the session once fetched
      _didDocCache: {},         // handle -> DID document, cached for the session

      // Opens (or focuses) the 1:1 chat window for @peerHandle. peerDid is
      // required the first time a thread is opened (callers always have it
      // already — e.g. ProfileCard.js's friend nameplate rows carry both
      // f.handle and f.did); later opens of the same handle reuse whatever
      // window already exists.
      open: function (peerHandle, peerDid) {
        var existing = this._windows[peerHandle];
        if (existing && existing.world()) {
          existing.getWindow().comeForward();
          return existing;
        }
        var win = lively.BuildSpec('lively.identity.DMChatWindow').createMorph();
        var content = win.targetMorph || win.get('DMChatWindow');
        content._peerHandle = peerHandle;
        content._peerDid = peerDid;
        this._windows[peerHandle] = content;
        win.setTitle('@' + peerHandle);
        $world.addMorph(win);
        win.setPosition($world.visibleBounds().center().subPt(win.getExtent().scaleBy(0.5)));
        win.comeForward();
        content.startChat();
        this.ensurePolling();
        return content;
      },

      // Opens (or focuses + refreshes) the thread-list window.
      openInbox: function () {
        if (this._inboxWindow && this._inboxWindow.world()) {
          this._inboxWindow.getWindow().comeForward();
          this._inboxWindow.refresh();
          return this._inboxWindow;
        }
        var win = lively.BuildSpec('lively.identity.DMInboxWindow').createMorph();
        var content = win.targetMorph || win.get('DMInboxWindow');
        this._inboxWindow = content;
        $world.addMorph(win);
        win.setPosition($world.visibleBounds().center().subPt(win.getExtent().scaleBy(0.5)));
        win.comeForward();
        content.refresh();
        this.ensurePolling();
        return content;
      },

      // ─── local persistence (IndexedDB) — p2pchat.md §7 ─────────────────

      _DB_NAME: 'lively-dm-chat',
      _DB_VERSION: 1,
      _db: null,

      openDb: function (thenDo) {
        if (this._db) return thenDo(null, this._db);
        var self = this;
        var req = indexedDB.open(this._DB_NAME, this._DB_VERSION);
        req.onupgradeneeded = function (evt) {
          var db = evt.target.result;
          if (!db.objectStoreNames.contains('messages')) {
            var store = db.createObjectStore('messages', { keyPath: 'msgId' });
            store.createIndex('threadId', 'threadId', { unique: false });
          }
        };
        req.onsuccess = function (evt) { self._db = evt.target.result; thenDo(null, self._db); };
        req.onerror = function (evt) { thenDo(evt.target.error); };
      },

      // row: {msgId, threadId, peerHandle, peerDid, myDid, text, sentAt, direction: 'in'|'out'}
      saveLocalMessage: function (row, thenDo) {
        this.openDb(function (err, db) {
          if (err) return thenDo(err);
          var tx = db.transaction('messages', 'readwrite');
          tx.objectStore('messages').put(row);
          tx.oncomplete = function () { thenDo(null); };
          tx.onerror = function () { thenDo(tx.error); };
        });
      },

      listThreadMessages: function (threadId, thenDo) {
        this.openDb(function (err, db) {
          if (err) return thenDo(err);
          var idx = db.transaction('messages', 'readonly').objectStore('messages').index('threadId');
          var out = [];
          var req = idx.openCursor(IDBKeyRange.only(threadId));
          req.onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) { out.push(cursor.value); cursor.continue(); return; }
            out.sort(function (a, b) { return a.sentAt < b.sentAt ? -1 : 1; });
            thenDo(null, out);
          };
          req.onerror = function () { thenDo(req.error); };
        });
      },

      // Derives the thread list from IndexedDB alone (p2pchat.md §7 — there
      // is no server-side "who have I DMed" index by design). One row per
      // threadId, keeping whichever message has the latest sentAt.
      listThreads: function (thenDo) {
        this.openDb(function (err, db) {
          if (err) return thenDo(err);
          var store = db.transaction('messages', 'readonly').objectStore('messages');
          var byThread = {};
          var req = store.openCursor();
          req.onsuccess = function (evt) {
            var cursor = evt.target.result;
            if (cursor) {
              var row = cursor.value;
              var existing = byThread[row.threadId];
              if (!existing || row.sentAt > existing.lastSentAt) {
                byThread[row.threadId] = {
                  threadId: row.threadId, peerHandle: row.peerHandle, peerDid: row.peerDid,
                  lastText: row.text, lastSentAt: row.sentAt,
                };
              }
              cursor.continue();
              return;
            }
            var threads = Object.keys(byThread).map(function (k) { return byThread[k]; });
            threads.sort(function (a, b) { return a.lastSentAt < b.lastSentAt ? 1 : -1; });
            thenDo(null, threads);
          };
          req.onerror = function () { thenDo(req.error); };
        });
      },

      threadId: function (didA, didB) { return 'dm:' + [didA, didB].sort().join(':'); },

      newMsgId: function () {
        var bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return lively.identity.crypto.base64urlEncode(bytes);
      },

      // ─── crypto/network helpers ─────────────────────────────────────────

      // My own published device X25519 public key — plain profile data, no
      // WebAuthn ceremony needed to read it (only needed to derive the
      // matching PRIVATE half, which is only required when decrypting, not
      // sending — see getMyDeviceX25519 below).
      getMyDevicePub: function (thenDo) {
        if (this._myDevicePub) return thenDo(null, this._myDevicePub);
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        fetch('/@' + user.handle + '/profile', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (env) {
            var pub = env && env.record && env.record.payload && env.record.payload.accountX25519Pub;
            if (!pub) return thenDo(new Error('You need to enable encryption first — open your profile and click "Enable encryption".'));
            self._myDevicePub = pub;
            thenDo(null, pub);
          })
          .catch(thenDo);
      },

      fetchPeerProfile: function (peerHandle, thenDo) {
        fetch('/@' + peerHandle + '/profile', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (env) {
            if (!env) return thenDo(new Error('Could not load @' + peerHandle + '’s profile'));
            var payload = (env.record && env.record.payload) || {};
            thenDo(null, {
              did: env.did,
              devicePub: payload.accountX25519Pub || null,
              avatarUrl: payload.avatarUrl || null,
            });
          })
          .catch(thenDo);
      },

      _getDidDocument: function (handle, thenDo) {
        if (this._didDocCache[handle]) return thenDo(null, this._didDocCache[handle]);
        var self = this;
        fetch('/@' + handle + '/did-document', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (doc) { if (doc) self._didDocCache[handle] = doc; thenDo(null, doc); })
          .catch(thenDo);
      },

      // Signs an arbitrary payload with the current user's soft signing
      // key — mirrors PostCardSerializer.js's own _signEnvelopeIfPossible
      // exactly (same delegation-cert/KEK-unwrap dance), generalized to a
      // plain payload object instead of a full envelope, and fail-loud
      // (there's no sensible "send unsigned" fallback for a chat message —
      // the server would reject it anyway).
      signPayload: function (payload, thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        var method = lively.identity.did.findMethodByCredentialId(user.document, user.credentialId);
        if (!method || !method.lively || !method.lively.softSigningKeyWrapped || !method.lively.delegationCert) {
          return thenDo(new Error('Signing key not set up — open your profile and click "Enable encryption".'));
        }
        var livelyMeta = method.lively;
        var wa = lively.identity.webAuthn;
        var c = lively.identity.crypto;
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveKek({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, function (err, kek) {
          if (err) return thenDo(err);
          var wrapped;
          try { wrapped = JSON.parse(livelyMeta.softSigningKeyWrapped); } catch (e) { return thenDo(e); }
          c.decryptPayload(wrapped.ciphertext, wrapped.nonce, kek, function (err, softPrivJwk) {
            if (err) return thenDo(err);
            c.importPrivateKeyJwk(softPrivJwk, function (err, softPrivKey) {
              if (err) return thenDo(err);
              c.signJws(payload, softPrivKey, thenDo);
            });
          });
        });
      },

      // Only needed on the RECEIVING side, to open a sealed box addressed
      // to me — cached by WebAuthn.js itself across calls this session
      // (same pattern as deriveKek), so this prompts at most once per
      // session, not once per incoming message.
      getMyDeviceX25519: function (thenDo) {
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        var wa = lively.identity.webAuthn;
        var ch = new Uint8Array(32);
        crypto.getRandomValues(ch);
        wa.deriveX25519KeyPair({ credentialId: user.credentialId, rpId: user.rpId, challenge: ch }, thenDo);
      },

      // Client-side re-check that a mailbox row's signature really covers
      // its own fields and really validates against a delegation cert in
      // the claimed sender's DID document (p2pchat.md §4). Deliberately
      // does NOT re-verify the delegation cert's own WebAuthn-assertion
      // chain (CryptoVerify.js's verifyDelegationCert, server-side only) —
      // porting that CBOR/authenticatorData parsing to the browser is real
      // work with no client-side precedent yet, and the server already
      // enforces the full chain before a message is ever admitted to the
      // mailbox. This check's actual job is catching corruption/tampering
      // between mailbox and render, not standing alone as a full trust
      // boundary — same scope limitation Encryption.md §0 already
      // states for envelope-signature verification generally.
      verifyMessageSig: function (row, didDocument, thenDo) {
        var c = lively.identity.crypto;
        var expected = {
          msgId: row.msgId, threadId: row.threadId,
          senderDid: row.senderDid, recipientDid: row.recipientDid,
          ciphertext: row.ciphertext, sentAt: row.sentAt,
        };
        var parts = (row.sig || '').split('.');
        if (parts.length !== 3) return thenDo(null, false);
        var payloadJson;
        try { payloadJson = JSON.parse(new TextDecoder().decode(c.base64urlDecode(parts[1]))); }
        catch (e) { return thenDo(null, false); }
        if (c.canonicalJson(payloadJson) !== c.canonicalJson(expected)) return thenDo(null, false);
        var methods = (didDocument && didDocument.verificationMethod) || [];
        function checkNext(i) {
          if (i >= methods.length) return thenDo(null, false);
          var cert = methods[i].lively && methods[i].lively.delegationCert;
          if (!cert || !cert.devicePubKeyJwk) return checkNext(i + 1);
          c.verifyJws(row.sig, cert.devicePubKeyJwk, function (err, valid) {
            if (!err && valid) return thenDo(null, true);
            checkNext(i + 1);
          });
        }
        checkNext(0);
      },

      // ─── send / receive ─────────────────────────────────────────────────

      sendMessage: function (peerHandle, peerDid, text, thenDo) {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return thenDo(new Error('Not logged in'));
        this.fetchPeerProfile(peerHandle, function (err, peer) {
          if (err) return thenDo(err);
          if (!peer.devicePub) return thenDo(new Error('@' + peerHandle + ' hasn’t set up encryption yet.'));
          var plaintext = new TextEncoder().encode(JSON.stringify({ text: text }));
          lively.identity.crypto.sealForRecipient(plaintext, peer.devicePub, function (err, ciphertext) {
            if (err) return thenDo(err);
            var msgId = self.newMsgId();
            var threadId = self.threadId(user.did, peerDid);
            var sentAt = new Date().toISOString();
            var toSign = {
              msgId: msgId, threadId: threadId,
              senderDid: user.did, recipientDid: peerDid,
              ciphertext: ciphertext, sentAt: sentAt,
            };
            self.signPayload(toSign, function (err, sig) {
              if (err) return thenDo(err);
              self.getMyDevicePub(function (err, myDevicePub) {
                if (err) return thenDo(err);
                fetch('/@' + peerHandle + '/dm/mailbox', {
                  method: 'POST', credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    msgId: msgId, threadId: threadId, senderDevicePub: myDevicePub,
                    ciphertext: ciphertext, sig: sig, sentAt: sentAt,
                  }),
                }).then(function (res) {
                  if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || ('HTTP ' + res.status)); });
                  return res.json();
                }).then(function () {
                  self.saveLocalMessage({
                    msgId: msgId, threadId: threadId, peerHandle: peerHandle, peerDid: peerDid,
                    myDid: user.did, text: text, sentAt: sentAt, direction: 'out',
                  }, function (err) { thenDo(err || null); });
                }).catch(thenDo);
              });
            });
          });
        });
      },

      ensurePolling: function () {
        if (this._pollTimerId) return;
        var self = this;
        this._pollTimerId = setInterval(function () { self.pollOnce(); }, 4000);
        this.pollOnce();
      },

      pollOnce: function () {
        var self = this;
        var user = lively.identity.did.currentUser();
        if (!user) return;
        fetch('/@' + user.handle + '/dm/mailbox', { credentials: 'include' })
          .then(function (r) { return r.ok ? r.json() : { messages: [] }; })
          .then(function (data) {
            (data.messages || []).forEach(function (row) { self._handleIncoming(row, user); });
          })
          .catch(function () {});
      },

      _ackDelete: function (myHandle, msgId) {
        fetch('/@' + myHandle + '/dm/mailbox/' + msgId, { method: 'DELETE', credentials: 'include' }).catch(function () {});
      },

      _handleIncoming: function (row, user) {
        var self = this;
        if (!row.senderHandle) return; // can't attribute — leave queued rather than render as "unknown"
        this._getDidDocument(row.senderHandle, function (err, didDocument) {
          if (err || !didDocument) return; // retry next poll
          self.verifyMessageSig(row, didDocument, function (err, valid) {
            if (!valid) {
              console.warn('[DMChat] Dropping message with invalid signature from @' + row.senderHandle);
              return self._ackDelete(user.handle, row.msgId);
            }
            self.getMyDeviceX25519(function (err, pair) {
              if (err) return; // e.g. WebAuthn prompt dismissed this tick — retry next poll
              lively.identity.crypto.openSealedBox(row.ciphertext, pair.publicKey, pair.privateKey, function (err, plainBytes) {
                if (err) {
                  console.warn('[DMChat] Could not open sealed message from @' + row.senderHandle, err);
                  return self._ackDelete(user.handle, row.msgId);
                }
                var text;
                try { text = JSON.parse(new TextDecoder().decode(plainBytes)).text; }
                catch (e) { return self._ackDelete(user.handle, row.msgId); }
                self.saveLocalMessage({
                  msgId: row.msgId, threadId: row.threadId, peerHandle: row.senderHandle,
                  peerDid: row.senderDid, myDid: user.did, text: text, sentAt: row.sentAt, direction: 'in',
                }, function (err) {
                  if (err) { console.warn('[DMChat] Could not save incoming message locally', err); return; }
                  self._ackDelete(user.handle, row.msgId);
                  var win = self._windows[row.senderHandle];
                  if (win && win.world()) win.appendMessage(text, false);
                  else if ($world && $world.setStatusMessage) {
                    $world.setStatusMessage('New message from @' + row.senderHandle, Color.green);
                  }
                });
              });
            });
          });
        });
      },

      // ─── shared UI helpers (plain functions — safe to close over freely,
      // called FROM BuildSpec/addScript methods via this fully-qualified
      // path, never themselves reconstructed from source; see this file's
      // header and CLAUDE.md's BuildSpec-closure-loss section) ───────────

      createMessageBubble: function (text, isOwn, width) {
        var maxW = Math.floor(width * 0.72), pad = 10, textW = maxW - pad * 2;
        var estLines = Math.ceil(text.length * 8 / textW) + 1;
        var t = new lively.morphic.Text(lively.rect(0, 0, textW, estLines * 18), text);
        t.applyStyle({
          fixedWidth: true, fixedHeight: false,
          fontSize: 13, fontFamily: 'sans-serif',
          fill: null, borderWidth: 0, allowInput: false,
          lineWrapping: 'by-words',
        });
        if (t.setLineWrapping) t.setLineWrapping('by-words');
        t.fit();
        var bH = t.getExtent().y + pad * 2;
        var bubble = new lively.morphic.Box(lively.rect(0, 0, maxW, bH));
        bubble.applyStyle({
          fill: isOwn ? Color.rgb(88, 101, 242) : Color.rgb(237, 237, 241),
          borderRadius: 14, borderWidth: 0, clipMode: 'visible',
        });
        t.setPosition(lively.pt(pad, pad));
        t.setTextColor(isOwn ? Color.white : Color.rgb(30, 30, 30));
        bubble.addMorph(t);
        t.draggingEnabled = false; t.droppingEnabled = false; t.grabbingEnabled = false; t.eventsAreIgnored = true;
        bubble.draggingEnabled = false; bubble.droppingEnabled = false; bubble.grabbingEnabled = false;
        var row = new lively.morphic.Box(lively.rect(0, 0, width - 16, bH + 6));
        row.applyStyle({ fill: null, borderWidth: 0 });
        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        bubble.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, 3));
        row.addMorph(bubble);
        return row;
      },

      // A clickable thread row for the inbox window. Stores peerHandle/
      // peerDid directly on the morph (not closed over) since its
      // onMouseUp is installed via addScript on a live instance.
      createThreadRow: function (thread, width) {
        var ROWH = 60, AVSZ = 40;
        var row = new lively.morphic.Box(lively.rect(0, 0, width, ROWH));
        row.applyStyle({ fill: Color.white, borderWidth: 0 });
        row._peerHandle = thread.peerHandle;
        row._peerDid = thread.peerDid;
        row.handStyle = 'pointer';

        var avatarImg = new lively.morphic.Image(lively.rect(10, 10, AVSZ, AVSZ));
        avatarImg.setImageURL(lively.identity.postCardUtils.identiconDataUrl(thread.peerHandle, AVSZ));
        avatarImg.applyStyle({ borderRadius: AVSZ / 2, borderWidth: 0, clipMode: 'hidden' });
        avatarImg.draggingEnabled = false; avatarImg.droppingEnabled = false; avatarImg.grabbingEnabled = false;
        avatarImg.eventsAreIgnored = true;
        row.addMorph(avatarImg);

        var nameM = new lively.morphic.Text(lively.rect(60, 10, width - 72, 18), '@' + thread.peerHandle);
        nameM.applyStyle({ allowInput: false, fontSize: 13, fontWeight: 'bold',
          fill: null, borderWidth: 0, textColor: Color.rgb(30, 30, 30) });
        nameM.draggingEnabled = false; nameM.droppingEnabled = false; nameM.grabbingEnabled = false;
        nameM.eventsAreIgnored = true;
        row.addMorph(nameM);

        var preview = (thread.lastText || '').replace(/\s+/g, ' ').trim();
        if (preview.length > 48) preview = preview.slice(0, 47) + '…';
        var previewM = new lively.morphic.Text(lively.rect(60, 30, width - 72, 18), preview);
        previewM.applyStyle({ allowInput: false, fontSize: 12,
          fill: null, borderWidth: 0, textColor: Color.rgb(120, 120, 128) });
        previewM.draggingEnabled = false; previewM.droppingEnabled = false; previewM.grabbingEnabled = false;
        previewM.eventsAreIgnored = true;
        row.addMorph(previewM);

        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        row.addScript(function onMouseUp(evt) {
          lively.identity.DMChat.open(this._peerHandle, this._peerDid);
          evt.stop(); return true;
        });
        return row;
      },

    });

    // ─── DMChatWindow: one-on-one conversation ───────────────────────────
    // Classic Window chrome (see this file's header for why) wrapping a
    // from-scratch content area — the actual visual-style experimentation
    // ground for this session's window-foundation goal.

    lively.BuildSpec('lively.identity.DMChatWindow', {
      _BorderColor: Color.rgb(95, 94, 95),
      _Extent: lively.pt(360, 480),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(4, 22),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      name: "DMChatWindow",
      submorphs: [{
        _BorderColor: Color.rgb(224, 224, 232),
        _BorderRadius: 10,
        _BorderWidth: 1,
        _Extent: lively.pt(352, 454),
        _Fill: Color.rgb(250, 250, 252),
        className: "lively.morphic.Box",
        _ClipMode: "hidden",
        doNotSerialize: ["_peerHandle", "_peerDid"],
        droppingEnabled: false,
        layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
        name: "DMChatWindow",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
          // ── peer info strip ───────────────────────────────────────────
          _Extent: lively.pt(352, 44),
          _Fill: Color.rgb(88, 101, 242),
          _Position: lively.pt(0, 0),
          className: "lively.morphic.Box",
          name: "PeerInfo",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
          submorphs: [{
            // Sole label for the peer's identity in this strip — the
            // classic Window's own title bar (win.setTitle, in
            // DMChat.open) already shows '@handle' in text, so this strip
            // only needs the avatar, not a second redundant name label.
            // (A duplicate "PeerName" Text morph here was a real,
            // confirmed-live cosmetic bug — see p2pchat.md's "Live
            // verification results" section — removed rather than kept
            // alongside the title bar's own copy.)
            _Extent: lively.pt(28, 28),
            _Position: lively.pt(162, 8),
            className: "lively.morphic.Image",
            name: "PeerAvatar",
            sourceModule: "lively.morphic.Core",
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
          }],
        }, {
          // ── message thread ────────────────────────────────────────────
          _Extent: lively.pt(352, 454 - 44 - 56),
          _Fill: Color.white,
          _Position: lively.pt(0, 44),
          className: "lively.morphic.Box",
          name: "MessageList",
          _ClipMode: "scroll",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
        }, {
          // ── input row ──────────────────────────────────────────────────
          _Extent: lively.pt(352, 56),
          _Fill: Color.rgb(250, 250, 252),
          _Position: lively.pt(0, 454 - 56),
          className: "lively.morphic.Box",
          name: "InputRow",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
          submorphs: [{
            _BorderColor: Color.rgb(214, 214, 222),
            _BorderRadius: 8,
            _BorderWidth: 1,
            _Extent: lively.pt(352 - 24, 32),
            _Fill: Color.white,
            _Position: lively.pt(12, 12),
            className: "lively.morphic.Text",
            name: "InputField",
            textString: "",
            style: {
              fixedWidth: true, fixedHeight: true, clipMode: 'hidden', allowInput: true,
              fontSize: 13, padding: lively.rect(8, 6, 8, 6),
            },
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
            onFromBuildSpecCreated: function onFromBuildSpecCreated() {
              this.beInputLine({ fixedWidth: true });
            },
            onLoad: function onLoad() {
              $super();
              this.beInputLine({ fixedWidth: true });
            },
            onKeyDown: function onKeyDown(evt) {
              if (evt.getKeyString() === 'Enter') {
                this.get('DMChatWindow').sendCurrentInput();
                evt.stop(); return true;
              }
              return $super(evt);
            },
          }],
        }],

        startChat: function startChat() {
          var self = this;
          this.get('PeerAvatar').setImageURL(
            lively.identity.postCardUtils.identiconDataUrl(this._peerHandle, 28));
          lively.identity.DMChat.fetchPeerProfile(this._peerHandle, function (err, peer) {
            if (err || !self.world()) return;
            if (peer.avatarUrl) self.get('PeerAvatar').setImageURL(peer.avatarUrl);
            if (peer.did && !self._peerDid) self._peerDid = peer.did;
          });
          var user = lively.identity.did.currentUser();
          if (!user || !this._peerDid) return;
          var threadId = lively.identity.DMChat.threadId(user.did, this._peerDid);
          lively.identity.DMChat.listThreadMessages(threadId, function (err, rows) {
            if (err || !rows || !self.world()) return;
            rows.forEach(function (row) { self.appendMessage(row.text, row.direction === 'out'); });
          });
        },

        appendMessage: function appendMessage(text, isOwn) {
          var list = this.get('MessageList');
          var width = list.getExtent().x;
          var y = list.submorphs.length ? list.submorphs.last().bounds().bottom() + 4 : 8;
          var row = lively.identity.DMChat.createMessageBubble(text, isOwn, width);
          row.setPosition(lively.pt(8, y));
          list.addMorph(row);
          list.scrollToBottom();
        },

        sendCurrentInput: function sendCurrentInput() {
          var self = this;
          var field = this.get('InputField');
          var text = (field.textString || '').trim();
          if (!text) return;
          field.textString = '';
          lively.identity.DMChat.sendMessage(this._peerHandle, this._peerDid, text, function (err) {
            if (err) {
              $world.setStatusMessage('Could not send: ' + err.message, Color.red);
              field.textString = text;
              return;
            }
            self.appendMessage(text, true);
          });
        },

        onWindowGetsFocus: function onWindowGetsFocus() {
          this.get('InputField').focus();
        },
      }],
      titleBar: "Direct message",
    });

    // ─── DMInboxWindow: thread list ───────────────────────────────────────

    lively.BuildSpec('lively.identity.DMInboxWindow', {
      _BorderColor: Color.rgb(95, 94, 95),
      _Extent: lively.pt(320, 440),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(4, 22),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      name: "DMInboxWindow",
      submorphs: [{
        _BorderColor: Color.rgb(224, 224, 232),
        _BorderRadius: 10,
        _BorderWidth: 1,
        _Extent: lively.pt(312, 414),
        _Fill: Color.white,
        className: "lively.morphic.Box",
        _ClipMode: "hidden",
        droppingEnabled: false,
        layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
        name: "DMInboxWindow",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
          _Extent: lively.pt(312, 414),
          _Fill: Color.white,
          _Position: lively.pt(0, 0),
          className: "lively.morphic.Box",
          name: "ThreadList",
          _ClipMode: "scroll",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
        }],

        refresh: function refresh() {
          var self = this;
          var list = this.get('ThreadList');
          list.removeAllMorphs();
          lively.identity.DMChat.listThreads(function (err, threads) {
            if (err || !self.world()) return;
            if (!threads.length) {
              var msg = new lively.morphic.Text(lively.rect(12, 16, list.getExtent().x - 24, 40),
                'No conversations yet — message a friend from their profile.');
              msg.applyStyle({ allowInput: false, fontSize: 12, fill: null, borderWidth: 0,
                textColor: Color.rgb(140, 140, 148), lineWrapping: 'by-words' });
              if (msg.setLineWrapping) msg.setLineWrapping('by-words');
              list.addMorph(msg);
              return;
            }
            threads.forEach(function (thread, i) {
              var row = lively.identity.DMChat.createThreadRow(thread, list.getExtent().x);
              row.setPosition(lively.pt(0, i * 60));
              list.addMorph(row);
            });
          });
        },
      }],
      titleBar: "Messages",
    });

  }); // end module('lively.identity.DMChat')
