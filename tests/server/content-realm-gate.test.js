// Unit tests for the host-based realm rules (core/servers/support/content-realm-gate.js).
// Pure functions, no server: `node --test tests/server/content-realm-gate.test.js`.
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../../core/servers/support/content-realm-gate");

const cfg = g.parseConfig({ LK_APP_HOSTS: "dev.tinylil.world, localhost:9001", LK_WORLDS_ORIGIN: "https://worlds.example.net/" });

test("parseConfig: empty means inert; a malformed worlds origin is dropped", () => {
  assert.deepEqual(g.parseConfig({}).appHosts, []);
  assert.equal(g.realmOf("anything", g.parseConfig({})), "inert");
  assert.equal(g.parseConfig({ LK_APP_HOSTS: "a", LK_WORLDS_ORIGIN: "javascript:alert(1)" }).worldsOrigin, null);
  assert.equal(cfg.worldsOrigin, "https://worlds.example.net");
});

test("realmOf: app, vault and content hosts", () => {
  assert.equal(g.realmOf("dev.tinylil.world", cfg), "app");
  assert.equal(g.realmOf("DEV.tinylil.world:443", cfg), "app");          // entry without a port matches any port
  assert.equal(g.realmOf("localhost:9001", cfg), "app");
  assert.equal(g.realmOf("localhost:9002", cfg), "content");             // entry with a port matches exactly
  assert.equal(g.realmOf("vault.dev.tinylil.world", cfg), "vault");
  assert.equal(g.realmOf("vault.localhost:9001", cfg), "vault");
  assert.equal(g.realmOf("vault.evil.example", cfg), "content");
  assert.equal(g.realmOf("worlds.example.net", cfg), "content");
  assert.equal(g.realmOf("evil.example.com", cfg), "content");
  assert.equal(g.realmOf("", cfg), "content");                           // no Host header: default deny
});

test("contentDenial: read-only, no vault pages, no subservers except the anonymous session probe", () => {
  assert.equal(g.contentDenial("GET", "/core/lively/bootstrap.js"), null);
  assert.equal(g.contentDenial("GET", "/@alice/abc123def456"), null);
  assert.equal(g.contentDenial("HEAD", "/x"), null);
  for (const m of ["POST", "PUT", "DELETE", "PROPPATCH", "MKCOL", "MOVE", "COPY"]) assert.ok(g.contentDenial(m, "/x"), m);
  assert.ok(g.contentDenial("POST", "/nodejs/IdentityServer/authenticate"));
  assert.ok(g.contentDenial("GET", "/identity-vault"));
  assert.ok(g.contentDenial("GET", "/wallet-vault?x=1"));
  assert.ok(g.contentDenial("GET", "/nodejs/CommandLineServer/"));
  assert.ok(g.contentDenial("GET", "/nodejs/IdentityServer/challenge"));
  assert.equal(g.contentDenial("GET", "/nodejs/IdentityServer/session"), null);
  assert.equal(g.contentDenial("GET", "/nodejs/IdentityServer/session?x=1"), null);
});

test("shouldRedirectToWorlds: only a foreign PUBLIC world requested on the app realm", () => {
  const w = (extra) => Object.assign({ type: "world", visibility: "public", did: "did:jwk:author" }, extra);
  const r = (host, env, id) => g._pure.shouldRedirectToWorlds(host, env, id, cfg);
  assert.equal(r("dev.tinylil.world", w(), null), true);                                // anonymous visitor
  assert.equal(r("dev.tinylil.world", w(), { did: "did:jwk:visitor" }), true);          // signed-in visitor
  assert.equal(r("dev.tinylil.world", w(), { did: "did:jwk:author" }), false);          // the owner
  assert.equal(r("dev.tinylil.world", w({ visibility: "private" }), null), false);      // needs identity to decrypt
  assert.equal(r("dev.tinylil.world", w({ visibility: "shared" }), { did: "x" }), false);
  assert.equal(r("dev.tinylil.world", w({ type: "part" }), null), false);
  assert.equal(r("worlds.example.net", w(), null), false);                              // already on the content realm: no loop
  assert.equal(r("vault.dev.tinylil.world", w(), null), false);
  assert.equal(g._pure.shouldRedirectToWorlds("dev.tinylil.world", w(), null, g.parseConfig({ LK_APP_HOSTS: "dev.tinylil.world" })), false); // no worlds origin
});

test("worldsUrl keeps path and query", () => {
  assert.equal(g._pure.worldsUrl("/@alice/abc123def456?x=1", cfg), "https://worlds.example.net/@alice/abc123def456?x=1");
});
