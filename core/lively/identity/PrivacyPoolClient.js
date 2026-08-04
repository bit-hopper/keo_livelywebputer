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
 * for production relaying, exactly as §6.5 already recommended). Step 7
 * adds the real deposit flow (§6.2, §6.6) — see the 'deposit' section
 * below; withdraw/ragequit and full chain-event scan for spendable
 * commitments (§10) are still later steps' addition to this same file.
 *
 * buildAndSignTransfer deliberately never broadcasts (no
 * eth_sendRawTransaction call exists anywhere in this file or its
 * dependency bundle) — per WalletSpec.md §15 step 4's own scope, actually
 * broadcasting a real mainnet transaction was a separate, later,
 * explicitly-directed action. Step 7 is that action, but only for deposits
 * (buildAndSignDeposit/broadcastDeposit below) — buildAndSignTransfer's own
 * "never broadcasts" behavior for plain sends is untouched.
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

// ─── deposit (§6.2, §6.6, §15 step 7) ────────────────────────────────────
// The first real broadcast capability in this codebase — see this file's
// own header. No ZK proof is involved (§6.1/§6.2: deposit only needs a
// Poseidon hash of nullifier+secret, computed by the vault's
// deriveDepositSecrets); the prover Worker from step 6 is never touched
// here. ABIs (IEntrypointABI/IPrivacyPoolABI) come straight from the
// installed SDK's own source via privacy-pool-client-libs.js — see that
// build script's header for why a direct import wasn't possible.
//
// ETH_ASSET_PLACEHOLDER is the EIP-7528 native-asset address
// (0xEeee...EEeE) — confirmed live this session as the real key
// Entrypoint.assetConfig uses for the ETH pool (the zero address returns
// nothing; this placeholder returns the known ETH pool + real config:
// minimumDepositAmount 0.01 ETH, vettingFeeBPS 50, maxRelayFeeBPS 1000).

'deposit', {

  ETH_ASSET_PLACEHOLDER: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',

  // Thin wei-conversion helper so the UI layer never needs to load
  // privacy-pool-client-libs.js itself just to compare an entered amount
  // against a minimumDepositAmount before enabling Confirm.
  parseEthAmount: function(amountEth, thenDo) {
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      try { thenDo(null, libs.parseEther(String(amountEth))); }
      catch (e) { thenDo(e); }
    });
  },

  _entrypointAddress: function() {
    return lively.Config && lively.Config.get('privacyPoolEntrypointAddress');
  },

  _ethPoolAddress: function() {
    return lively.Config && lively.Config.get('privacyPoolEthPoolAddress');
  },

  // { pool, minimumDepositAmount, vettingFeeBPS, maxRelayFeeBPS } — queried
  // at runtime rather than hardcoded, per this doc's own established
  // preference (§6.2: "query Entrypoint.assetConfig(asset) at runtime
  // rather than hardcoding any figure").
  getAssetConfig: function(assetAddress, thenDo) {
    var self = this;
    var entrypoint = this._entrypointAddress();
    if (!entrypoint) return thenDo(new Error('PrivacyPoolClient: privacyPoolEntrypointAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        client.readContract({
          address: entrypoint,
          abi: libs.IEntrypointABI,
          functionName: 'assetConfig',
          args: [assetAddress]
        }).then(function(result) {
          thenDo(null, {
            pool: result[0],
            minimumDepositAmount: result[1],
            vettingFeeBPS: result[2],
            maxRelayFeeBPS: result[3]
          });
        }).catch(function(e) { thenDo(e); });
      });
    });
  },

  // Queried once per page load and cached — SCOPE() is a fixed per-pool
  // constant, but still read live rather than hardcoded (§6.2's own
  // preference; also the exact value this session independently confirmed
  // against privacyPoolEthPoolAddress: SCOPE() ==
  // 4916574638117198869413701114161172350986437430914933850166949084132905299523).
  getEthPoolScope: function(thenDo) {
    var self = this;
    if (this._ethPoolScope !== undefined) return thenDo(null, this._ethPoolScope);
    var poolAddress = this._ethPoolAddress();
    if (!poolAddress) return thenDo(new Error('PrivacyPoolClient: privacyPoolEthPoolAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        client.readContract({
          address: poolAddress,
          abi: libs.IPrivacyPoolABI,
          functionName: 'SCOPE'
        }).then(function(scope) {
          self._ethPoolScope = scope;
          thenDo(null, scope);
        }).catch(function(e) { thenDo(e); });
      });
    });
  },

  // ── local (main-world, public-data-only) next-deposit-index tracking ──
  // §6.2 step 4's own framing: "main world holds nothing secret... cached
  // locally... fully reconstructable from chain events plus the recovery
  // phrase." generateDepositSecrets(keys, scope, index) is deterministic,
  // so "which index is next" is the one piece of bookkeeping that must
  // never regress once used for a real deposit — reusing an index for two
  // different real deposits would give them the identical nullifier/
  // secret/precommitment, an unrecoverable mixup, not just a cosmetic bug.
  // Reserved (persisted) the instant deriveDepositSecrets succeeds, before
  // signing or broadcasting, so a retried/duplicated attempt can't reuse
  // one — skipping an index on a cancelled attempt is harmless, reusing
  // one is not.
  //
  // KNOWN LIMITATION, deliberately not solved here: this counter lives in
  // this browser's localStorage only. A fresh install of this wallet (same
  // recovery phrase, different device/browser) starts back at index 0 and
  // WILL eventually collide with indices already used for real deposits
  // made elsewhere. Fixing this needs full chain-based account
  // reconstruction (WalletSpec.md §10), which is not a numbered
  // implementation step yet — flagging it here rather than pretending this
  // local counter is a complete solution.
  _depositIndexKey: function(chainId, scope, address) {
    return 'lively.wallet.depositIndex.' + chainId + '.' + scope.toString() + '.' + address.toLowerCase();
  },

  _reserveNextDepositIndex: function(chainId, scope, address) {
    var key = this._depositIndexKey(chainId, scope, address);
    var raw = window.localStorage.getItem(key);
    var index = raw ? BigInt(raw) : 0n;
    window.localStorage.setItem(key, (index + 1n).toString());
    return index;
  },

  // Builds, validates (simulateContract — no key needed, account is an
  // address), and signs (via the vault) a real Entrypoint.deposit(...)
  // transaction. Never broadcasts by itself — see broadcastDeposit.
  // options: { amountEth }. Calls thenDo(null, { signedRawTx, unsignedTx,
  // precommitment, scope, index }).
  buildAndSignDeposit: function(options, thenDo) {
    var self = this;
    var entrypoint = this._entrypointAddress();
    if (!entrypoint) return thenDo(new Error('PrivacyPoolClient: privacyPoolEntrypointAddress is not configured'));
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      self.withClientLibs(function(err2, libs) {
        if (err2) return thenDo(err2);
        lively.identity.walletBridge.getAddress(function(err3, fromAddress) {
          if (err3) return thenDo(err3);
          self.getEthPoolScope(function(err4, scope) {
            if (err4) return thenDo(err4);
            client.getChainId().then(function(chainId) {
              var index = self._reserveNextDepositIndex(chainId, scope, fromAddress);
              lively.identity.walletBridge.deriveDepositSecrets(scope, index, function(err5, res) {
                if (err5) return thenDo(err5);
                var precommitment = res.precommitment;
                var value = libs.parseEther(String(options.amountEth));
                var data = libs.encodeFunctionData({
                  abi: libs.IEntrypointABI,
                  functionName: 'deposit',
                  args: [precommitment]
                });
                // Validates first (decoded revert reason on failure — e.g.
                // below minimum deposit — is far more useful than a bare
                // gas-estimation error), then gets the real gas figure as
                // its own explicit step: simulateContract's returned
                // request does NOT populate .gas in this viem version —
                // confirmed live (returned undefined even for a
                // fully-funded account) rather than assumed.
                client.simulateContract({
                  address: entrypoint,
                  abi: libs.IEntrypointABI,
                  functionName: 'deposit',
                  args: [precommitment],
                  value: value,
                  account: fromAddress
                }).then(function() {
                  return client.estimateContractGas({
                    address: entrypoint,
                    abi: libs.IEntrypointABI,
                    functionName: 'deposit',
                    args: [precommitment],
                    value: value,
                    account: fromAddress
                  });
                }).then(function(gas) {
                  Promise.all([
                    client.getTransactionCount({ address: fromAddress }),
                    client.getGasPrice()
                  ]).then(function(results) {
                    var nonce = results[0], gasPrice = results[1];
                    var unsignedTx = {
                      to: entrypoint,
                      value: value,
                      data: data,
                      nonce: nonce,
                      gas: gas,
                      maxFeePerGas: gasPrice * 2n,
                      maxPriorityFeePerGas: gasPrice,
                      chainId: chainId
                    };
                    lively.identity.walletBridge.signTransaction(unsignedTx, function(err6, signedRawTx) {
                      if (err6) return thenDo(err6);
                      thenDo(null, {
                        signedRawTx: signedRawTx,
                        unsignedTx: unsignedTx,
                        precommitment: precommitment,
                        scope: scope,
                        index: index
                      });
                    });
                  }).catch(function(e) { thenDo(e); });
                }).catch(function(e) { thenDo(e); });
              });
            }).catch(function(e) { thenDo(e); });
          });
        });
      });
    });
  },

  // The one new hard capability this step adds — everything above this
  // point only ever builds and signs. Deliberately its own separate call,
  // never invoked automatically by buildAndSignDeposit, so a caller must
  // take an explicit further action to actually move funds.
  broadcastDeposit: function(signedRawTx, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.sendRawTransaction({ serializedTransaction: signedRawTx })
        .then(function(txHash) { thenDo(null, txHash); })
        .catch(function(e) { thenDo(e); });
    });
  },

  waitForDepositReceipt: function(txHash, thenDo) {
    this._withPublicClient(function(err, client) {
      if (err) return thenDo(err);
      client.waitForTransactionReceipt({ hash: txHash })
        .then(function(receipt) { thenDo(null, receipt); })
        .catch(function(e) { thenDo(e); });
    });
  },

  // Decodes the PrivacyPool-LEVEL Deposited event specifically (indexed
  // _depositor, then commitment/label/value/precommitmentHash) — NOT the
  // differently-shaped Entrypoint-level Deposited event that's also
  // emitted in the same transaction (indexed _depositor/_pool, then
  // commitment/amount only, no label). Conflating the two was flagged as a
  // real risk in WalletSpec.md §6.2 itself; this only ever looks at logs
  // matching the pool address, and only decodes them against
  // IPrivacyPoolABI, never IEntrypointABI, to avoid it structurally.
  parseDepositedEvent: function(receipt, thenDo) {
    var self = this;
    this.withClientLibs(function(err, libs) {
      if (err) return thenDo(err);
      var poolAddress = (self._ethPoolAddress() || '').toLowerCase();
      for (var i = 0; i < receipt.logs.length; i++) {
        var log = receipt.logs[i];
        if (log.address.toLowerCase() !== poolAddress) continue;
        try {
          var decoded = libs.decodeEventLog({
            abi: libs.IPrivacyPoolABI,
            eventName: 'Deposited',
            data: log.data,
            topics: log.topics
          });
          return thenDo(null, {
            depositor: decoded.args._depositor,
            commitment: decoded.args._commitment,
            label: decoded.args._label,
            value: decoded.args._value,
            precommitmentHash: decoded.args._precommitmentHash
          });
        } catch (e) { /* not this log's event — keep scanning */ }
      }
      thenDo(new Error('parseDepositedEvent: no PrivacyPool Deposited event found in this receipt'));
    });
  },

  // Small public, non-secret local cache (§6.2 step 4: "a convenience
  // index, not a secret; fully reconstructable from chain events plus the
  // recovery phrase") so the dashboard can show "your deposits" without a
  // full chain rescan. Not a substitute for §10's real account
  // reconstruction — just enough to make the UI useful today.
  _depositHistoryKey: function(chainId, scope, address) {
    return 'lively.wallet.depositHistory.' + chainId + '.' + scope.toString() + '.' + address.toLowerCase();
  },

  recordLocalDeposit: function(chainId, scope, address, entry) {
    var key = this._depositHistoryKey(chainId, scope, address);
    var raw = window.localStorage.getItem(key);
    var list = raw ? JSON.parse(raw) : [];
    list.push({
      index: entry.index.toString(),
      commitment: entry.commitment.toString(),
      label: entry.label.toString(),
      value: entry.value.toString(),
      txHash: entry.txHash
    });
    window.localStorage.setItem(key, JSON.stringify(list));
  },

  getLocalDeposits: function(chainId, scope, address) {
    var raw = window.localStorage.getItem(this._depositHistoryKey(chainId, scope, address));
    return raw ? JSON.parse(raw) : [];
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
