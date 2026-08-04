/**
 * lively.identity.Wallet
 *
 * WalletSpec.md §9, §15 step 4: the wallet dashboard. `lively.morphic.Box`
 * with hand-drawn chrome, matching FilesBrowser.js's own shape exactly
 * (title bar / toolbar / scrollable content div, all raw DOM — not
 * BuildSpec, since that's what FilesBrowser.js actually is). No
 * secret-touching code here at all — everything routes through
 * lively.identity.walletBridge.
 *
 * Balance/Public tab content (§9.2: address, balance, send/receive) plus
 * deposit (step 7) and withdrawal (step 8) flows, all on the one dashboard
 * screen — Settings and Exit/ragequit are later steps' work, and the
 * Shielded content hasn't been split into its own actual tab yet (no tab
 * affordance is built at all since deposit/withdraw are just buttons off
 * the one screen for now — see each flow's own section below).
 *
 * "Send" builds and signs a transaction (§6.6's simulate-then-sign
 * pattern, via lively.identity.privacyPoolClient) and displays the result
 * as a read-only signed raw tx — it never broadcasts anything. See
 * PrivacyPoolClient.js's own header for why that's a hard absence, not a
 * UI-level restriction.
 *
 * "Deposit into pool" (§9.3, §15 step 7) and "Withdraw from pool" (§9.4,
 * §15 step 8) are the two flows in this dashboard that can actually
 * broadcast — both follow the same shape: build -> Review -> Sign ->
 * (real, user-triggered) Broadcast -> Processing -> Success. Everything up
 * through Sign only builds/signs; broadcasting is a separate, explicit
 * button click, never automatic. Withdrawal additionally has a real
 * Generating-proof screen with phase-by-phase progress (§5.6) between
 * Review and Sign, since proveWithdrawal is genuinely slow.
 *
 * No QR code — confirmed no QR library exists anywhere in this codebase
 * (checked while planning this file); deferred rather than adding a new
 * dependency for it. Copy-to-clipboard reuses PostCardView.js's own
 * pattern (navigator.clipboard.writeText with an execCommand('copy')
 * fallback).
 *
 * Entry point: lively.identity.Wallet.open() — decides no-wallet-yet
 * (routes to WalletSetupDialog) vs locked (inline unlock form) vs
 * unlocked (this dashboard) per §9.1.
 */

module('lively.identity.Wallet')
  .requires(
    'lively.identity.WalletBridge',
    'lively.identity.PrivacyPoolClient',
    'lively.identity.WalletSetupDialog',
  )
  .toRun(function () {

    var WalletClass = lively.morphic.Box.subclass('lively.identity.Wallet',

    'serialization', {
      doNotSerialize: ['_contentDiv', '_toolbarDiv'],
    },

    'initialization', {

      initialize: function ($super, bounds) {
        $super(bounds);
        this._contentDiv = null;
        this._toolbarDiv = null;
        this._buildChrome();
        this._refresh();
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
          'display:flex', 'align-items:center', 'padding:0 12px',
          'box-sizing:border-box',
        ].join(';');
        var titleText = document.createElement('span');
        titleText.textContent = 'Wallet';
        titleText.style.cssText = 'color:#fff;font-size:13px;font-weight:600;font-family:sans-serif;';
        titleBar.appendChild(titleText);
        shapeNode.appendChild(titleBar);

        var toolbarDiv = document.createElement('div');
        toolbarDiv.style.cssText = [
          'position:absolute', 'top:36px', 'left:0', 'right:0', 'height:34px',
          'background:#f2f2f7', 'border-bottom:1px solid #d1d1d6',
          'display:flex', 'align-items:center', 'padding:0 10px',
          'box-sizing:border-box', 'gap:8px', 'font-family:sans-serif',
        ].join(';');
        shapeNode.appendChild(toolbarDiv);
        this._toolbarDiv = toolbarDiv;

        var contentDiv = document.createElement('div');
        contentDiv.style.cssText = [
          'position:absolute', 'top:70px', 'left:0', 'right:0', 'bottom:0',
          'overflow-y:auto', 'padding:12px 16px', 'box-sizing:border-box',
          'font-family:sans-serif', 'font-size:13px',
        ].join(';');
        shapeNode.appendChild(contentDiv);
        this._contentDiv = contentDiv;

        this._renderToolbar();
      },

      _renderToolbar: function () {
        var self = this;
        var bar = this._toolbarDiv;
        bar.innerHTML = '';

        var label = document.createElement('span');
        label.textContent = 'Public tab';
        label.style.cssText = 'flex:1;color:#1c1c1e;font-weight:600;font-size:12px;';
        bar.appendChild(label);

        var refreshBtn = this._makeToolbarBtn('Refresh');
        refreshBtn.addEventListener('click', function () { self._refresh(); });
        bar.appendChild(refreshBtn);

        var lockBtn = this._makeToolbarBtn('Lock');
        lockBtn.addEventListener('click', function () {
          lively.identity.walletBridge.lock(function () { self._refresh(); });
        });
        bar.appendChild(lockBtn);
      },

      _makeToolbarBtn: function (label) {
        var btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = [
          'font-size:11px', 'padding:4px 10px', 'cursor:pointer',
          'border:1px solid #007aff', 'color:#007aff',
          'background:#fff', 'border-radius:4px', 'white-space:nowrap',
        ].join(';');
        return btn;
      },

    },

    'data', {

      // Decides locked vs unlocked by trying getAddress — no separate
      // "isUnlocked" RPC method exists; a locked vault's getAddress simply
      // errors, which is exactly the branch this needs.
      _refresh: function () {
        var self = this;
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Loading…</div>';
        lively.identity.walletBridge.getAddress(function (err, address) {
          if (err) return self._renderUnlockForm();
          self._address = address;
          self._renderDashboard(address);
          lively.identity.privacyPoolClient.getBalance(address, function (err2, balance) {
            if (err2) return self._setBalanceText('(balance unavailable: ' + err2.message + ')');
            self._setBalanceText(balance.eth + ' ETH');
          });
        });
      },

    },

    'rendering', {

      _renderUnlockForm: function () {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Unlock your wallet';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
        content.appendChild(heading);

        var passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.placeholder = 'Password (if you set one up)';
        passwordInput.style.cssText = 'display:block;width:100%;max-width:280px;box-sizing:border-box;padding:6px 8px;margin-bottom:8px;';
        content.appendChild(passwordInput);

        var errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color:#ff3b30;margin-bottom:8px;display:none;';
        content.appendChild(errorMsg);

        var unlockPwBtn = document.createElement('button');
        unlockPwBtn.textContent = 'Unlock with password';
        unlockPwBtn.style.cssText = 'margin-right:8px;';
        unlockPwBtn.addEventListener('click', function () {
          lively.identity.walletBridge.unlock({ password: passwordInput.value }, function (err) {
            if (err) {
              errorMsg.textContent = err.message;
              errorMsg.style.display = 'block';
              return;
            }
            self._refresh();
          });
        });
        content.appendChild(unlockPwBtn);

        var unlockPasskeyBtn = document.createElement('button');
        unlockPasskeyBtn.textContent = 'Unlock with passkey';
        unlockPasskeyBtn.addEventListener('click', function () {
          lively.identity.walletBridge.unlock({}, function (err) {
            if (err) {
              errorMsg.textContent = err.message;
              errorMsg.style.display = 'block';
              return;
            }
            self._refresh();
          });
        });
        content.appendChild(unlockPasskeyBtn);
      },

      _renderDashboard: function (address) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        // ── address ──
        var addrLabel = document.createElement('div');
        addrLabel.textContent = 'Address';
        addrLabel.style.cssText = 'color:#8e8e93;font-size:11px;margin-bottom:4px;';
        content.appendChild(addrLabel);

        var addrRow = document.createElement('div');
        addrRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:16px;';
        var addrText = document.createElement('span');
        addrText.textContent = address;
        addrText.style.cssText = 'font-family:monospace;font-size:12px;word-break:break-all;';
        addrRow.appendChild(addrText);
        var copyBtn = this._makeToolbarBtn('Copy');
        copyBtn.addEventListener('click', function () { self._copyToClipboard(address, copyBtn); });
        addrRow.appendChild(copyBtn);
        content.appendChild(addrRow);

        // ── balance ──
        var balLabel = document.createElement('div');
        balLabel.textContent = 'Balance';
        balLabel.style.cssText = 'color:#8e8e93;font-size:11px;margin-bottom:4px;';
        content.appendChild(balLabel);
        var balText = document.createElement('div');
        balText.textContent = 'Loading…';
        balText.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:16px;';
        content.appendChild(balText);
        this._balanceTextEl = balText;

        // ── deposit / withdraw CTAs (§9.3 deposit / §9.4 withdrawal —
        //    real flows, §15 steps 7/8). No tab affordance yet (same
        //    reasoning as this file's own header note) — both are just
        //    buttons off the one dashboard screen for now. ──
        var depositBtn = document.createElement('button');
        depositBtn.textContent = 'Deposit into pool';
        depositBtn.style.cssText = 'margin-bottom:8px;margin-right:8px;';
        depositBtn.addEventListener('click', function () { self._renderDepositAmount(); });
        content.appendChild(depositBtn);

        var withdrawBtn = document.createElement('button');
        withdrawBtn.textContent = 'Withdraw from pool';
        withdrawBtn.style.cssText = 'margin-bottom:20px;';
        withdrawBtn.addEventListener('click', function () { self._renderWithdrawList(); });
        content.appendChild(withdrawBtn);
        content.appendChild(document.createElement('br'));

        // ── send ──
        var sendHeading = document.createElement('div');
        sendHeading.textContent = 'Send (builds and signs a real transaction, does not broadcast it)';
        sendHeading.style.cssText = 'font-weight:600;margin-bottom:8px;';
        content.appendChild(sendHeading);

        var toInput = document.createElement('input');
        toInput.type = 'text';
        toInput.placeholder = 'Recipient address (0x…)';
        toInput.style.cssText = 'display:block;width:100%;max-width:340px;box-sizing:border-box;padding:6px 8px;margin-bottom:6px;font-family:monospace;';
        content.appendChild(toInput);

        var amountInput = document.createElement('input');
        amountInput.type = 'text';
        amountInput.placeholder = 'Amount (ETH), e.g. 0.001';
        amountInput.style.cssText = 'display:block;width:100%;max-width:200px;box-sizing:border-box;padding:6px 8px;margin-bottom:6px;';
        content.appendChild(amountInput);

        var signBtn = document.createElement('button');
        signBtn.textContent = 'Sign (test only — not broadcast)';
        content.appendChild(signBtn);

        var sendResult = document.createElement('div');
        sendResult.style.cssText = 'margin-top:10px;font-family:monospace;font-size:11px;word-break:break-all;';
        content.appendChild(sendResult);

        signBtn.addEventListener('click', function () {
          sendResult.textContent = 'Building and signing…';
          signBtn.disabled = true;
          lively.identity.privacyPoolClient.buildAndSignTransfer(
            { to: toInput.value, amountEth: amountInput.value },
            function (err, result) {
              signBtn.disabled = false;
              if (err) {
                sendResult.textContent = 'Error: ' + err.message;
                return;
              }
              sendResult.textContent =
                'Signed (NOT broadcast) — raw tx: ' + result.signedRawTx;
            },
          );
        });
      },

      // ── deposit flow (§9.3, §15 step 7) ──
      // Same single-content-div-swap navigation already used for
      // locked/unlocked/dashboard — Amount -> Review -> Sign -> (real,
      // user-triggered) Broadcast -> Processing -> Success. Everything up
      // through Sign only ever builds and signs; nothing here calls
      // broadcastDeposit except the explicit Broadcast click on the Sign
      // screen — per WalletSpec.md §15 step 7, that's the one action this
      // codebase deliberately never takes automatically or during
      // automated verification.

      _renderDepositAmount: function () {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Deposit into the shielded pool';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
        content.appendChild(heading);

        var amountInput = document.createElement('input');
        amountInput.type = 'text';
        amountInput.placeholder = 'Amount (ETH), e.g. 0.01';
        amountInput.style.cssText = 'display:block;width:100%;max-width:200px;box-sizing:border-box;padding:6px 8px;margin-bottom:8px;';
        content.appendChild(amountInput);

        var errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color:#ff3b30;margin-bottom:8px;display:none;';
        content.appendChild(errorMsg);

        var reviewBtn = document.createElement('button');
        reviewBtn.textContent = 'Review';
        reviewBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(reviewBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(cancelBtn);

        reviewBtn.addEventListener('click', function () {
          var amountEth = amountInput.value.trim();
          if (!amountEth || isNaN(Number(amountEth)) || Number(amountEth) <= 0) {
            errorMsg.textContent = 'Enter a valid amount.';
            errorMsg.style.display = 'block';
            return;
          }
          self._renderDepositReview(amountEth);
        });
      },

      _renderDepositReview: function (amountEth) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '<div style="color:#999;padding:20px 0;">Loading pool config…</div>';

        var client = lively.identity.privacyPoolClient;
        client.parseEthAmount(amountEth, function (errAmt, amountWei) {
          if (errAmt) return self._renderDepositError(errAmt.message, function () { self._renderDepositAmount(); });
          client.getAssetConfig(client.ETH_ASSET_PLACEHOLDER, function (err, assetConfig) {
            if (err) return self._renderDepositError(err.message, function () { self._renderDepositAmount(); });

            content.innerHTML = '';
            var heading = document.createElement('div');
            heading.textContent = 'Review deposit';
            heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
            content.appendChild(heading);

            function row(label, value) {
              var r = document.createElement('div');
              r.style.cssText = 'margin-bottom:6px;font-size:12px;';
              r.innerHTML = '<span style="color:#8e8e93;">' + label + ':</span> ' + value;
              content.appendChild(r);
            }

            row('Amount', amountEth + ' ETH');
            var vettingFeeEth = (Number(assetConfig.vettingFeeBPS) / 10000) * Number(amountEth);
            row('Vetting fee', (Number(assetConfig.vettingFeeBPS) / 100) + '% (~' + vettingFeeEth + ' ETH)');
            row('Minimum deposit', (Number(assetConfig.minimumDepositAmount) / 1e18) + ' ETH');
            row('Gas', 'shown on the next screen, after signing');

            var errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'color:#ff3b30;margin:8px 0;display:none;';
            content.appendChild(errorMsg);

            if (amountWei < assetConfig.minimumDepositAmount) {
              errorMsg.textContent = 'Amount is below the minimum deposit for this pool.';
              errorMsg.style.display = 'block';
            }

            var confirmBtn = document.createElement('button');
            confirmBtn.textContent = 'Confirm & Sign';
            confirmBtn.style.cssText = 'margin-right:8px;margin-top:8px;';
            confirmBtn.disabled = amountWei < assetConfig.minimumDepositAmount;
            content.appendChild(confirmBtn);

            var backBtn = document.createElement('button');
            backBtn.textContent = 'Back';
            backBtn.style.cssText = 'margin-top:8px;';
            backBtn.addEventListener('click', function () { self._renderDepositAmount(); });
            content.appendChild(backBtn);

            confirmBtn.addEventListener('click', function () {
              confirmBtn.disabled = true;
              confirmBtn.textContent = 'Building and signing…';
              client.buildAndSignDeposit({ amountEth: amountEth }, function (errBuild, result) {
                if (errBuild) return self._renderDepositError(errBuild.message, function () { self._renderDepositAmount(); });
                self._renderDepositSign(result);
              });
            });
          });
        });
      },

      _renderDepositSign: function (result) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Signed — ready to broadcast';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.style.cssText = 'font-family:monospace;font-size:11px;word-break:break-all;margin-bottom:12px;';
        detail.innerHTML =
          '<div>precommitment: ' + result.precommitment.toString() + '</div>' +
          '<div>scope: ' + result.scope.toString() + '</div>' +
          '<div>index: ' + result.index.toString() + '</div>' +
          '<div>gas: ' + result.unsignedTx.gas.toString() + '</div>' +
          '<div>signed raw tx: ' + result.signedRawTx + '</div>';
        content.appendChild(detail);

        var warning = document.createElement('div');
        warning.textContent = 'Broadcasting submits a REAL mainnet transaction and moves real ETH.';
        warning.style.cssText = 'color:#b00020;font-weight:600;margin-bottom:12px;';
        content.appendChild(warning);

        var broadcastBtn = document.createElement('button');
        broadcastBtn.textContent = 'Broadcast';
        broadcastBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(broadcastBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(cancelBtn);

        broadcastBtn.addEventListener('click', function () {
          broadcastBtn.disabled = true;
          cancelBtn.disabled = true;
          self._renderDepositProcessing();
          var client = lively.identity.privacyPoolClient;
          client.broadcastDeposit(result.signedRawTx, function (errBroadcast, txHash) {
            if (errBroadcast) return self._renderDepositError(errBroadcast.message, function () { self._refresh(); });
            client.waitForDepositReceipt(txHash, function (errReceipt, receipt) {
              if (errReceipt) return self._renderDepositError(errReceipt.message, function () { self._refresh(); });
              client.parseDepositedEvent(receipt, function (errParse, deposited) {
                if (errParse) return self._renderDepositError(errParse.message, function () { self._refresh(); });
                client.recordLocalDeposit(result.unsignedTx.chainId, result.scope, self._address, {
                  index: result.index,
                  commitment: deposited.commitment,
                  label: deposited.label,
                  value: deposited.value,
                  txHash: txHash
                });
                self._renderDepositSuccess(deposited, txHash);
              });
            });
          });
        });
      },

      _renderDepositProcessing: function () {
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Broadcasting and waiting for confirmation…</div>';
      },

      _renderDepositSuccess: function (deposited, txHash) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Deposit confirmed';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;color:#34c759;';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.style.cssText = 'font-family:monospace;font-size:11px;word-break:break-all;margin-bottom:12px;';
        detail.innerHTML =
          '<div>tx: ' + txHash + '</div>' +
          '<div>commitment: ' + deposited.commitment.toString() + '</div>' +
          '<div>label: ' + deposited.label.toString() + '</div>' +
          '<div>value: ' + deposited.value.toString() + ' wei</div>';
        content.appendChild(detail);

        var doneBtn = document.createElement('button');
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(doneBtn);
      },

      _renderDepositError: function (message, backFn) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Deposit failed';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;color:#ff3b30;';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.textContent = message;
        detail.style.cssText = 'margin-bottom:12px;font-size:12px;';
        content.appendChild(detail);

        var backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', function () { backFn(); });
        content.appendChild(backBtn);
      },

      // ── withdrawal flow (§9.4, §15 step 8) ──
      // Direct-submit only (§15 step 8's own scope) — no relayer toggle
      // yet, since RelayerStubServer.js's /relayer/request errors by
      // design and neither real mainnet relayer turned out usable (§14
      // item 4). Spendable-commitment list -> Recipient -> Review ->
      // Generating proof (real phase-by-phase progress, §5.6) -> Sign ->
      // (real, user-triggered) Broadcast -> Processing -> Success — same
      // "everything up through Sign only builds/signs, broadcast is a
      // separate explicit click" discipline as the deposit flow above.
      // Full-value withdrawal only (see PrivacyPoolClient.js's own
      // 'withdrawal' section header for why that's the right v1 scope).

      _renderWithdrawList: function () {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '<div style="color:#999;padding:20px 0;">Loading spendable deposits…</div>';

        var client = lively.identity.privacyPoolClient;
        client.getChainId(function (errChain, chainId) {
          if (errChain) return self._renderWithdrawError(errChain.message, function () { self._refresh(); });
          client.getEthPoolScope(function (errScope, scope) {
            if (errScope) return self._renderWithdrawError(errScope.message, function () { self._refresh(); });
            var deposits = client.getLocalDeposits(chainId, scope, self._address);

            content.innerHTML = '';
            var heading = document.createElement('div');
            heading.textContent = 'Spendable deposits';
            heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
            content.appendChild(heading);

            if (deposits.length === 0) {
              var empty = document.createElement('div');
              empty.textContent =
                'No deposits made from this device yet. (Recovering spendable ' +
                'deposits made on another device needs full chain-based account ' +
                'reconstruction, WalletSpec.md §10 — not built yet.)';
              empty.style.cssText = 'color:#8e8e93;font-size:12px;margin-bottom:12px;';
              content.appendChild(empty);
            }

            var backBtn = document.createElement('button');
            backBtn.textContent = 'Back';
            backBtn.addEventListener('click', function () { self._refresh(); });
            content.appendChild(backBtn);

            if (deposits.length === 0) return;

            var list = document.createElement('div');
            list.style.cssText = 'margin:12px 0;';
            content.insertBefore(list, backBtn);

            deposits.forEach(function (entry) {
              var row = document.createElement('div');
              row.style.cssText = 'border:1px solid #d1d1d6;border-radius:6px;padding:10px;margin-bottom:8px;';

              var amountLine = document.createElement('div');
              amountLine.style.cssText = 'font-weight:600;margin-bottom:4px;';
              amountLine.textContent = (Number(entry.value) / 1e18) + ' ETH';
              row.appendChild(amountLine);

              var labelLine = document.createElement('div');
              labelLine.style.cssText = 'font-family:monospace;font-size:10px;color:#8e8e93;word-break:break-all;margin-bottom:6px;';
              labelLine.textContent = 'label: ' + entry.label;
              row.appendChild(labelLine);

              var statusLine = document.createElement('div');
              statusLine.style.cssText = 'font-size:11px;color:#8e8e93;margin-bottom:8px;';
              statusLine.textContent = 'ASP status: checking…';
              row.appendChild(statusLine);

              var withdrawBtn = document.createElement('button');
              withdrawBtn.textContent = 'Withdraw';
              withdrawBtn.addEventListener('click', function () { self._renderWithdrawRecipient(entry); });
              row.appendChild(withdrawBtn);

              list.appendChild(row);

              // Informational only — the real gate is the ASP-tree Merkle
              // lookup buildWithdrawalProofInputs does at proving time
              // (§6.4.1); reviewStatus's exact value semantics aren't
              // confirmed yet (PrivacyPoolClient.js's own getDepositsByLabel
              // comment), so this never disables the button, just shows
              // whatever the ASP reports.
              client.getDepositsByLabel(chainId, scope, [entry.label], function (errStatus, results) {
                if (errStatus || !results || !results.length) {
                  statusLine.textContent = 'ASP status: unknown (not yet visible to the ASP?)';
                  return;
                }
                statusLine.textContent = 'ASP status: ' + (results[0].reviewStatus || 'unknown');
              });
            });
          });
        });
      },

      _renderWithdrawRecipient: function (commitment) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Withdraw ' + (Number(commitment.value) / 1e18) + ' ETH';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
        content.appendChild(heading);

        var recipientInput = document.createElement('input');
        recipientInput.type = 'text';
        recipientInput.placeholder = 'Recipient address (0x…)';
        recipientInput.style.cssText = 'display:block;width:100%;max-width:340px;box-sizing:border-box;padding:6px 8px;margin-bottom:6px;font-family:monospace;';
        content.appendChild(recipientInput);

        // §2.1 step 5, §9.2: reusing an already-used address re-links what
        // the pool just unlinked — nudge toward a fresh one rather than
        // just a placeholder hint.
        var hint = document.createElement('div');
        hint.textContent = 'Use a fresh address you have not used before — reusing one re-links what this withdrawal unlinks.';
        hint.style.cssText = 'color:#8e8e93;font-size:11px;margin-bottom:8px;max-width:340px;';
        content.appendChild(hint);

        var errorMsg = document.createElement('div');
        errorMsg.style.cssText = 'color:#ff3b30;margin-bottom:8px;display:none;';
        content.appendChild(errorMsg);

        var reviewBtn = document.createElement('button');
        reviewBtn.textContent = 'Review';
        reviewBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(reviewBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._renderWithdrawList(); });
        content.appendChild(cancelBtn);

        reviewBtn.addEventListener('click', function () {
          lively.identity.privacyPoolClient.withClientLibs(function (err, libs) {
            var recipient = recipientInput.value.trim();
            if (err || !libs.getAddress || !isValidAddress(recipient)) {
              errorMsg.textContent = 'Enter a valid address.';
              errorMsg.style.display = 'block';
              return;
            }
            self._renderWithdrawReview(commitment, recipient);
          });
          function isValidAddress(addr) { return /^0x[0-9a-fA-F]{40}$/.test(addr); }
        });
      },

      _renderWithdrawReview: function (commitment, recipient) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Review withdrawal';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
        content.appendChild(heading);

        function row(label, value) {
          var r = document.createElement('div');
          r.style.cssText = 'margin-bottom:6px;font-size:12px;word-break:break-all;';
          r.innerHTML = '<span style="color:#8e8e93;">' + label + ':</span> ' + value;
          content.appendChild(r);
        }

        row('Amount', (Number(commitment.value) / 1e18) + ' ETH (full value — no partial withdrawal yet)');
        row('Recipient', recipient);
        row('Submission', 'Direct (no relayer — relayed submission is a later addition, §14 item 4)');
        row('Relayer fee', 'None (direct submission)');

        var confirmBtn = document.createElement('button');
        confirmBtn.textContent = 'Confirm & Generate Proof';
        confirmBtn.style.cssText = 'margin-right:8px;margin-top:8px;';
        content.appendChild(confirmBtn);

        var backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.style.cssText = 'margin-top:8px;';
        backBtn.addEventListener('click', function () { self._renderWithdrawRecipient(commitment); });
        content.appendChild(backBtn);

        confirmBtn.addEventListener('click', function () {
          self._renderWithdrawProving(commitment, recipient);
        });
      },

      // Real phase-by-phase progress (§5.6, §9.4) — loading_circuits ->
      // generating_proof -> verifying_proof — rather than a frozen button;
      // proveWithdrawal genuinely takes real wall-clock time.
      _renderWithdrawProving: function (commitment, recipient) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Generating proof…';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
        content.appendChild(heading);

        var phaseText = document.createElement('div');
        phaseText.textContent = 'Starting…';
        phaseText.style.cssText = 'color:#8e8e93;font-size:12px;';
        content.appendChild(phaseText);

        var PHASE_LABELS = {
          loading_circuits: 'Loading circuit artifacts…',
          generating_proof: 'Generating zero-knowledge proof… (this can take a while)',
          verifying_proof: 'Verifying proof…'
        };

        lively.identity.privacyPoolClient.buildAndSignWithdrawal(
          { commitment: commitment, recipient: recipient },
          function (phase) { phaseText.textContent = PHASE_LABELS[phase] || phase; },
          function (err, result) {
            if (err) return self._renderWithdrawError(err.message, function () { self._renderWithdrawRecipient(commitment); });
            self._renderWithdrawSign(commitment, result);
          }
        );
      },

      _renderWithdrawSign: function (commitment, result) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Signed — ready to broadcast';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.style.cssText = 'font-family:monospace;font-size:11px;word-break:break-all;margin-bottom:12px;';
        detail.innerHTML =
          '<div>gas: ' + result.unsignedTx.gas.toString() + '</div>' +
          '<div>signed raw tx: ' + result.signedRawTx + '</div>';
        content.appendChild(detail);

        var warning = document.createElement('div');
        warning.textContent = 'Broadcasting submits a REAL mainnet transaction and moves real ETH out of the shielded pool.';
        warning.style.cssText = 'color:#b00020;font-weight:600;margin-bottom:12px;';
        content.appendChild(warning);

        var broadcastBtn = document.createElement('button');
        broadcastBtn.textContent = 'Broadcast';
        broadcastBtn.style.cssText = 'margin-right:8px;';
        content.appendChild(broadcastBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(cancelBtn);

        broadcastBtn.addEventListener('click', function () {
          broadcastBtn.disabled = true;
          cancelBtn.disabled = true;
          self._renderWithdrawProcessing();
          var client = lively.identity.privacyPoolClient;
          client.broadcastWithdrawal(result.signedRawTx, function (errBroadcast, txHash) {
            if (errBroadcast) return self._renderWithdrawError(errBroadcast.message, function () { self._refresh(); });
            client.waitForWithdrawalReceipt(txHash, function (errReceipt, receipt) {
              if (errReceipt) return self._renderWithdrawError(errReceipt.message, function () { self._refresh(); });
              client.parseWithdrawnEvent(receipt, function (errParse, withdrawn) {
                if (errParse) return self._renderWithdrawError(errParse.message, function () { self._refresh(); });
                self._renderWithdrawSuccess(withdrawn, txHash);
              });
            });
          });
        });
      },

      _renderWithdrawProcessing: function () {
        this._contentDiv.innerHTML = '<div style="color:#999;padding:20px 0;">Broadcasting and waiting for confirmation…</div>';
      },

      _renderWithdrawSuccess: function (withdrawn, txHash) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Withdrawal confirmed';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;color:#34c759;';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.style.cssText = 'font-family:monospace;font-size:11px;word-break:break-all;margin-bottom:12px;';
        detail.innerHTML =
          '<div>tx: ' + txHash + '</div>' +
          '<div>recipient: ' + withdrawn.processooor + '</div>' +
          '<div>value: ' + withdrawn.value.toString() + ' wei</div>';
        content.appendChild(detail);

        var doneBtn = document.createElement('button');
        doneBtn.textContent = 'Done';
        doneBtn.addEventListener('click', function () { self._refresh(); });
        content.appendChild(doneBtn);
      },

      _renderWithdrawError: function (message, backFn) {
        var self = this;
        var content = this._contentDiv;
        content.innerHTML = '';

        var heading = document.createElement('div');
        heading.textContent = 'Withdrawal failed';
        heading.style.cssText = 'font-weight:600;margin-bottom:12px;color:#ff3b30;';
        content.appendChild(heading);

        var detail = document.createElement('div');
        detail.textContent = message;
        detail.style.cssText = 'margin-bottom:12px;font-size:12px;';
        content.appendChild(detail);

        var backBtn = document.createElement('button');
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', function () { backFn(); });
        content.appendChild(backBtn);
      },

      _setBalanceText: function (text) {
        if (this._balanceTextEl) this._balanceTextEl.textContent = text;
      },

      // Same clipboard approach as PostCardView.js's tip-jar Copy button.
      _copyToClipboard: function (text, btn) {
        var originalLabel = btn.textContent;
        function copied() {
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = originalLabel; }, 1200);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(copied).catch(function () {});
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); copied(); } catch (e2) {}
          document.body.removeChild(ta);
        }
      },

    }); // end subclass

    // ── class-side entry point ───────────────────────────────────────────────

    Object.extend(WalletClass, {
      // §9.1: no-wallet-yet routes to WalletSetupDialog; has-a-wallet opens
      // this dashboard directly (which itself handles locked vs unlocked).
      open: function () {
        lively.identity.walletBridge.isSetUp(function (err, isSetUp) {
          if (err || !isSetUp) {
            lively.BuildSpec('lively.identity.WalletSetupDialog').createMorph().openInWorldCenter();
            return;
          }
          var morph = new lively.identity.Wallet(lively.rect(0, 0, 480, 520));
          morph.openInWorldCenter();
          morph.bringToFront();
        });
      },
    });

  }); // end module('lively.identity.Wallet')
