/**
 * core/servers/RelayerStubServer.js
 *
 * life_star subserver. WalletSpec.md §6.5, §15 step 5.
 *
 * A **local stub only** — not a real relayer. Implements the exact
 * confirmed REST contract of `privacy-pools-core`'s `packages/relayer`
 * (§6.5: POST /relayer/quote, POST /relayer/request, GET /relayer/details)
 * so `PrivacyPoolClient.js`'s calling code has something real to exercise
 * the plumbing shape against, without standing up actual infrastructure —
 * self-hosting the real relayer needs its own funded operator wallet (it
 * pays gas on the user's behalf) and real hosting, both explicit
 * user-deferred decisions, not something to fake.
 *
 * Honest-stub design, matching the "never fake success on money-moving
 * operations" principle already applied to signTransaction/
 * buildAndSignTransfer (WalletSpec.md §15 step 4): /relayer/quote and
 * /relayer/details return plausible read-only numbers (safe — no funds
 * move), but /relayer/request — the endpoint that would actually submit a
 * withdrawal transaction on the caller's behalf — always errors rather
 * than pretending to succeed. A stub that fabricated a txHash here would
 * be actively dangerous: calling code would believe a withdrawal happened
 * when nothing was ever broadcast.
 *
 * Routes (mounted at /nodejs/RelayerStubServer/ by life_star's filename-
 * based auto-discovery — see bin/lk-server.js):
 *
 *   POST /nodejs/RelayerStubServer/relayer/quote
 *   POST /nodejs/RelayerStubServer/relayer/request
 *   GET  /nodejs/RelayerStubServer/relayer/details
 *
 * Only the path *suffix* after the mount point matters for compatibility
 * with the real service — swapping privacyPoolRelayerEndpoint (§12) to a
 * real self-hosted or third-party relayer later is purely a base-URL
 * config change, no client code change, since PrivacyPoolClient.js always
 * appends the same /relayer/... suffixes the real service also uses.
 */

"use strict";

module.exports = function (route, app) {

  // Fixed, clearly-fake test numbers — not derived from any real gas
  // estimation. baseFeeBPS/feeBPS shape matches §6.5 exactly.
  var STUB_FEE_BPS = 100; // 1%

  app.post(route + "relayer/quote", function (req, res) {
    var body = req.body || {};
    if (!body.chainId || !body.amount || !body.asset) {
      return res.status(400).json({ error: "chainId, amount, and asset are required" });
    }
    res.json({
      baseFeeBPS: STUB_FEE_BPS,
      feeBPS: STUB_FEE_BPS,
      // No feeCommitment: a real one is signed by the relayer's own key,
      // which this stub deliberately doesn't have (no real operator
      // wallet exists here — see this file's own header).
      feeCommitment: null,
    });
  });

  app.post(route + "relayer/request", function (req, res) {
    res.status(501).json({
      error:
        "RelayerStubServer: this is a local stub, not a real relayer — " +
        "it cannot broadcast a withdrawal. Use direct submission instead " +
        "(WalletSpec.md §6.4 step 3), or configure a real relayer via " +
        "privacyPoolRelayerEndpoint once one is actually deployed.",
    });
  });

  app.get(route + "relayer/details", function (req, res) {
    if (!req.query.chainId || !req.query.assetAddress) {
      return res.status(400).json({ error: "chainId and assetAddress query params are required" });
    }
    res.json({
      feeBPS: STUB_FEE_BPS,
      minWithdrawAmount: "0",
      feeReceiverAddress: "0x0000000000000000000000000000000000000000",
      assetAddress: req.query.assetAddress,
      maxGasPrice: "0",
    });
  });

  app.get(route, function (req, res) {
    res.json({ status: "RelayerStubServer running — local stub, not a real relayer" });
  });
};
