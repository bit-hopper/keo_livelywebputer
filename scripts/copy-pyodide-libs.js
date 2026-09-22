/**
 * scripts/copy-pyodide-libs.js
 *
 * Vendors Pyodide (CPython compiled to WebAssembly) for the wiki's Python
 * code-cell feature (CodeEditorSpec.md §2.3). Two parts:
 *
 *  1. Copies the core runtime (loader + wasm + stdlib) straight from the
 *     already-`npm install`ed `pyodide` package in node_modules/ — no
 *     network fetch needed, same copy-from-node_modules convention as
 *     build-postcard-libs.js's copyKatexAssets/copyHljsAssets.
 *  2. Fetches numpy + matplotlib and their full transitive dependency
 *     closure — resolved from the vendored pyodide-lock.json's own
 *     `depends` graph, not hand-listed (that graph drifts across Pyodide
 *     versions) — from Pyodide's official jsdelivr CDN distribution for
 *     this exact pinned version, verifying each file's SHA-256 against the
 *     hash already baked into pyodide-lock.json before writing it to disk.
 *     Same integrity-verified-fetch pattern as
 *     fetch-privacy-pools-circuits.js: a controlled, hash-checked fetch
 *     that happens once at build/postinstall time, after which the app
 *     only ever serves its own vendored copies from core/lib/pyodide/ —
 *     never a runtime dependency on jsdelivr.
 *
 * Deliberately NOT vendoring Pyodide's "full" all-packages distribution
 * (200+MB) — only numpy + matplotlib's own closure, per the owner's request
 * to keep charts/plots testable without the full data-science stack.
 * Adding a package later (pandas, scipy, ...) is just adding its name to
 * PACKAGES below; the closure resolution and fetch/verify logic is already
 * generic.
 *
 * Run from the project root: node scripts/copy-pyodide-libs.js
 * (also runs automatically via the postinstall npm script)
 */

'use strict';

var https = require('https');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var rootDir = path.join(__dirname, '..');
var pyodideModuleDir = path.join(rootDir, 'node_modules', 'pyodide');
var outDir = path.join(rootDir, 'core', 'lib', 'pyodide');

// Packages made available to a code cell beyond stdlib. Their full
// transitive dependency closure is resolved below from pyodide-lock.json.
var PACKAGES = ['numpy', 'matplotlib'];

// Loader (pyodide.js, used via importScripts() in the worker; pyodide.mjs
// kept alongside for completeness/future ESM use), the wasm binary + its
// asm.js glue, the stdlib zip, and the lock file the closure resolution
// below reads back out of outDir.
var CORE_FILES = [
  'pyodide.js', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm',
  'python_stdlib.zip', 'pyodide-lock.json',
];

function copyCoreFiles() {
  fs.mkdirSync(outDir, { recursive: true });
  var totalBytes = 0;
  CORE_FILES.forEach(function (name) {
    var src = path.join(pyodideModuleDir, name);
    var dest = path.join(outDir, name);
    fs.copyFileSync(src, dest);
    totalBytes += fs.statSync(dest).size;
  });
  console.log('✓ core runtime (' + CORE_FILES.length + ' files, ' + Math.round(totalBytes / 1024) + ' KB) copied to ' + outDir);
}

function resolveClosure(lock, roots) {
  var closure = {};
  var queue = roots.slice();
  while (queue.length) {
    var name = queue.shift();
    if (closure[name]) continue;
    var entry = lock.packages[name];
    if (!entry) {
      throw new Error('Package "' + name + '" not found in pyodide-lock.json — ' +
        'check the name against the installed Pyodide version\'s package set.');
    }
    closure[name] = entry;
    (entry.depends || []).forEach(function (dep) { queue.push(dep); });
  }
  return closure;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

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

async function fetchPackages() {
  var lock = JSON.parse(fs.readFileSync(path.join(outDir, 'pyodide-lock.json'), 'utf8'));
  var version = require(path.join(pyodideModuleDir, 'package.json')).version;
  var baseUrl = 'https://cdn.jsdelivr.net/pyodide/v' + version + '/full/';
  var closure = resolveClosure(lock, PACKAGES);
  var names = Object.keys(closure).sort();
  var totalBytes = 0;
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var entry = closure[name];
    var dest = path.join(outDir, entry.file_name);
    if (fs.existsSync(dest) && sha256Hex(fs.readFileSync(dest)) === entry.sha256) {
      totalBytes += fs.statSync(dest).size;
      console.log('= ' + entry.file_name + ' (already vendored, verified)');
      continue;
    }
    process.stdout.write('Fetching ' + entry.file_name + ' ... ');
    var buf = await fetchBuffer(baseUrl + entry.file_name);
    var actual = sha256Hex(buf);
    if (actual !== entry.sha256) {
      console.log('FAILED');
      throw new Error(
        'Integrity check failed for ' + entry.file_name + ': expected ' + entry.sha256 +
        ', got ' + actual + ' — refusing to vendor an unverified package.'
      );
    }
    fs.writeFileSync(dest, buf);
    totalBytes += buf.length;
    console.log('OK (' + Math.round(buf.length / 1024) + ' KB, sha256 verified)');
  }
  console.log('✓ ' + names.length + ' packages (' + PACKAGES.join(' + ') + ' + dependencies), ' +
    Math.round(totalBytes / 1024 / 1024 * 10) / 10 + ' MB total, vendored to ' + outDir);
}

async function main() {
  if (!fs.existsSync(pyodideModuleDir)) {
    throw new Error('node_modules/pyodide not found — run `npm install` first.');
  }
  copyCoreFiles();
  await fetchPackages();
}

main().catch(function (e) {
  console.error('Build failed:', e.message);
  process.exit(1);
});
