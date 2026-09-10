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

      // ─── visual constants (2026-09-10 design pass) ─────────────────────
      // Named here, on the namespace object, rather than as closure vars —
      // BuildSpec-literal methods and addScript handlers below reference
      // these via this fully-qualified path (lively.identity.DMChat.ACCENT
      // etc.), since a bare closure var would throw "not defined" the
      // moment those methods run (see this file's header / CLAUDE.md's
      // BuildSpec-closure-loss section).
      ACCENT:      Color.rgb(88, 101, 242),   // header / own-bubble / send-button accent
      ACCENT_SOFT: Color.rgba(255, 255, 255, 0.14), // hover tint over the accent header
      BUBBLE_OWN:   Color.rgb(88, 101, 242),
      BUBBLE_OTHER: Color.rgb(237, 237, 241),
      ROW_HOVER:    Color.rgb(248, 248, 252),

      // Recolors a classic lively.morphic.Window's own title bar to match
      // this feature's accent, so the stock chrome and the from-scratch
      // content area read as one cohesive header instead of two competing
      // bars (p2pchat.md's "UI is not visually finished" note — this was
      // the single biggest visual complaint). Only touches fill/label
      // color, never the TitleBar's own layout/drag/button logic.
      styleWindowChrome: function (win) {
        var tb = win.titleBar;
        tb.applyStyle({ fill: this.ACCENT, borderWidth: 0 });
        tb.label.setTextColor(Color.white);
        tb.label.applyStyle({ fontWeight: 'bold' });
        // The applyStyle/setTextColor calls above update Lively's own
        // model state correctly (getFill()/getTextColor() report the new
        // values) but — confirmed live, a real DOM/pixel check, not just
        // a screenshot — never actually reach the rendered title bar node.
        // This matches feedback_morph_dialog_baseline_polish's already-
        // documented gotcha for morphs styled procedurally after creation
        // ("border-width is the one style property that DOES reach the
        // DOM via the model layer" — everything else here needed the
        // direct-DOM fallback that memory prescribes).
        var tbNode = tb.renderContext && tb.renderContext().shapeNode;
        if (tbNode) tbNode.style.background = this.ACCENT.toString();
        var labelNode = tb.label.renderContext && tb.label.renderContext().shapeNode;
        if (labelNode) {
          labelNode.style.color = '#fff';
          labelNode.style.fontWeight = 'bold';
          var inner = labelNode.querySelector('div');
          if (inner) { inner.style.color = '#fff'; inner.style.fontWeight = 'bold'; }
        }
        // A window with a real border (e.g. DMInboxWindow's 11px frame)
        // needs its title bar inset by that same amount — otherwise the
        // title bar (a child positioned at the window's own (0,0), same
        // width as the window's full declared extent) sits flush with the
        // OUTER edge of the window and visually covers/erases the border
        // for its own height, instead of the border wrapping evenly around
        // all four sides including the top. This reuses the EXISTING
        // classic titleBar morph (just repositions/resizes it) rather than
        // adding a second one. Reading the border width back from the
        // window itself (not a hardcoded number) keeps this correct for
        // any window regardless of its own border, and is a no-op for a
        // window with no real border (DMChatWindow today).
        var borderW = win.getBorderWidth() || 0;
        if (borderW > 0) {
          var winExtent = win.getExtent();
          var titleH = tb.getExtent().y;
          tb.setPosition(lively.pt(borderW, borderW));
          tb.setExtent(lively.pt(winExtent.x - borderW * 2, titleH));
          if (tb.adjustElementPositions) tb.adjustElementPositions();
        }
      },

      _formatTime: function (isoOrNull) {
        var d = isoOrNull ? new Date(isoOrNull) : new Date();
        var h = d.getHours(), m = d.getMinutes();
        var ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12; if (h === 0) h = 12;
        return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
      },

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
        // Must come AFTER addMorph — styling a title bar that hasn't been
        // rendered into the live DOM yet is the same class of bug as
        // Text#fit() needing a real world/DOM to measure against (see
        // _fitBubble above): the model layer happily reports the new
        // fill/textColor, but the actual paint can silently keep using
        // whatever was baked in at BuildSpec-creation time. Confirmed live
        // during this pass — calling it pre-addMorph left one window's
        // title bar genuinely unstyled (verified via a real screenshot,
        // not just getFill()) while another, by pure luck of render
        // timing, looked right.
        this.styleWindowChrome(win);
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
        this.styleWindowChrome(win); // must come after addMorph — see open()'s comment
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
                  if (win && win.world()) win.appendMessage(text, false, row.sentAt);
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

      createMessageBubble: function (text, isOwn, width, sentAt) {
        var NS = lively.identity.DMChat;
        var maxW = Math.floor(width * 0.72), pad = 10, textW = maxW - pad * 2;
        // Deliberately just a placeholder height, not a real measurement —
        // Text#fit() (TextCore.js) is a documented no-op until this morph
        // is actually in the world ("we cannot figure out the real bounds
        // before we are in DOM anyway"), and this bubble hasn't been added
        // to anything yet at this point. A real, confirmed-live bug from
        // calling .fit() here anyway: it silently did nothing, leaving a
        // crude char-count heuristic as the FINAL height, which overshot
        // badly for wrapped multi-line messages (a ~60-char message came
        // out ~210px tall instead of ~90px — visible as a huge dead-space
        // bubble). Real sizing now happens in _fitBubble, called from
        // appendMessage right after this row is actually inserted into the
        // live MessageList — see CLAUDE.md's "measure after insertion"
        // Text-morph rule.
        var t = new lively.morphic.Text(lively.rect(0, 0, textW, 18), text);
        t.applyStyle({
          fixedWidth: true, fixedHeight: false,
          fontSize: 13, fontFamily: 'sans-serif',
          fill: null, borderWidth: 0, allowInput: false,
          lineWrapping: 'by-words',
        });
        if (t.setLineWrapping) t.setLineWrapping('by-words');
        var bH = 18 + pad * 2;
        var bubble = new lively.morphic.Box(lively.rect(0, 0, maxW, bH));
        bubble.applyStyle({
          fill: isOwn ? NS.BUBBLE_OWN : NS.BUBBLE_OTHER,
          // Asymmetric "tail" corner — sharper on the side that points at
          // the screen edge the bubble is aligned to — reads as a real
          // chat bubble instead of a plain uniformly-rounded rectangle.
          // Per-corner CSS shorthand (TL TR BR BL), same idiom already
          // used by TitleBar#lookCollapsedOrNot elsewhere in this codebase.
          borderRadius: isOwn ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          borderWidth: 0, clipMode: 'visible',
        });
        t.setPosition(lively.pt(pad, pad));
        t.setTextColor(isOwn ? Color.white : Color.rgb(30, 30, 30));
        bubble.addMorph(t);
        t.draggingEnabled = false; t.droppingEnabled = false; t.grabbingEnabled = false; t.eventsAreIgnored = true;
        bubble.draggingEnabled = false; bubble.droppingEnabled = false; bubble.grabbingEnabled = false;

        var TS_H = 16;
        var row = new lively.morphic.Box(lively.rect(0, 0, width - 16, bH + 3 + TS_H));
        row.applyStyle({ fill: null, borderWidth: 0 });
        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        bubble.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, 3));
        row.addMorph(bubble);

        var ts = new lively.morphic.Text(lively.rect(0, bH + 3 + 2, maxW, TS_H - 2), NS._formatTime(sentAt));
        ts.applyStyle({
          fixedWidth: true, fixedHeight: true, allowInput: false,
          fontSize: 10, fontFamily: 'sans-serif',
          fill: null, borderWidth: 0, textColor: Color.rgb(150, 150, 158),
          align: isOwn ? 'right' : 'left',
        });
        ts.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, bH + 3 + 2));
        ts.draggingEnabled = false; ts.droppingEnabled = false; ts.grabbingEnabled = false; ts.eventsAreIgnored = true;
        row.addMorph(ts);

        // Plain data properties, read back by the equally-plain _fitBubble
        // method below (never reconstructed from source — only BuildSpec-
        // literal methods and addScript handlers are) — safe to stash and
        // reuse.
        row._msgText = t; row._msgBubble = bubble; row._msgTs = ts;
        row._msgIsOwn = isOwn; row._msgMaxW = maxW; row._msgPad = pad; row._msgWidth = width;
        return row;
      },

      // Must be called only AFTER `row` (from createMessageBubble) has
      // actually been added into a MessageList that's already in the
      // world — re-measures the Text morph's real wrapped height (the
      // thing createMessageBubble's own placeholder guess above couldn't
      // do yet) and resizes the bubble/timestamp/row to match.
      _fitBubble: function (row) {
        var t = row._msgText, bubble = row._msgBubble, ts = row._msgTs;
        var isOwn = row._msgIsOwn, maxW = row._msgMaxW, pad = row._msgPad, width = row._msgWidth;
        t.fit();
        var bH = t.getExtent().y + pad * 2;
        bubble.setExtent(lively.pt(maxW, bH));
        bubble.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, 3));
        var TS_H = 16;
        ts.setPosition(lively.pt(isOwn ? (width - 16 - maxW) : 0, bH + 3 + 2));
        row.setExtent(lively.pt(width - 16, bH + 3 + TS_H));
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

        var divider = new lively.morphic.Box(lively.rect(12, ROWH - 1, width - 24, 1));
        divider.applyStyle({ fill: Color.rgb(232, 232, 238), borderWidth: 0 });
        divider.draggingEnabled = false; divider.droppingEnabled = false; divider.grabbingEnabled = false;
        divider.eventsAreIgnored = true;
        row.addMorph(divider);

        var avatarImg = new lively.morphic.Image(lively.rect(10, 10, AVSZ, AVSZ));
        avatarImg.setImageURL(lively.identity.postCardUtils.identiconDataUrl(thread.peerHandle, AVSZ));
        avatarImg.applyStyle({ borderRadius: AVSZ / 2, borderWidth: 0, clipMode: 'hidden' });
        avatarImg.draggingEnabled = false; avatarImg.droppingEnabled = false; avatarImg.grabbingEnabled = false;
        avatarImg.eventsAreIgnored = true;
        row.addMorph(avatarImg);

        var nameM = new lively.morphic.Text(lively.rect(60, 10, width - 72, 18), '@' + thread.peerHandle);
        nameM.applyStyle({ allowInput: false, fontSize: 13, fontWeight: 'bold',
          fill: null, borderWidth: 0, textColor: Color.rgb(30, 30, 30),
          // Single-line label — without this, a long handle can wrap onto
          // a second line and, since the box height is a fixed 18px with
          // no clip, that second line silently bleeds down past the row
          // (confirmed live, same bug the preview label below had,
          // matching AmbientPresencePanel.js's own name/status labels'
          // idiom for a one-line box).
          clipMode: 'hidden', whiteSpaceHandling: 'pre' });
        nameM.draggingEnabled = false; nameM.droppingEnabled = false; nameM.grabbingEnabled = false;
        nameM.eventsAreIgnored = true;
        row.addMorph(nameM);

        var preview = (thread.lastText || '').replace(/\s+/g, ' ').trim();
        if (preview.length > 48) preview = preview.slice(0, 47) + '…';
        var previewM = new lively.morphic.Text(lively.rect(60, 30, width - 72, 18), preview);
        previewM.applyStyle({ allowInput: false, fontSize: 12,
          fill: null, borderWidth: 0, textColor: Color.rgb(120, 120, 128),
          // Real, confirmed-live bug fixed here: a 47-char preview can
          // still be wider than this box at 12px (character width varies,
          // the truncation above is char-count not measured-width), so it
          // wrapped onto a second line that — with no clipMode set —
          // visibly overlapped the divider/next row instead of just
          // getting cut off. clipMode:'hidden' + whiteSpaceHandling:'pre'
          // makes it a real single-line, safely-truncated label instead.
          clipMode: 'hidden', whiteSpaceHandling: 'pre' });
        previewM.draggingEnabled = false; previewM.droppingEnabled = false; previewM.grabbingEnabled = false;
        previewM.eventsAreIgnored = true;
        row.addMorph(previewM);

        row.draggingEnabled = false; row.droppingEnabled = false; row.grabbingEnabled = false;
        row.addScript(function onMouseOver() {
          this.applyStyle({ fill: lively.identity.DMChat.ROW_HOVER });
        });
        row.addScript(function onMouseOut() {
          this.applyStyle({ fill: Color.white });
        });
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
        // Real, confirmed-live bug fixed here: this content pane never had
        // an explicit _Position, so it defaulted to (0,0) — flush with the
        // WINDOW's own top-left corner — instead of respecting the
        // Window's own contentOffset (4,22) above. contentOffset only
        // feeds the Window's initial bounds math, it does NOT reposition
        // a target morph supplied declaratively via BuildSpec submorphs.
        // Net effect: this whole content pane silently overlapped the
        // title bar's own 22px band. Usually invisible by luck (PeerInfo's
        // first 60px absorbed the overlap, leaving only its own avatar
        // slightly high), but on DMInboxWindow — no such buffer — it
        // visibly clipped the first thread row's avatar/text under the
        // title bar (confirmed via a live getBoundingClientRect() compare:
        // content top === window top, not window top + 22).
        _Position: lively.pt(4, 22),
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
          // Same accent as the (now-recolored, see DMChat.styleWindowChrome)
          // classic title bar above it, so the two read as one continuous
          // header block rather than two mismatched bars — the single
          // biggest visual complaint from the first pass (p2pchat.md).
          _Extent: lively.pt(352, 60),
          _Fill: Color.rgb(88, 101, 242),
          _Position: lively.pt(0, 0),
          className: "lively.morphic.Box",
          name: "PeerInfo",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
          submorphs: [{
            // Sole label for the peer's *identity* in this strip — the
            // classic Window's own title bar (win.setTitle, in
            // DMChat.open) already shows '@handle' in text, so this strip
            // only needs the avatar, not a second redundant name label.
            // (A duplicate "PeerName" Text morph here was a real,
            // confirmed-live cosmetic bug — see p2pchat.md's "Live
            // verification results" section — removed rather than kept
            // alongside the title bar's own copy.)
            _Extent: lively.pt(28, 28),
            _Position: lively.pt(162, 6),
            className: "lively.morphic.Image",
            name: "PeerAvatar",
            sourceModule: "lively.morphic.Core",
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
          }, {
            // Accurate, not decorative — this feature really is real E2EE
            // (p2pchat.md §4). One Text morph (not an icon-font glyph next
            // to a separate label) so it shares a single baseline — see
            // CLAUDE.md's "two fonts don't share a baseline" gotcha.
            _Extent: lively.pt(352, 16),
            _Position: lively.pt(0, 38),
            className: "lively.morphic.Text",
            name: "EncryptedCaption",
            textString: "🔒 End-to-end encrypted",
            style: {
              fixedWidth: true, fixedHeight: true, allowInput: false,
              fontSize: 10, fontFamily: 'sans-serif', align: 'center',
              fill: null, borderWidth: 0, textColor: Color.rgba(255, 255, 255, 0.82),
            },
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
          }],
        }, {
          // ── message thread ────────────────────────────────────────────
          _Extent: lively.pt(352, 454 - 60 - 64),
          _Fill: Color.white,
          _Position: lively.pt(0, 60),
          className: "lively.morphic.Box",
          name: "MessageList",
          // {x:'hidden', y:'scroll'} not the bare string 'scroll' — the
          // bare form scrolls BOTH axes, which showed a permanent, unused
          // horizontal scrollbar the full width of the window (confirmed
          // live via screenshot during this design pass; bubbles never
          // actually overflow horizontally, they're capped at 72% of the
          // list's own width). Per-side clip mode per HTML.js's own
          // setClipModeHTMLForNode.
          _ClipMode: { x: "hidden", y: "scroll" },
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
        }, {
          // ── input row ──────────────────────────────────────────────────
          _Extent: lively.pt(352, 64),
          _Fill: Color.rgb(250, 250, 252),
          _Position: lively.pt(0, 454 - 64),
          className: "lively.morphic.Box",
          name: "InputRow",
          droppingEnabled: false,
          draggingEnabled: false, grabbingEnabled: false,
          submorphs: [{
            _BorderColor: Color.rgb(214, 214, 222),
            _BorderRadius: 18,
            _BorderWidth: 1,
            _Extent: lively.pt(280, 36),
            _Fill: Color.white,
            _Position: lively.pt(12, 14),
            className: "lively.morphic.Text",
            name: "InputField",
            textString: "",
            style: {
              fixedWidth: true, fixedHeight: true, clipMode: 'hidden', allowInput: true,
              fontSize: 13, padding: lively.rect(12, 8, 8, 8),
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
          }, {
            // Round accent send button, Material Symbols "send" glyph —
            // same icon-button idiom as AmbientPresencePanel.js's
            // mic/headset/settings buttons (vertical centering via a
            // top-padding offset, since applyStyle({verticalAlign}) is a
            // no-op on a multi-line-capable Text box per CLAUDE.md).
            _BorderWidth: 0,
            _BorderRadius: 20,
            _Extent: lively.pt(40, 40),
            _Fill: Color.rgb(88, 101, 242),
            _Position: lively.pt(300, 12),
            className: "lively.morphic.Text",
            name: "SendButton",
            textString: "send",
            style: {
              fontFamily: "'Material Symbols Rounded'",
              fontSize: 15, // renders ~20px (pt, not px — see CLAUDE.md)
              textColor: Color.white,
              align: 'center',
              padding: lively.rect(0, Math.round((40 - 20) / 2), 0, 0),
              allowInput: false, selectable: false, clipMode: 'hidden',
              whiteSpaceHandling: 'pre',
            },
            handStyle: 'pointer',
            draggingEnabled: false, droppingEnabled: false, grabbingEnabled: false,
            onMouseOver: function onMouseOver() {
              this.applyStyle({ fill: Color.rgb(66, 79, 220) });
            },
            onMouseOut: function onMouseOut() {
              this.applyStyle({ fill: lively.identity.DMChat.ACCENT });
            },
            onMouseUp: function onMouseUp(evt) {
              this.get('DMChatWindow').sendCurrentInput();
              evt.stop(); return true;
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
            rows.forEach(function (row) { self.appendMessage(row.text, row.direction === 'out', row.sentAt); });
          });
        },

        appendMessage: function appendMessage(text, isOwn, sentAt) {
          var list = this.get('MessageList');
          var width = list.getExtent().x;
          var y = list.submorphs.length ? list.submorphs.last().bounds().bottom() + 4 : 8;
          var row = lively.identity.DMChat.createMessageBubble(text, isOwn, width, sentAt);
          row.setPosition(lively.pt(8, y));
          list.addMorph(row);
          lively.identity.DMChat._fitBubble(row);
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
      _BorderColor: Color.rgb(0xD0, 0xB0, 0xB0),
      _BorderRadius: 16,
      _BorderWidth: 11,
      _Extent: lively.pt(320, 440),
      _Fill: Color.rgb(0xCC, 0x00, 0x57),
      className: "lively.morphic.Window",
      contentOffset: lively.pt(4, 22),
      draggingEnabled: true,
      layout: { adjustForNewBounds: true },
      name: "DMInboxWindow",
      submorphs: [{
        _BorderColor: Color.rgb(224, 224, 232),
        _BorderRadius: 10,
        _BorderWidth: 1,
        // Inset by the window's own 11px border on all sides, plus the
        // 22px title bar height on top — matches styleWindowChrome's own
        // runtime inset of the title bar itself (see DMChat.styleWindowChrome),
        // so the border wraps evenly around title bar + content instead of
        // the content pane poking out past/underneath it.
        _Extent: lively.pt(320 - 11 * 2, 440 - 11 - 22 - 11),
        _Position: lively.pt(11, 11 + 22),
        _Fill: Color.white,
        className: "lively.morphic.Box",
        _ClipMode: "hidden",
        droppingEnabled: false,
        layout: { adjustForNewBounds: true, resizeHeight: true, resizeWidth: true },
        name: "DMInboxWindow",
        sourceModule: "lively.morphic.Core",
        submorphs: [{
          _Extent: lively.pt(320 - 11 * 2, 440 - 11 - 22 - 11), // matches the content pane's own extent above
          _Fill: Color.white,
          _Position: lively.pt(0, 0),
          className: "lively.morphic.Box",
          name: "ThreadList",
          _ClipMode: { x: "hidden", y: "scroll" }, // see DMChatWindow's MessageList for why not the bare 'scroll' string
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
              var w = list.getExtent().x, h = list.getExtent().y;
              var icon = new lively.morphic.Text(lively.rect(0, Math.round(h / 2) - 60, w, 40), 'forum');
              icon.applyStyle({
                fontFamily: "'Material Symbols Rounded'", fontSize: 27, // ~36px
                fixedWidth: true, fixedHeight: true, allowInput: false, align: 'center',
                fill: null, borderWidth: 0, textColor: Color.rgb(210, 210, 218),
              });
              list.addMorph(icon);
              var msg = new lively.morphic.Text(lively.rect(24, Math.round(h / 2) - 14, w - 48, 40),
                'No conversations yet\nMessage a friend from their profile.');
              msg.applyStyle({ allowInput: false, fontSize: 12, align: 'center', fill: null, borderWidth: 0,
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
