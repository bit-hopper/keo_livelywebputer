/**
 * lively.identity.WarpDrop
 *
 * Local-network P2P file transfer (PairDrop-inspired). Discovers other
 * browser tabs on the same local network via WarpDropSignalingServer.js
 * (grouped server-side by IP) and sends a file directly to one over a
 * WebRTC data channel -- the file itself is never relayed through the
 * server. Peer discovery is intentionally not tied to Lively identity/
 * login: a peer is just another connected browser, shown under a random
 * food/fruit display name assigned by the signaling server, with a
 * blockie-style identicon (same generator as ProfileCard.js) keyed on
 * its peerId.
 *
 * Receiving a file: if the current browser has a signed-in Lively
 * session (lively.identity.did.isLoggedIn()), the received file is
 * saved directly to that user's upload space under uploads/WarpDrop/
 * (same PUT endpoint FilesBrowser uses) instead of triggering a browser
 * download, so it shows up in FilesBrowser afterward. Anonymous/
 * logged-out receivers still get a plain browser download.
 *
 * Entry points:
 *   lively.identity.WarpDrop.open()          -- from FilesBrowser's Drop button
 *   GET /warpdrop                            -- standalone world, see IdentityServer.js
 *
 * See WarpDrop.md for the full design writeup.
 */

module('lively.identity.WarpDrop')
  .requires('lively.Network', 'lively.identity.DID')
  .toRun(function () {

    var CHUNK_SIZE = 16 * 1024;
    var MAX_FILE_SIZE = 500 * 1024 * 1024; // guards the receiver's in-memory Blob-assembly buffer
    var BUFFERED_AMOUNT_LOW_THRESHOLD = 1024 * 1024;
    var ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
    var DISCONNECT_ABORT_MS = 12 * 1000;
    var AVATAR_SIZE = 40;
    var SAVE_FOLDER = 'WarpDrop';
    var MOBILE_BREAKPOINT = 600; // px -- below this, open() sizes near-fullscreen instead of the fixed desktop box
    var MOBILE_MARGIN = 12;

    // Same blockie-identicon algorithm as ProfileCard.js's avatar
    // fallback (xorshift128 PRNG seeded from the string, mirrored 8x8
    // grid, 3-color HSL palette) -- extracted to return a plain data
    // URL instead of a morphic Image, since peer cards here are raw DOM.
    function makeBlockieDataUrl(seed, size) {
      var SZ = 8, SC = Math.ceil(size / SZ);
      var rs = [0, 0, 0, 0];
      for (var i = 0; i < seed.length; i++) {
        rs[i % 4] = ((rs[i % 4] << 5) - rs[i % 4]) + seed.charCodeAt(i);
        rs[i % 4] |= 0;
      }
      function rnd() {
        var t = rs[0] ^ (rs[0] << 11);
        rs[0] = rs[1]; rs[1] = rs[2]; rs[2] = rs[3];
        rs[3] = (rs[3] ^ (rs[3] >> 19) ^ t ^ (t >> 8));
        return (rs[3] >>> 0) / ((1 << 31) >>> 0);
      }
      function hsl() {
        return 'hsl(' + Math.floor(rnd() * 360) + ',' +
          (rnd() * 60 + 40) + '%,' +
          ((rnd() + rnd() + rnd() + rnd()) * 25) + '%)';
      }
      var fg = hsl(), bg = hsl(), spot = hsl();
      var half = Math.ceil(SZ / 2);
      var cells = [];
      for (var r = 0; r < SZ; r++) {
        var row = [];
        for (var x = 0; x < half; x++) row.push(Math.floor(rnd() * 2.3));
        var mir = row.slice(0, SZ - half).reverse();
        cells.push(row.concat(mir));
      }
      var bc = document.createElement('canvas');
      bc.width = bc.height = SZ * SC;
      var bctx = bc.getContext('2d');
      cells.forEach(function (row, r) {
        row.forEach(function (v, col) {
          bctx.fillStyle = v === 1 ? fg : v === 2 ? spot : bg;
          bctx.fillRect(col * SC, r * SC, SC, SC);
        });
      });
      return bc.toDataURL();
    }

    var WarpDropClass = lively.morphic.Box.subclass('lively.identity.WarpDrop',

    'serialization', {
      doNotSerialize: ['_contentDiv', '_ws', '_peers', '_emptyEl'],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._contentDiv = null;
        this._emptyEl = null;
        this._peers = {}; // peerId -> peer state, see _addPeerCard
        this._myPeerId = null;
        this._myName = null;
        this._roomCode = null; // set once the user successfully joins a room, see _joinRoom
        this._closed = false;
        this._buildChrome();
        this._connect();
      },

      _buildChrome: function () {
        this.setFill(Color.white);
        var shapeNode = this.renderContext().shapeNode;
        shapeNode.style.borderRadius = '8px';
        shapeNode.style.boxShadow    = '0 4px 16px rgba(0,0,0,0.18)';

        var titleBar = document.createElement('div');
        titleBar.style.cssText = [
          'position:absolute', 'top:0', 'left:0', 'right:0', 'height:36px',
          'background:#2c2c2e', 'border-radius:8px 8px 0 0',
          'display:flex', 'align-items:center', 'justify-content:space-between',
          'padding:0 12px', 'box-sizing:border-box',
        ].join(';');
        var titleText = document.createElement('span');
        titleText.textContent = 'WarpDrop';
        titleText.style.cssText = 'color:#fff;font-size:13px;font-weight:600;font-family:sans-serif;';
        titleBar.appendChild(titleText);

        // "you are" self-identity display -- populated once _onJoined
        // fires with the server-assigned peerId/name (blank/"Connecting…"
        // before that), so the user knows what name/blockie their peers
        // will see them as -- there was previously no way to know this.
        var selfEl = document.createElement('div');
        selfEl.style.cssText = 'display:flex;align-items:center;gap:6px;';
        var selfIcon = document.createElement('img');
        selfIcon.style.cssText = 'width:18px;height:18px;border-radius:50%;display:none;';
        var selfName = document.createElement('span');
        selfName.textContent = 'Connecting…';
        selfName.style.cssText = 'color:#8e8e93;font-size:11px;font-family:sans-serif;';
        selfEl.appendChild(selfIcon);
        selfEl.appendChild(selfName);
        titleBar.appendChild(selfEl);
        this._selfIconEl = selfIcon;
        this._selfNameEl = selfName;

        shapeNode.appendChild(titleBar);

        // Manual room code -- fallback for when automatic IP-based
        // discovery doesn't find a peer (confirmed via testing: two
        // devices on the very same WiFi can present different address
        // families -- e.g. phone over IPv6, desktop over IPv4 -- and
        // never land in the same IP group). Typing the same code on both
        // sides makes them mutually visible regardless of network,
        // additively on top of whatever IP-based peers are already shown.
        var roomBar = document.createElement('div');
        roomBar.style.cssText = [
          'position:absolute', 'top:36px', 'left:0', 'right:0', 'height:34px',
          'background:#f2f2f7', 'border-bottom:1px solid #d1d1d6',
          'display:flex', 'align-items:center', 'padding:0 10px',
          'box-sizing:border-box', 'gap:6px', 'font-family:sans-serif',
        ].join(';');
        var roomInput = document.createElement('input');
        roomInput.type = 'text';
        roomInput.placeholder = 'Room code (optional)';
        roomInput.style.cssText = [
          'flex:1', 'min-width:0', 'font-size:12px', 'padding:4px 8px',
          'border:1px solid #d1d1d6', 'border-radius:4px', 'box-sizing:border-box',
        ].join(';');
        var roomBtn = document.createElement('button');
        roomBtn.textContent = 'Join';
        roomBtn.style.cssText = [
          'font-size:11px', 'padding:4px 10px', 'cursor:pointer',
          'border:1px solid #007aff', 'color:#007aff',
          'background:#fff', 'border-radius:4px', 'white-space:nowrap',
        ].join(';');
        var self = this;
        function joinTypedRoom() {
          var code = roomInput.value.trim();
          if (!code) return;
          self._joinRoom(code);
        }
        roomBtn.addEventListener('click', joinTypedRoom);
        roomInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') joinTypedRoom(); });
        roomBar.appendChild(roomInput);
        roomBar.appendChild(roomBtn);
        shapeNode.appendChild(roomBar);
        this._roomInput = roomInput;
        this._roomBtn = roomBtn;

        var contentDiv = document.createElement('div');
        contentDiv.style.cssText = [
          'position:absolute', 'top:70px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:12px 16px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:13px',
          'display:flex', 'flex-wrap:wrap', 'gap:10px', 'align-content:flex-start',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;
      },

      // explicitly tear down everything WebRTC/WebSocket -- neither is
      // tied to the morph's lifecycle automatically.
      //
      // bringToFront() (MorphAddons.js) implements z-ordering as
      // "this.remove(); owner.addMorphFront(this);" -- a documented
      // "Hack: remove and re-add morph". Since open() calls
      // bringToFront() right after creation (matching every other
      // morph's open() convention, e.g. FilesBrowser.open()), a naive
      // override here would tear down the signaling connection the
      // instant the panel appears. Defer teardown one tick and skip it
      // if the morph is back in a world by then (a reorder, not a real
      // close) -- $super() still runs synchronously so the reorder
      // hack itself keeps working.
      remove: function ($super) {
        var self = this;
        $super();
        setTimeout(function () {
          if (self.world()) return; // reattached (bringToFront reorder) -- not a real close
          self._closed = true;
          self._teardownAll();
          if (self._ws) self._ws.close();
        }, 0);
      },

    },

    'signaling', {

      _connect: function () {
        var url = URL.nodejsBase.withFilename('WarpDropSignalingServer/connect').toString();
        this._ws = new lively.net.WebSocket(url, { protocol: 'lively-json' });
        lively.bindings.connect(this._ws, 'opened', this, 'onWsOpened');
        lively.bindings.connect(this._ws, 'closed', this, 'onWsClosed');
        lively.bindings.connect(this._ws, 'lively-message', this, 'onWsMessage');
        this._ws.connect();
      },

      onWsOpened: function () {
        // resend on every (re)open, not just the first -- a reconnect
        // after a network blip gets a *new* server peerId, so the
        // existing peer list is stale until 'joined' repopulates it
        this._ws.send({ action: 'join' });
        // re-join the room too, if we were in one -- same reasoning,
        // a reconnect's new peerId means the server no longer considers
        // us a member of any room we'd joined before
        if (this._roomCode) this._ws.send({ action: 'join-room', data: { code: this._roomCode } });
      },

      // lively.net.WebSocket's own enableReconnect() only recovers a
      // connection that was open and later dropped (it gates on
      // this._open, set only by onOpen) -- it does nothing for a
      // connection that fails on its very first handshake attempt,
      // which reliably happens here since WarpDrop connects during the
      // busiest instant of page bootstrap (many concurrent module loads
      // and another WebSocket connecting at the same moment). So retry
      // unconditionally on every close, whether or not it was ever open.
      onWsClosed: function () {
        if (this._closed) return;
        var self = this;
        setTimeout(function () {
          if (self._closed) return;
          self._ws.connect();
        }, 1500);
      },

      onWsMessage: function (msg) {
        switch (msg.action) {
          case 'joined':      this._onJoined(msg.data); break;
          case 'room-joined': this._onRoomJoined(msg.data); break;
          case 'peer-joined': this._onPeerJoined(msg.data); break;
          case 'peer-left':   this._onPeerLeft(msg.data); break;
          case 'signal':      this._onSignal(msg.data); break;
        }
      },

      _sendSignal: function (toPeerId, signal) {
        this._ws.send({ action: 'signal', data: { to: toPeerId, signal: signal } });
      },

      _joinRoom: function (code) {
        this._roomCode = code;
        this._roomInput.disabled = true;
        this._roomBtn.disabled = true;
        this._roomBtn.style.opacity = '0.5';
        this._ws.send({ action: 'join-room', data: { code: code } });
      },

      // Additive, unlike _onJoined -- a room join must not disturb
      // in-flight transfers with existing IP-discovered peers. Any peer
      // in data.peers we don't already know about gets a card; the
      // server includes both IP-group and room members in this list, so
      // peers we already have (e.g. already IP-local) are simply skipped.
      _onRoomJoined: function (data) {
        this._roomInput.value = 'Room: ' + data.code;
        (data.peers || []).forEach(function (p) {
          if (!this._peers[p.peerId]) this._addPeerCard(p);
        }, this);
      },

      _onJoined: function (data) {
        this._teardownAll();
        this._myPeerId = data.peerId;
        this._myName = data.name;
        this._peers = {};
        this._contentDiv.innerHTML = '';
        this._emptyEl = null;
        (data.peers || []).forEach(this._addPeerCard, this);
        if (!Object.keys(this._peers).length) this._showEmptyState();

        this._selfNameEl.textContent = 'You are ' + data.name;
        this._selfIconEl.src = makeBlockieDataUrl(data.peerId, 18);
        this._selfIconEl.style.display = 'block';
      },

      _onPeerJoined: function (data) {
        if (this._peers[data.peerId]) return;
        this._addPeerCard(data);
      },

      _onPeerLeft: function (data) {
        var peer = this._peers[data.peerId];
        if (!peer) return;
        this._teardownPeerConnection(peer);
        if (peer.card && peer.card.parentNode) peer.card.parentNode.removeChild(peer.card);
        delete this._peers[data.peerId];
        if (!Object.keys(this._peers).length) this._showEmptyState();
      },

      _onSignal: function (data) {
        var peer = this._peers[data.from];
        if (!peer) return; // peer already left / unknown, ignore
        var signal = data.signal;
        switch (signal.type) {
          case 'offer-file': this._onOfferFile(peer, signal); break;
          case 'declined':   this._onDeclined(peer); break;
          case 'answer':     this._onAnswer(peer, signal); break;
          case 'ice':        this._onIce(peer, signal); break;
        }
      },

    },

    'peer cards', {

      _showEmptyState: function () {
        if (this._emptyEl) return;
        var el = document.createElement('div');
        el.style.cssText = 'color:#999;padding:20px 0;';
        el.textContent = 'No other devices nearby yet…';
        this._contentDiv.appendChild(el);
        this._emptyEl = el;
      },

      _clearEmptyState: function () {
        if (!this._emptyEl) return;
        if (this._emptyEl.parentNode) this._emptyEl.parentNode.removeChild(this._emptyEl);
        this._emptyEl = null;
      },

      _addPeerCard: function (data) {
        this._clearEmptyState();
        var self = this;

        var card = document.createElement('div');
        card.style.cssText = [
          'width:130px', 'border:2px dashed #e5e5ea', 'border-radius:8px',
          'padding:10px', 'text-align:center', 'position:relative',
          'background:#fff', 'cursor:pointer', 'box-sizing:border-box',
        ].join(';');

        var icon = document.createElement('img');
        icon.src = makeBlockieDataUrl(data.peerId, AVATAR_SIZE);
        icon.style.cssText = [
          'width:' + AVATAR_SIZE + 'px', 'height:' + AVATAR_SIZE + 'px',
          'border-radius:50%', 'margin:0 auto 6px', 'display:block',
        ].join(';');
        card.appendChild(icon);

        var nameEl = document.createElement('div');
        nameEl.textContent = data.name;
        nameEl.style.cssText = 'font-weight:600;color:#1c1c1e;word-break:break-word;';
        card.appendChild(nameEl);

        var statusEl = document.createElement('div');
        statusEl.style.cssText = 'color:#8e8e93;font-size:11px;margin-top:4px;min-height:14px;word-break:break-word;';
        card.appendChild(statusEl);

        var progressOuter = document.createElement('div');
        progressOuter.style.cssText = 'height:4px;background:#e5e5ea;border-radius:2px;margin-top:6px;overflow:hidden;display:none;';
        var progressInner = document.createElement('div');
        progressInner.style.cssText = 'height:100%;width:0%;background:#007aff;';
        progressOuter.appendChild(progressInner);
        card.appendChild(progressOuter);

        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.style.display = 'none';
        card.appendChild(fileInput);

        var peer = {
          peerId: data.peerId,
          name: data.name,
          card: card,
          statusEl: statusEl,
          progressOuter: progressOuter,
          progressInner: progressInner,
          pc: null,
          channel: null,
          role: null, // 'sender' | 'receiver'
          pendingIce: [],
          offerSdp: null,
          fileInfo: null,
          receivedChunks: null,
          receivedBytes: 0,
          disconnectTimer: null,
        };
        this._peers[data.peerId] = peer;

        card.addEventListener('dragover', function (e) { e.preventDefault(); card.style.borderColor = '#007aff'; });
        card.addEventListener('dragleave', function () { card.style.borderColor = '#e5e5ea'; });
        card.addEventListener('drop', function (e) {
          e.preventDefault();
          card.style.borderColor = '#e5e5ea';
          var f = e.dataTransfer.files[0];
          if (f) self._beginSend(peer, f);
        });
        card.addEventListener('click', function () { fileInput.click(); });
        fileInput.addEventListener('change', function () {
          var f = fileInput.files[0];
          fileInput.value = '';
          if (f) self._beginSend(peer, f);
        });

        this._contentDiv.appendChild(card);
      },

      _setStatus: function (peer, text) {
        peer.statusEl.textContent = text || '';
      },

      _setProgress: function (peer, fraction) {
        if (fraction == null) {
          peer.progressOuter.style.display = 'none';
          peer.progressInner.style.width = '0%';
          return;
        }
        peer.progressOuter.style.display = 'block';
        peer.progressInner.style.width = (Math.max(0, Math.min(1, fraction)) * 100) + '%';
      },

      _formatSize: function (bytes) {
        if (typeof bytes !== 'number') return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      },

    },

    'sending', {

      _beginSend: function (peer, file) {
        var self = this;

        if (file.size > MAX_FILE_SIZE) {
          this._setStatus(peer, 'Too large (max 500MB)');
          return;
        }

        if (peer.pc) {
          // glare: a transfer is already active in some direction with
          // this peer -- lower peerId wins and proceeds as offerer
          if (this._myPeerId > peer.peerId) {
            this._setStatus(peer, 'Busy, try again');
            return;
          }
          this._teardownPeerConnection(peer);
        }

        peer.role = 'sender';
        peer.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        peer.channel = peer.pc.createDataChannel('file');
        peer.channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

        peer.pc.onicecandidate = function (e) {
          if (e.candidate) self._sendSignal(peer.peerId, { type: 'ice', candidate: e.candidate });
        };
        peer.pc.oniceconnectionstatechange = function () { self._onIceStateChange(peer); };

        peer.channel.onopen = function () {
          self._setStatus(peer, 'Sending…');
          self._sendChunks(peer, file, 0);
        };

        peer.pc.createOffer().then(function (offer) {
          return peer.pc.setLocalDescription(offer);
        }).then(function () {
          self._sendSignal(peer.peerId, {
            type: 'offer-file',
            sdp: peer.pc.localDescription,
            fileInfo: { name: file.name, size: file.size, mime: file.type },
          });
          self._setStatus(peer, 'Waiting for accept…');
        }).catch(function (e) {
          console.error('WarpDrop offer failed', e);
          self._setStatus(peer, 'Connection failed');
          self._teardownPeerConnection(peer);
        });
      },

      _onDeclined: function (peer) {
        this._setStatus(peer, 'Declined');
        this._teardownPeerConnection(peer);
      },

      _onAnswer: function (peer, signal) {
        var self = this;
        peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function () {
          self._flushPendingIce(peer);
        }).catch(function (e) {
          console.error('WarpDrop setRemoteDescription (answer) failed', e);
          self._setStatus(peer, 'Connection failed');
          self._teardownPeerConnection(peer);
        });
      },

      _sendChunks: function (peer, file, offset) {
        var self = this;
        if (!peer.channel || peer.channel.readyState !== 'open') return;

        if (offset >= file.size) {
          this._setStatus(peer, 'Sent');
          this._teardownPeerConnection(peer);
          return;
        }

        var slice = file.slice(offset, offset + CHUNK_SIZE);
        var reader = new FileReader();
        reader.onload = function () {
          var chunk = reader.result;
          peer.channel.send(chunk);
          var nextOffset = offset + chunk.byteLength;
          self._setProgress(peer, nextOffset / file.size);
          if (peer.channel.bufferedAmount > peer.channel.bufferedAmountLowThreshold) {
            peer.channel.onbufferedamountlow = function () {
              peer.channel.onbufferedamountlow = null;
              self._sendChunks(peer, file, nextOffset);
            };
          } else {
            self._sendChunks(peer, file, nextOffset);
          }
        };
        reader.onerror = function () {
          self._setStatus(peer, 'Read error');
          self._teardownPeerConnection(peer);
        };
        reader.readAsArrayBuffer(slice);
      },

    },

    'receiving', {

      _onOfferFile: function (peer, signal) {
        var self = this;

        if (peer.pc) {
          // glare: we are already sending to this peer -- lower peerId
          // wins and stays the offerer, the higher side's offer is declined
          if (this._myPeerId < peer.peerId) {
            this._sendSignal(peer.peerId, { type: 'declined' });
            return;
          }
          this._teardownPeerConnection(peer);
        }

        peer.role = 'receiver';
        peer.fileInfo = signal.fileInfo;
        peer.offerSdp = signal.sdp;

        this._showAcceptPrompt(peer, function (accepted) {
          if (!accepted) {
            self._sendSignal(peer.peerId, { type: 'declined' });
            peer.fileInfo = null;
            peer.offerSdp = null;
            return;
          }
          self._acceptOffer(peer);
        });
      },

      _acceptOffer: function (peer) {
        var self = this;
        peer.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        peer.receivedChunks = [];
        peer.receivedBytes = 0;

        peer.pc.onicecandidate = function (e) {
          if (e.candidate) self._sendSignal(peer.peerId, { type: 'ice', candidate: e.candidate });
        };
        peer.pc.oniceconnectionstatechange = function () { self._onIceStateChange(peer); };
        peer.pc.ondatachannel = function (e) {
          peer.channel = e.channel;
          peer.channel.onmessage = function (evt) { self._onChunk(peer, evt.data); };
        };

        this._setStatus(peer, 'Connecting…');
        peer.pc.setRemoteDescription(new RTCSessionDescription(peer.offerSdp)).then(function () {
          self._flushPendingIce(peer);
          return peer.pc.createAnswer();
        }).then(function (answer) {
          return peer.pc.setLocalDescription(answer);
        }).then(function () {
          self._sendSignal(peer.peerId, { type: 'answer', sdp: peer.pc.localDescription });
          self._setStatus(peer, 'Receiving…');
        }).catch(function (e) {
          console.error('WarpDrop accept failed', e);
          self._setStatus(peer, 'Connection failed');
          self._teardownPeerConnection(peer);
        });
      },

      _onChunk: function (peer, data) {
        peer.receivedChunks.push(data);
        peer.receivedBytes += data.byteLength;
        this._setProgress(peer, peer.receivedBytes / peer.fileInfo.size);
        if (peer.receivedBytes >= peer.fileInfo.size) {
          var self = this;
          var blob = new Blob(peer.receivedChunks, { type: peer.fileInfo.mime });
          var filename = peer.fileInfo.name;

          if (lively.identity.did && lively.identity.did.isLoggedIn()) {
            this._setStatus(peer, 'Saving…');
            this._saveToFiles(blob, filename, function (err, savedName) {
              if (err) {
                console.error('WarpDrop save to Files failed, falling back to download', err);
                self._downloadBlob(blob, filename);
                self._setStatus(peer, 'Save failed, downloaded instead');
              } else {
                self._setStatus(peer, 'Saved to Files › ' + SAVE_FOLDER + ' as ' + savedName);
              }
              self._teardownPeerConnection(peer);
            });
          } else {
            this._downloadBlob(blob, filename);
            this._setStatus(peer, 'Received');
            this._teardownPeerConnection(peer);
          }
        }
      },

      // Saves into the signed-in user's upload space instead of
      // triggering a browser download, reusing the same PUT endpoint
      // FilesBrowser._uploadFile uses (the server auto-creates the
      // WarpDrop folder on first upload, no separate mkdir call needed).
      // Auto-renames on a name collision ("photo.png" -> "photo (1).png")
      // rather than overwriting a previous receipt.
      _saveToFiles: function (blob, filename, thenDo) {
        var self = this;
        this._listSaveFolderNames(function (err, existingNames) {
          if (err) { thenDo(err); return; }
          var uniqueName = self._uniqueFilename(existingNames, filename);
          var handle = lively.identity.did.currentUser().handle;
          var base   = lively.identity.did.baseUrl();
          var relPath = SAVE_FOLDER + '/' + uniqueName;
          var xhr = new XMLHttpRequest();
          xhr.open('PUT', base + '/@' + handle + '/uploads/' +
            relPath.split('/').map(encodeURIComponent).join('/'));
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.withCredentials = true;
          xhr.onload = function () {
            if (xhr.status === 200) return thenDo(null, uniqueName);
            thenDo(new Error('Save failed: ' + xhr.status));
          };
          xhr.onerror = function () { thenDo(new Error('Network error')); };
          xhr.send(blob);
        });
      },

      _listSaveFolderNames: function (thenDo) {
        var handle = lively.identity.did.currentUser().handle;
        var base   = lively.identity.did.baseUrl();
        var prefix = SAVE_FOLDER + '/';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', base + '/@' + handle + '/uploads');
        xhr.withCredentials = true;
        xhr.onload = function () {
          if (xhr.status !== 200) { thenDo(new Error('Could not list Files (' + xhr.status + ')')); return; }
          var result;
          try { result = JSON.parse(xhr.responseText); } catch (e) { thenDo(new Error('Bad response')); return; }
          var names = (result.files || [])
            .filter(function (f) { return f.path.indexOf(prefix) === 0 && f.path.indexOf('/', prefix.length) === -1; })
            .map(function (f) { return f.path.slice(prefix.length); });
          thenDo(null, names);
        };
        xhr.onerror = function () { thenDo(new Error('Network error')); };
        xhr.send();
      },

      _uniqueFilename: function (existingNames, desiredName) {
        if (existingNames.indexOf(desiredName) === -1) return desiredName;
        var dot = desiredName.lastIndexOf('.');
        var base = dot === -1 ? desiredName : desiredName.slice(0, dot);
        var ext  = dot === -1 ? '' : desiredName.slice(dot);
        for (var i = 1; ; i++) {
          var candidate = base + ' (' + i + ')' + ext;
          if (existingNames.indexOf(candidate) === -1) return candidate;
        }
      },

      _downloadBlob: function (blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 30 * 1000);
      },

      // raw-DOM modal overlay, matches the FilesBrowser._promptText convention
      _showAcceptPrompt: function (peer, thenDo) {
        var fileInfo = peer.fileInfo;
        var overlay = document.createElement('div');
        overlay.style.cssText =
          'position:fixed;top:0;left:0;width:100%;height:100%;' +
          'background:rgba(0,0,0,0.5);z-index:99999;' +
          'display:flex;align-items:center;justify-content:center;';

        var panel = document.createElement('div');
        panel.style.cssText =
          'background:#fff;border-radius:8px;padding:16px;width:280px;' +
          'font-family:sans-serif;box-shadow:0 8px 24px rgba(0,0,0,0.3);';

        var msg = document.createElement('div');
        msg.style.cssText = 'font-size:13px;color:#1c1c1e;margin-bottom:12px;';
        msg.textContent = peer.name + ' wants to send you “' + fileInfo.name + '” (' +
          this._formatSize(fileInfo.size) + ')';
        panel.appendChild(msg);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

        function close(accepted) {
          document.body.removeChild(overlay);
          thenDo(accepted);
        }

        var declineBtn = document.createElement('button');
        declineBtn.textContent = 'Decline';
        declineBtn.style.cssText =
          'font-size:12px;padding:5px 12px;cursor:pointer;border:1px solid #d1d1d6;' +
          'background:#fff;border-radius:4px;';
        declineBtn.addEventListener('click', function () { close(false); });

        var acceptBtn = document.createElement('button');
        acceptBtn.textContent = 'Accept';
        acceptBtn.style.cssText =
          'font-size:12px;padding:5px 12px;cursor:pointer;border:1px solid #007aff;' +
          'background:#007aff;color:#fff;border-radius:4px;';
        acceptBtn.addEventListener('click', function () { close(true); });

        btnRow.appendChild(declineBtn);
        btnRow.appendChild(acceptBtn);
        panel.appendChild(btnRow);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
      },

    },

    'ice handling', {

      _onIce: function (peer, signal) {
        if (peer.pc && peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
          peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(function (e) {
            console.warn('WarpDrop addIceCandidate failed', e);
          });
        } else {
          peer.pendingIce.push(signal.candidate);
        }
      },

      _flushPendingIce: function (peer) {
        var candidates = peer.pendingIce;
        peer.pendingIce = [];
        candidates.forEach(function (c) {
          peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(function (e) {
            console.warn('WarpDrop addIceCandidate (flush) failed', e);
          });
        });
      },

      _onIceStateChange: function (peer) {
        var self = this;
        var state = peer.pc && peer.pc.iceConnectionState;
        if (state === 'failed') {
          this._setStatus(peer, 'Connection failed');
          this._teardownPeerConnection(peer);
          return;
        }
        if (state === 'disconnected') {
          if (peer.disconnectTimer) return;
          peer.disconnectTimer = setTimeout(function () {
            peer.disconnectTimer = null;
            if (peer.pc && peer.pc.iceConnectionState === 'disconnected') {
              self._setStatus(peer, 'Connection lost');
              self._teardownPeerConnection(peer);
            }
          }, DISCONNECT_ABORT_MS);
          return;
        }
        if (peer.disconnectTimer) { clearTimeout(peer.disconnectTimer); peer.disconnectTimer = null; }
      },

    },

    'cleanup', {

      _teardownPeerConnection: function (peer) {
        if (peer.disconnectTimer) { clearTimeout(peer.disconnectTimer); peer.disconnectTimer = null; }
        if (peer.channel) {
          peer.channel.onmessage = null;
          peer.channel.onbufferedamountlow = null;
          try { peer.channel.close(); } catch (e) {}
          peer.channel = null;
        }
        if (peer.pc) {
          peer.pc.onicecandidate = null;
          peer.pc.ondatachannel = null;
          peer.pc.oniceconnectionstatechange = null;
          try { peer.pc.close(); } catch (e) {}
          peer.pc = null;
        }
        peer.role = null;
        peer.fileInfo = null;
        peer.offerSdp = null;
        peer.pendingIce = [];
        peer.receivedChunks = null;
        peer.receivedBytes = 0;
        this._setProgress(peer, null);
      },

      _teardownAll: function () {
        var self = this;
        Object.keys(this._peers || {}).forEach(function (id) {
          self._teardownPeerConnection(self._peers[id]);
        });
      },

    });

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(WarpDropClass, {
      open: function () {
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var bounds = vw < MOBILE_BREAKPOINT
          ? lively.rect(0, 0, vw - MOBILE_MARGIN * 2, vh - MOBILE_MARGIN * 2)
          : lively.rect(0, 0, 460, 420);
        var morph = new lively.identity.WarpDrop(bounds);
        morph.openInWorldCenter();
        morph.bringToFront();
        return morph;
      },
    });

  }); // end module('lively.identity.WarpDrop')
