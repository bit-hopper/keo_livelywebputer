/**
 * lively.identity.PrivacyPoolClient
 *
 * WalletSpec.md §11, §15 step 4: public-data orchestration in the main
 * world — RPC calls, tx broadcast, chain-event scan. No secrets touched
 * here at all (§3.3's table): this file never holds a private key or
 * mnemonic; the one place it needs a signature, it calls into
 * lively.identity.walletBridge (§6.6's pattern — simulate/build here,
 * sign only through the vault, broadcast here).
 *
 * Step 4: the plain-ETH subset — getBalance and buildAndSignTransfer. Step
 * 5 additions: ASP client methods against the real production API
 * (api.0xbow.io, live-verified including CORS preflight for its custom
 * X-Pool-Scope header, from an actual browser at Lively's own origin —
 * see the 'asp' section below), and relayer client methods against a
 * local stub (RelayerStubServer.js — the two real 0xbow-operated mainnet
 * relayers turned out unusable: one's domain is dead/parked, the other is
 * CORS-blocked from arbitrary origins; self-hosting remains the real path
 * for production relaying, exactly as §6.5 already recommended). Deposit/
 * withdraw/ragequit and chain-event scan for spendable commitments are
 * still step 7+'s addition to this same file, per §11's file map.
 *
 * buildAndSignTransfer deliberately never broadcasts (no
 * eth_sendRawTransaction call exists anywhere in this file or its
 * dependency bundle) — per WalletSpec.md §15 step 4's own scope, actually
 * broadcasting a real mainnet transaction is a separate, later, explicitly-
 * directed action.
 *
 * Dependency bundle: core/lib/wallet/privacy-pool-client-libs.js (built by
 * scripts/build-privacy-pool-client-libs.js), lazy-loaded the same way
 * lively.identity.WalletCrypto loads wallet-crypto-libs.js — its own
 * bundle, not folded into WalletCrypto's, since that file's own scope is
 * specifically "what WalletCrypto needs" (public-input-only helpers, no
 * RPC client).
 *
 * Async pattern: thenDo(err, result), matching the rest of
 * lively.identity.*.
 */

module('lively.identity.PrivacyPoolClient')
  .requires()
  .toRun(function() {

Object.subclass('lively.identity.PrivacyPoolClient',

// ─── dependency bundle + publicClient lazy loading ──────────────────────

'client', {

  withClientLibs: function(thenDo) {
    var self = this;
    var libs = this._clientLibs ||
                (typeof window !== 'undefined' && window.privacyPoolClientLibs) ||
                (typeof global !== 'undefined' && global.privacyPoolClientLibs) ||
                null;
    if (libs) return thenDo(null, libs);

    if (typeof document === 'undefined') {
      return thenDo(new Error(
        'privacy-pool-client-libs.js not loaded and no document to inject it into ' +
        '(non-browser context) — set privacyPoolClient._clientLibs directly.'
      ));
    }

    if (window._privacyPoolClientLibsLoading) {
      var poll = setInterval(function () {
        if (window.privacyPoolClientLibs) {
          clearInterval(poll);
          self.withClientLibs(thenDo);
        }
      }, 50);
      return;
    }

    window._privacyPoolClientLibsLoading = true;
    var s = document.createElement('script');
    s.src = '/core/lib/wallet/privacy-pool-client-libs.js';
    s.onload = function () {
      window._privacyPoolClientLibsLoading = false;
      if (!window.privacyPoolClientLibs) {
        return thenDo(new Error(
          '/core/lib/wallet/privacy-pool-client-libs.js loaded but did not set ' +
          'window.privacyPoolClientLibs — it likely threw while evaluating; check the console.'
        ));
      }
      self.withClientLibs(thenDo);
    };
    s.onerror = function () {
      window._privacyPoolClientLibsLoading = false;
      thenDo(new Error('Failed to load /core/lib/wallet/privacy-pool-client-libs.js'));
    };
    document.head.appendChild(s);
  },

  // §12: REQUIRED, no default shipped — set a real value in localconfig.js.
  _withPublicClient: function(thenDo) {
    var self = this;
    if (this._publicClient) return thenDo(null, this._publicClient);
    var rpcUrl = lively.Config && lively.Config.get('ethereumRpcUrl');
    if (!rpcUrl) {
      return thenDo(new Error(
        'PrivacyPoolClient: ethereumRpcUrl is not configured (WalletSpec.md §12/§14 item 1) — ' +
        'set it in core/lively/localconfig.js.'
      ));
    }
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      try {
        self._publicClient = libs.createPublicClient({
          chain: libs.mainnet,
          transport: libs.http(rpcUrl)
        });
        thenDo(null, self._publicClient);
      } catch (e) { thenDo(e); }
    });
  }

},

// ─── public data ─────────────────────────────────────────────────────────

'balance', {

  // Returns thenDo(null, { wei: bigint, eth: string }).
  getBalance: function(address, thenDo) {
    var self = this;
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        client.getBalance({ address: address }).then(function(wei) {
          thenDo(null, { wei: wei, eth: libs.formatEther(wei) });
        }).catch(function(e) { thenDo(e); });
      });
    });
  }

},

// ─── build + sign (never broadcast — §15 step 4's own scope) ────────────

'transfer', {

  // { to, amountEth }: to is a checksummed/hex address string, amountEth a
  // decimal string ("0.01"). Calls thenDo(null, { signedRawTx, unsignedTx }).
  // Fetches nonce/gas/chainId (public data, no secrets) here, signs only
  // via lively.identity.walletBridge.signTransaction (the vault), and never
  // calls sendRawTransaction — see this file's own header.
  buildAndSignTransfer: function(options, thenDo) {
    var self = this;
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        lively.identity.walletBridge.getAddress(function(err3, fromAddress) {
          if (err3) return thenDo(err3);
          Promise.all([
            client.getTransactionCount({ address: fromAddress }),
            client.getGasPrice(),
            client.getChainId()
          ]).then(function(results) {
            var nonce = results[0], gasPrice = results[1], chainId = results[2];
            var unsignedTx = {
              to: options.to,
              value: libs.parseEther(String(options.amountEth)),
              nonce: nonce,
              gas: 21000n,
              maxFeePerGas: gasPrice * 2n,
              maxPriorityFeePerGas: gasPrice,
              chainId: chainId
            };
            lively.identity.walletBridge.signTransaction(unsignedTx, function(err4, signedRawTx) {
              if (err4) return thenDo(err4);
              thenDo(null, { signedRawTx: signedRawTx, unsignedTx: unsignedTx });
            });
          }).catch(function(e) { thenDo(e); });
        });
      });
    });
  }

},

// ─── ASP (§6.3, §15 step 5 — RESOLVED: real production API) ─────────────
// Real host (api.0xbow.io), live-verified directly from a browser at
// Lively's own origin — CORS-open, including preflight for the custom
// X-Pool-Scope header every call below needs (that preflight was the
// actual open risk; it passed). Exact contract, confirmed against the
// real source (not guessed): GET {base}/{chainId}/public/<path>, the pool
// identified via an X-Pool-Scope header (decimal scope string) rather
// than a path/query param. No auth on any of these — safe to call from
// the main world, never the vault. core/servers/ASPStubServer.js remains
// available as an offline/no-network fallback (point
// privacyPoolAspEndpoint at it instead) but is no longer the default.
//
// A separate Brevis-provider ASP path exists (different host, different
// shape: GET /leaves, /root, POST /all_deposits) for any pool configured
// provider:'brevis' — not implemented here since the default 0xbow-hosted
// pools (what this spec targets, §0) don't use it.

'asp', {

  _aspEndpoint: function() {
    return lively.Config && lively.Config.get('privacyPoolAspEndpoint');
  },

  _aspFetch: function(chainId, scope, path, thenDo) {
    var base = this._aspEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolAspEndpoint is not configured'));
    fetch(base + '/' + chainId + '/public/' + path, {
      headers: { 'X-Pool-Scope': String(scope) }
    }).then(function(res) {
      if (!res.ok) throw new Error('ASP request failed: ' + res.status);
      return res.json();
    }).then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  },

  // Pool overview: deposit/pool USD totals, recentEvents[], growth24h.
  getPoolInfo: function(chainId, scope, thenDo) {
    this._aspFetch(chainId, scope, 'pool-info', thenDo);
  },

  // Returns thenDo(null, { mtRoot, createdAt, onchainMtRoot }) — mtRoot is
  // the ASP's own published root; onchainMtRoot is what's actually live on
  // the Entrypoint (§6.4: a withdrawal proof must cite the latter exactly).
  getAspRoots: function(chainId, scope, thenDo) {
    this._aspFetch(chainId, scope, 'mt-roots', thenDo);
  },

  // Returns thenDo(null, { aspLeaves: string[], stateTreeLeaves: string[] }).
  getAspLeaves: function(chainId, scope, thenDo) {
    this._aspFetch(chainId, scope, 'mt-leaves', thenDo);
  },

  // options: { page, perPage } (perPage defaults to 12 server-side). page
  // is REQUIRED by the real API despite reading as optional from its own
  // description — confirmed live: omitting it fails with "Validation
  // failed (numeric string is expected)" — so this always sends it.
  getAspEvents: function(chainId, scope, options, thenDo) {
    options = options || {};
    var qs = ['page=' + encodeURIComponent(options.page || 1)];
    if (options.perPage) qs.push('perPage=' + encodeURIComponent(options.perPage));
    var path = 'events' + (qs.length ? '?' + qs.join('&') : '');
    this._aspFetch(chainId, scope, path, thenDo);
  },

  // labels: array of label strings. Per-label lookup for spendable-
  // commitment reconstruction (§10) — returns each matching deposit's
  // { type, amount, address, label, txHash, timestamp, precommitmentHash,
  // reviewStatus }. What reviewStatus values actually mean (which count as
  // "associated" for withdrawal purposes) isn't confirmed yet — left for
  // whichever later step first needs to interpret it with real data in
  // hand, rather than guessed here.
  getDepositsByLabel: function(chainId, scope, labels, thenDo) {
    var base = this._aspEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolAspEndpoint is not configured'));
    fetch(base + '/' + chainId + '/public/deposits-by-label', {
      headers: { 'X-Pool-Scope': String(scope), 'X-Labels': labels.join(',') }
    }).then(function(res) {
      if (!res.ok) throw new Error('ASP request failed: ' + res.status);
      return res.json();
    }).then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  }

},

// ─── relayer (§6.5, §15 step 5 — local stub only) ────────────────────────
// Exact confirmed real contract (unlike ASP above) — only the base URL is
// a stub; swapping to a real self-hosted or third-party relayer later is
// purely a config change. getRelayerRequest is deliberately NOT wired
// here: RelayerStubServer.js's /relayer/request always errors by design
// (see that file's header), and there's nothing this client needs to do
// differently for that beyond surfacing whatever error comes back —
// callers use fetch directly against the confirmed contract if/when a
// real relayer exists, rather than this file pretending the stub can
// meaningfully "request" anything.

'relayer', {

  _relayerEndpoint: function() {
    return lively.Config && lively.Config.get('privacyPoolRelayerEndpoint');
  },

  getRelayerQuote: function(params, thenDo) {
    var base = this._relayerEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolRelayerEndpoint is not configured'));
    fetch(base + '/relayer/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    }).then(function(res) { return res.json(); })
      .then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  },

  getRelayerDetails: function(chainId, assetAddress, thenDo) {
    var base = this._relayerEndpoint();
    if (!base) return thenDo(new Error('PrivacyPoolClient: privacyPoolRelayerEndpoint is not configured'));
    fetch(base + '/relayer/details?chainId=' + encodeURIComponent(chainId) + '&assetAddress=' + encodeURIComponent(assetAddress))
      .then(function(res) { return res.json(); })
      .then(function(body) { thenDo(null, body); })
      .catch(function(e) { thenDo(e); });
  }

});

lively.identity.privacyPoolClient = new lively.identity.PrivacyPoolClient();

}); // end module('lively.identity.PrivacyPoolClient')
