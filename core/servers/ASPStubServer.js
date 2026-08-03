/**
 * core/servers/ASPStubServer.js
 *
 * life_star subserver. WalletSpec.md §6.3, §15 step 5.
 *
 * An **offline/no-network fallback only** — not the default. §15 step 5
 * found and live-verified the real production ASP API (api.0xbow.io,
 * confirmed working directly from a browser at Lively's own origin,
 * including CORS preflight for its custom X-Pool-Scope header) — that's
 * now config.json's actual default for privacyPoolAspEndpoint. This stub
 * exists for working without internet access, or deliberately testing
 * against a known-empty association set; point privacyPoolAspEndpoint at
 * this server's own URL to use it instead (see localconfig.js's comment).
 *
 * Routes mirror the real API's exact path shape (confirmed via direct
 * source reading of useASP.ts/aspClient, not guessed) so switching between
 * the real host and this fallback is purely a base-URL config change, no
 * client-code difference — mounted at /nodejs/ASPStubServer/ by life_star's
 * filename-based auto-discovery (see bin/lk-server.js):
 *
 *   GET /nodejs/ASPStubServer/:chainId/public/pool-info
 *   GET /nodejs/ASPStubServer/:chainId/public/mt-roots
 *   GET /nodejs/ASPStubServer/:chainId/public/mt-leaves
 *   GET /nodejs/ASPStubServer/:chainId/public/events?page=&perPage=
 *   GET /nodejs/ASPStubServer/:chainId/public/deposits-by-label
 *
 * Every real call carries the pool's scope via an X-Pool-Scope header
 * (decimal string), not a path/query param — deposits-by-label also needs
 * X-Labels (comma-joined). No auth on any of these, matching the real API.
 *
 * Honest-stub design: this always reports an EMPTY association set (a
 * zero root, no leaves, nothing associated) rather than fabricating a
 * plausible-looking non-empty one. A fake non-zero root with no real
 * Merkle leaf data behind it would be worse than an honestly-empty one —
 * client code could believe something is vetted when it could never
 * actually produce a valid inclusion proof for it.
 */

"use strict";

module.exports = function (route, app) {

  function requireScope(req, res) {
    if (!req.get("X-Pool-Scope")) {
      res.status(400).json({ error: "X-Pool-Scope header is required" });
      return false;
    }
    return true;
  }

  app.get(route + ":chainId/public/pool-info", function (req, res) {
    if (!requireScope(req, res)) return;
    res.json({
      overview: {
        chainId: req.params.chainId,
        address: null,
        token: null,
        tokenAddr: null,
      },
      totalDepositsValueUsd: "0",
      totalDepositsValue: "0",
      totalDepositsCount: 0,
      acceptedDepositsValueUsd: "0",
      recentEvents: [],
      growth24h: "0",
    });
  });

  app.get(route + ":chainId/public/mt-roots", function (req, res) {
    if (!requireScope(req, res)) return;
    res.json({ mtRoot: "0", createdAt: new Date().toISOString(), onchainMtRoot: "0" });
  });

  app.get(route + ":chainId/public/mt-leaves", function (req, res) {
    if (!requireScope(req, res)) return;
    res.json({ aspLeaves: [], stateTreeLeaves: [] });
  });

  app.get(route + ":chainId/public/events", function (req, res) {
    if (!requireScope(req, res)) return;
    res.json({
      events: [],
      page: parseInt(req.query.page, 10) || 1,
      perPage: parseInt(req.query.perPage, 10) || 12,
      total: 0,
    });
  });

  app.get(route + ":chainId/public/deposits-by-label", function (req, res) {
    if (!requireScope(req, res)) return;
    if (!req.get("X-Labels")) {
      return res.status(400).json({ error: "X-Labels header is required" });
    }
    res.json([]);
  });

  app.get(route, function (req, res) {
    res.json({ status: "ASPStubServer running — local stub, not a real ASP" });
  });
};
