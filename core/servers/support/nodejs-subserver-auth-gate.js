/*global require, module, process*/

// Gates the auto-mounted `/nodejs/<subserver>/` HTTP routes behind the real
// identity-system session, for the subset of subservers in core/servers/
// that are unauthenticated remote-code-execution primitives by design --
// PythonSubserver.js/HaskellServer.js/ClojureServer.js/RServer.js (pipe
// arbitrary code into a live interpreter), CommandLineServer.js (spawns
// `bash -c <arbitrary command>` / `cmd /C ...`), NodeJSEvalServer.js (raw
// `eval()` on the server process itself), SQLiteServer.js (`eval()`s its
// `dbAccessor` field plus unrestricted SQL), and PtyServer.js (spawns a
// real interactive shell). None of these files had any auth of their own --
// confirmed live, see DeployCheckList.md's
// "[CRITICAL/SECURITY] unauthenticated RCE via /nodejs/* language-server
// subservers" item for the full audit trail. Same session-DID +
// ADMIN_DIDS-allowlist pattern as webdav-auth-gate.js, which fixed the
// exact same class of "zero auth on a powerful legacy path" problem for
// WebDAV writes.
//
// Also gates life_star's own subserver meta-control API
// (`/nodejs/subservers/...`, see node_modules/life_star/lib/subservers.js)
// -- PUT there overwrites *any* subserver's source file on disk and
// immediately requires+executes it, which is arbitrary-file-write-then-
// execute regardless of which subserver name it's pointed at. This is
// worse than any single language server above and gets the same gate even
// though "subservers" isn't itself one of the dangerous subserver modules.
//
// Scope / known gap: this only gates Express HTTP routes (app.get/
// app.post/etc, which life_star's Subserver.start() records and unshifts
// to the front of app.routes[method]). CommandLineServer.js's
// runShellCommand/stopShellCommand/writeToShellCommand and PtyServer.js's
// startPtyCommand/ptyInput/ptyResize/stopPtyCommand are ALSO registered
// onto `require("./LivelyServices").services` and invoked over the
// separate L2L/WebSocket message channel, not through these HTTP routes --
// this gate does NOT cover that path. Whether L2L connections carry their
// own authentication has not yet been audited; treat that as a separate,
// still-open follow-up, not something this gate silently claims to fix.

var DANGEROUS_SUBSERVERS = {
  PythonSubserver: true,
  HaskellServer: true,
  ClojureServer: true,
  RServer: true,
  CommandLineServer: true,
  PtyServer: true,
  NodeJSEvalServer: true,
  SQLiteServer: true
};

// Populated from LK_ADMIN_DIDS (comma-separated DIDs) -- same env var and
// same empty-by-default ("deny everyone until a maintainer is explicitly
// named") posture as webdav-auth-gate.js, intentionally sharing one
// allowlist rather than growing a second, separately-configured one.
var ADMIN_DIDS = (process.env.LK_ADMIN_DIDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

function normalizedPath(url) {
  return String(url || '').split('?')[0];
}

// path is expected to already start with "/nodejs/" (checked by the caller)
function isGatedPath(path) {
  var rest = path.slice('/nodejs/'.length);
  var firstSegment = rest.split('/')[0];
  if (firstSegment === 'subservers') return true;
  return DANGEROUS_SUBSERVERS[firstSegment] === true;
}

function getSessionDid(req) {
  return (req.session && req.session['identity-did']) || null;
}

function deny(res, status, message) {
  res.status(status);
  res.end(message);
}

// Registered as a life_star "additional subserver" -- see bin/lk-server.js,
// which appends this module to its `subservers` map AFTER every real
// subserver (both the fs-discovered ones and any `--subserver` CLI-added
// ones) so it is always the LAST one `start()`ed. life_star's
// Subserver.prototype.start unshifts each subserver's newly-registered
// routes to the FRONT of app.routes[method] as it loads (see
// node_modules/life_star/lib/subservers.js), so whichever subserver loads
// last ends up matched first -- the same route-ordering mechanism
// IdentityServer.js's own `/@:handle/*` security catch-all already relies
// on (see this repo's CLAUDE.md "Server routes" section for the documented
// gotcha). Deliberately NOT relying on filesystem/alphabetical load order
// the way that catch-all originally had to -- bin/lk-server.js appends this
// entry explicitly, after both subserver-collecting loops, so it's
// guaranteed last regardless of directory listing order.
//
// `app.all('/nodejs/*', ...)` mirrors IdentityServer.js's own confirmed-
// working `app.all("/@:handle/*", ...)` catch-all pattern (a string
// wildcard route, not a JS RegExp -- app.get/app.post are the routes this
// codebase has separately confirmed work with a RegExp path, per CLAUDE.md;
// this sticks to the pattern already proven for app.all specifically).
// Calling next() for anything not in the gated set falls through to
// whatever the real subserver route does; calling deny() ends the response
// directly without ever reaching it.
module.exports = function (route, app) {
  app.all('/nodejs/*', function (req, res, next) {
    var path = normalizedPath(req.url);
    if (!isGatedPath(path)) { next(); return; }

    var did = getSessionDid(req);
    if (!did || ADMIN_DIDS.indexOf(did) === -1) {
      deny(res, did ? 403 : 401,
        did
          ? 'Forbidden: this subserver is restricted to core maintainers.'
          : 'Authentication required.');
      return;
    }
    next();
  });
};

module.exports.DANGEROUS_SUBSERVERS = DANGEROUS_SUBSERVERS;
module.exports.isGatedPath = isGatedPath;
