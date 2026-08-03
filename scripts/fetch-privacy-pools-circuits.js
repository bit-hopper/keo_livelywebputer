/**
 * scripts/fetch-privacy-pools-circuits.js
 *
 * One-time build-time fetch (WalletSpec.md §5.5, §15 step 6) — NOT a
 * runtime dependency on a third party. Exactly the same class of thing as
 * `npm install` fetching packages from the registry: a controlled,
 * integrity-verified fetch that happens once at build/postinstall time,
 * after which the app only ever serves its own vendored copies.
 *
 * Run from the project root: node scripts/fetch-privacy-pools-circuits.js
 * (also runs automatically via the postinstall npm script)
 *
 * Source: 0xbow-io/privacy-pools-website's public/artifacts/ (public
 * GitHub repo, confirmed this is where the reference frontend itself
 * ships these exact files — see privacy-pools-website's own
 * src/utils/sdk.ts: `new Circuits({ baseUrl: window.location.origin })`,
 * and the SDK's circuits.impl.ts hardcodes the `artifacts/<name>` path
 * suffix, not configurable). Pinned to a specific commit, not a moving
 * branch ref, so this script's behavior doesn't change out from under it.
 *
 * Integrity: verified against the exact SHA-256 hashes baked into the
 * installed @0xbow/privacy-pools-core-sdk's own artifactHashes.ts
 * (verifyArtifactIntegrity) — copied here rather than imported so this
 * script has no dependency on that internal, unexported module path.
 * Confirmed by hand before writing this script: every one of the 6 files
 * downloaded from the pinned commit hashes to exactly these values.
 * Fails loudly (throws, nonzero exit) on any mismatch — never silently
 * serves an unverified artifact.
 */

'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var COMMIT = '18221fe8fb24284308e2637369c6c3e526dccdae';
var BASE_URL = 'https://raw.githubusercontent.com/0xbow-io/privacy-pools-website/' + COMMIT + '/public/artifacts/';

var EXPECTED_SHA256 = {
  'commitment.wasm': '254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8',
  'commitment.vkey': '7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8',
  'commitment.zkey': '494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3',
  'withdraw.wasm':   '36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10',
  'withdraw.vkey':   '666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e',
  'withdraw.zkey':   '2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677',
};

var rootDir = path.join(__dirname, '..');
var outDir = path.join(rootDir, 'core', 'lib', 'privacy-pools', 'artifacts');
fs.mkdirSync(outDir, { recursive: true });

function fetchBuffer(url, redirectsLeft) {
  redirectsLeft = redirectsLeft === undefined ? 5 : redirectsLeft;
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(fetchBuffer(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GET ' + url + ' -> HTTP ' + res.statusCode));
      }
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function main() {
  var names = Object.keys(EXPECTED_SHA256);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var url = BASE_URL + name;
    process.stdout.write('Fetching ' + name + ' ... ');
    var buf = await fetchBuffer(url);
    var actual = sha256Hex(buf);
    var expected = EXPECTED_SHA256[name];
    if (actual !== expected) {
      console.log('FAILED');
      throw new Error(
        'Integrity check failed for ' + name + ': expected ' + expected + ', got ' + actual +
        ' — refusing to write an unverified circuit artifact.'
      );
    }
    fs.writeFileSync(path.join(outDir, name), buf);
    console.log('OK (' + Math.round(buf.length / 1024) + ' KB, sha256 verified)');
  }
  console.log('✓ All 6 circuit artifacts fetched and verified -> ' + outDir);
}

main().catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
