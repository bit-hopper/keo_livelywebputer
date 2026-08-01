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
 * As of step 4, only the plain-ETH subset this step needs: getBalance and
 * buildAndSignTransfer. Pool-specific methods (deposit/withdraw/ragequit,
 * ASP root fetch, chain-event scan for spendable commitments) are step 7+'s
 * addition to this same file, per §11's file map.
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

});

lively.identity.privacyPoolClient = new lively.identity.PrivacyPoolClient();

}); // end module('lively.identity.PrivacyPoolClient')
