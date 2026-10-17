// @ts-check
const { test, expect } = require("@playwright/test");

// Block, mute and RSS writes go through DID._patchRelationships. It must re-GET
// the settings envelope before mutating: a copy cached earlier would otherwise
// write back an old `state` and drop lists/audiences saved since. The server is
// stubbed here (a throwaway signed-out page has no real account).
test("settings writes start from a fresh GET, not the cached copy", async ({ page }) => {
  await page.goto("/blank.html");
  await page.waitForFunction(
    () => window.$world && window.lively && lively.identity && lively.identity.did && lively.identity.crypto,
    { timeout: 30000 },
  );

  const result = await page.evaluate(() => new Promise((resolve) => {
    const did = lively.identity.did;
    const serverEnv = {
      record: { cid: "old", payload: { kind: "settings" } },
      state: { blockedDids: [], blockedHandles: [] },
    };
    const puts = [];
    const realFetch = window.fetch;
    window.fetch = function (url, opts) {
      if (String(url).indexOf("/@tester/settings") === -1) return realFetch.apply(this, arguments);
      const body = (opts && opts.method === "PUT")
        ? (puts.push(JSON.parse(opts.body)), (serverEnv.state = JSON.parse(opts.body).state), "{}")
        : JSON.stringify(serverEnv);
      return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
    };

    did._currentUser = { handle: "tester", did: "did:test:1" };
    // A copy loaded earlier in the session, before the lists existed.
    did._relationshipsEnvelope = JSON.parse(JSON.stringify(serverEnv));
    // Another writer saves a list and a card audience in the meantime.
    serverEnv.state.audienceLists = [{ id: "l1", name: "Close", memberDids: ["did:x"] }];
    serverEnv.state.cardAudiences = { abc: { tiers: ["friends"], people: [] } };

    did.blockDid("did:bad", "bad", (err, env) => {
      window.fetch = realFetch;
      resolve({
        err: err && String(err),
        puts: puts.length,
        sent: puts[0] && puts[0].state,
        cachedHasLists: !!(did._relationshipsEnvelope.state && did._relationshipsEnvelope.state.audienceLists),
        isBlocked: did.isBlocked("did:bad", "bad"),
        returnedEnvState: env && env.state,
      });
    });
  }));

  expect(result.err).toBeNull();
  expect(result.puts).toBe(1);
  expect(result.sent.blockedDids).toEqual(["did:bad"]);
  expect(result.sent.audienceLists).toEqual([{ id: "l1", name: "Close", memberDids: ["did:x"] }]);
  expect(result.sent.cardAudiences).toEqual({ abc: { tiers: ["friends"], people: [] } });
  expect(result.cachedHasLists).toBe(true);
  expect(result.isBlocked).toBe(true);
});
