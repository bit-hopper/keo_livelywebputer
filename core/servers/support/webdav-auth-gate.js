/*global require, module, process*/

// Gates the classic WebDAV write path (`lively-davfs`) behind the real
// identity-system session, since that legacy path otherwise has zero
// authentication at all -- any anonymous PUT/DELETE/MOVE/PROPPATCH/MKCOL/
// COPY succeeds against welcome.html, everything under core/, classic
// PartsBin/* parts, and every user's classic /users/<name>/* world. See
// WEBDAV.md sec 0/0.1 and DeployCheckList.md's WebDAV item for the full
// root-cause trail and why this is the chosen interception point (patching
// LivelyFsHandler.prototype.handleRequest rather than editing the vendored
// lively-davfs/jsDAV packages directly, or wiring jsDAV's own bundled auth
// plugin, which would also block anonymous GETs the app needs for booting).
//
// Policy (decided 2026-09-06, pending a real "core maintainer" DID
// allowlist -- see ADMIN_DIDS below):
//   - unauthenticated caller, any write verb: rejected, 401.
//   - authenticated caller, path is core/**, welcome.html, or start.html
//     (the app-entry boot pages): rejected, 403. Framework source and the
//     boot pages are deny-all for everyone at runtime until a real
//     maintainer allowlist exists.
//   - authenticated caller, everything else DAV currently serves (classic
//     PartsBin/* parts, personal /users/** worlds, other root-level scratch
//     .html files): allowed. This is a coarse trust downgrade from real
//     per-resource ownership, not a substitute for it -- but no ownership
//     data exists anywhere in this codebase for classic content (confirmed
//     by a full sweep, WEBDAV.md sec 0.1), and building it from scratch for
//     a subsystem this project's own roadmap is already retiring in favor
//     of the DID object store isn't worth doing before that migration.
//
// Reads (GET/HEAD/PROPFIND/REPORT/OPTIONS) are never touched here -- they
// have to stay public, since anonymous visitors boot the whole app by
// GETting welcome.html/core/*.js.

var WRITE_METHODS = {
  PUT: true,
  DELETE: true,
  PROPPATCH: true,
  MKCOL: true,
  MOVE: true,
  COPY: true
};

// TODO(core-maintainers): this is intentionally empty -- there is no DID
// allowlist yet (explicit product decision, 2026-09-06: deny all runtime
// writes to core/+welcome.html rather than pick an initial admin list
// ad hoc). Once a real "core maintainer" concept exists, populate this from
// e.g. (process.env.LK_ADMIN_DIDS || '').split(',').filter(Boolean).
var ADMIN_DIDS = [];

var FRAMEWORK_CRITICAL_RE = /^core\//;

function normalizedPath(url) {
  // Strip query string and any leading slashes so "/core/x" and "core/x"
  // compare the same way; deliberately not resolving ".."/"."  segments --
  // jsDAV's own tree implementation is what's responsible for refusing
  // path traversal, this check only ever narrows what gets past it.
  var withoutQuery = String(url || '').split('?')[0];
  return withoutQuery.replace(/^\/+/, '');
}

var FRAMEWORK_CRITICAL_FILES = { 'welcome.html': true, 'start.html': true };

function isFrameworkCritical(url) {
  var path = normalizedPath(url);
  return FRAMEWORK_CRITICAL_FILES[path] === true || FRAMEWORK_CRITICAL_RE.test(path);
}

function getSessionDid(req) {
  return (req.session && req.session['identity-did']) || null;
}

function deny(res, status, message) {
  res.status(status);
  res.end(message);
}

// Installs the gate by wrapping LivelyFsHandler.prototype.handleRequest.
// Idempotent -- safe to call more than once per process.
function install() {
  var LivelyFsHandler = require('lively-davfs/request-handler');
  if (LivelyFsHandler.prototype.handleRequest._webdavAuthGateInstalled) return;

  var originalHandleRequest = LivelyFsHandler.prototype.handleRequest;

  function gatedHandleRequest(req, res, next) {
    var method = String(req.method || '').toUpperCase();

    if (!WRITE_METHODS[method]) {
      return originalHandleRequest.call(this, req, res, next);
    }

    // Paths this handler doesn't own (e.g. /api/, /xrpc/) fall through to
    // Express's own routes/auth elsewhere -- unchanged from before this
    // gate existed, just checked earlier so we don't 401 a request this
    // handler was never going to touch.
    if (this.isExcludedPath && this.isExcludedPath(req.url)) {
      return originalHandleRequest.call(this, req, res, next);
    }

    var did = getSessionDid(req);

    if (isFrameworkCritical(req.url)) {
      if (!did || ADMIN_DIDS.indexOf(did) === -1) {
        return deny(res, 403, 'Forbidden: framework files are read-only at runtime.');
      }
      return originalHandleRequest.call(this, req, res, next);
    }

    if (!did) {
      return deny(res, 401, 'Authentication required.');
    }

    return originalHandleRequest.call(this, req, res, next);
  }

  gatedHandleRequest._webdavAuthGateInstalled = true;
  LivelyFsHandler.prototype.handleRequest = gatedHandleRequest;
}

module.exports = { install: install };
