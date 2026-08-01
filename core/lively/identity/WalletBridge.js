/**
 * lively.identity.WalletBridge
 *
 * WalletSpec.md §3.4, §15 step 3: the postMessage RPC client that lives in
 * the main Lively world, creates and owns the (initially hidden) Wallet
 * Vault <iframe>, and speaks the small JSON-RPC-shaped protocol
 * WalletVault.js (core/lively/identity/WalletVault.js) responds to on the
 * other side.
 *
 * Holds no secrets itself (§3.3's table) — every method here is a thin
 * postMessage round trip; whatever crosses the boundary in each direction
 * is exactly what §3.4's table allows. This step only wires four methods —
 * setup/unlock/lock/getAddress — matching what WalletVault.js's RPC
 * responder actually implements as of step 3. revealMnemonic is
 * deliberately never wired here at all: per §3.4 it never crosses the
 * postMessage boundary in either direction, in any step.
 *
 * _vaultOrigin resolution: lively.Config.get('identityWalletOrigin') if
 * configured, else window.location.origin — the unconfigured case IS §3.2's
 * same-origin dev fallback (no cross-origin/vhost infrastructure exists in
 * this codebase yet; that's a later step's problem, not a limitation of
 * this file). The postMessage target/expected-origin logic below is
 * written the same way it would need to be for a real second origin —
 * nothing here special-cases fallback mode, it just naturally resolves to
 * window.location.origin when unconfigured.
 *
 * The iframe's sandbox="allow-scripts allow-same-origin" attribute is
 * exactly §3.2's stated local-dev-fallback shape (persists IndexedDB,
 * forfeits the cross-origin isolation guarantee) — harmless once a real
 * second origin is configured later, since genuine cross-origin already
 * provides real isolation without needing the sandbox attribute at all.
 * allow="publickey-credentials-get" is required separately — Chrome's
 * WebAuthn Permissions Policy integration blocks navigator.credentials.get()
 * inside an <iframe> unless this is explicitly delegated, sandboxed or not;
 * without it, WalletVault.js's WebAuthn PRF path would silently fail only
 * once actually embedded (step 2's testing never hit this, since that
 * tested /wallet-vault by direct navigation, never inside an iframe).
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

module('lively.identity.WalletBridge')
  .requires()
  .toRun(function() {

Object.subclass('lively.identity.WalletBridge',

// ─── vault iframe lifecycle ──────────────────────────────────────────────

'iframe', {

  initialize: function() {
    this._nextId = 1;
    this._pending = {};
    this._listenerInstalled = false;
    this._vaultFrame = null;
    this._vaultOriginResolved = null;
  },

  _vaultOrigin: function() {
    return (lively.Config && lively.Config.get('identityWalletOrigin')) || window.location.origin;
  },

  // Lazily creates the hidden vault <iframe> on first call() — same
  // lazy-injection shape as lively.identity.Crypto's withSodium /
  // WalletCrypto's withWalletCryptoLibs, applied to an iframe instead of a
  // script tag.
  _withVaultFrame: function(thenDo) {
    var self = this;
    if (this._vaultFrame) return thenDo(null, this._vaultFrame);

    var origin = this._vaultOrigin();
    var iframe = document.createElement('iframe');
    iframe.src = origin + '/wallet-vault';
    iframe.style.display = 'none';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('allow', 'publickey-credentials-get');
    iframe.onload = function() {
      self._vaultFrame = iframe;
      self._vaultOriginResolved = origin;
      thenDo(null, iframe);
    };
    document.body.appendChild(iframe);
  }

},

// ─── postMessage RPC (§3.4, exact protocol shape) ───────────────────────

'rpc', {

  _installResponseListener: function() {
    if (this._listenerInstalled) return;
    this._listenerInstalled = true;
    var self = this;
    window.addEventListener('message', function(ev) {
      if (ev.origin !== self._vaultOriginResolved) return; // reject anything else
      if (!self._vaultFrame || ev.source !== self._vaultFrame.contentWindow) return;
      var msg = ev.data;
      if (!msg || typeof msg.id === 'undefined') return;
      var thenDo = self._pending[msg.id];
      if (!thenDo) return;
      delete self._pending[msg.id];
      thenDo(msg.error ? new Error(msg.error.message) : null, msg.result);
    });
  },

  // Every call wraps a postMessage round trip in the existing thenDo
  // convention so callers don't know the vault exists (§3.4).
  call: function(method, params, thenDo) {
    var self = this;
    this._withVaultFrame(function(err, iframe) {
      if (err) return thenDo(err);
      self._installResponseListener();
      var id = self._nextId++;
      self._pending[id] = thenDo;
      iframe.contentWindow.postMessage(
        { id: id, method: method, params: params },
        self._vaultOriginResolved // never '*' — always the resolved vault origin
      );
    });
  }

},

// ─── convenience wrappers (§15 step 3's subset) ─────────────────────────

'methods', {

  setup: function(options, thenDo) { this.call('setup', options, thenDo); },
  unlock: function(options, thenDo) { this.call('unlock', options, thenDo); },
  lock: function(thenDo) { this.call('lock', null, thenDo); },
  getAddress: function(thenDo) { this.call('getAddress', null, thenDo); }

});

lively.identity.walletBridge = new lively.identity.WalletBridge();

}); // end module('lively.identity.WalletBridge')
