/*global require, module, process*/

// Host-based realms (Encryption.md §18.1/§18.2). PROTOTYPE, OFF BY DEFAULT.
//
// The problem: a world published by someone else runs the author's script in the
// visitor's page. If that page is on the app's own origin, the script can use the
// visitor's session cookie (every cookie-only route in IdentityServer.js) and the
// identity vault. The fix is for other people's public worlds to be served from a
// DIFFERENT HOSTNAME, where the browser sends no session cookie and gives the page
// none of the app origin's storage. life_star's session cookie is host-only (no
// Domain attribute, node_modules/life_star/life_star.js), so a different hostname
// never receives it. This module is the server half: it decides which realm a
// request's Host belongs to, keeps the content realm read-only and free of the
// login surface, and tells IdentityServer.js when to redirect a foreign public world
// to the content hostname.
//
// Configuration (environment, read once at startup). With LK_APP_HOSTS unset the whole
// module is inert and nothing about the server changes:
//
//   LK_APP_HOSTS      comma separated hosts that are the APP realm, e.g.
//                     "dev.tinylil.world,localhost:9001". An entry without a port matches
//                     that hostname on any port; one with a port matches exactly.
//                     "vault.<app host>" is recognised as the VAULT realm automatically.
//                     Every other Host is the CONTENT realm (default deny).
//   LK_WORLDS_ORIGIN  where foreign public worlds are redirected to, e.g.
//                     "https://worlds.tinylil-worlds.net" (no trailing slash). Unset =
//                     no redirect (the content realm can still be reached directly).
//
// Content realm rules: GET/HEAD/OPTIONS only (so no register/authenticate/challenge,
// no mailbox or WebDAV writes), the /nodejs/* subservers are unavailable except the
// anonymous session probe, and the vault pages are not served. Everything else is as
// before: with no cookie, requireAuth routes answer 401 on their own.
//
// Do NOT put the content hostname under identityRpId (a subdomain of the RP ID can run
// the passkey ceremony) and never add it to IDENTITY_VAULT_APP_ORIGINS.
//
// Registered the same way as nodejs-subserver-auth-gate.js: bin/lk-server.js appends it
// LAST so life_star's route unshifting puts it FIRST, ahead of every other route and of
// the static/WebDAV catch-all. (app.use() middleware never runs in this server; see
// CLAUDE.md's "Server routes" section.)

var CONTENT_ALLOWED_METHODS = { GET: true, HEAD: true, OPTIONS: true };

// Paths that stay closed on the content realm even for GET.
var CONTENT_DENIED_PATH_RES = [
  /^\/identity-vault(\/|$)/,
  /^\/wallet-vault(\/|$)/
];
var CONTENT_ALLOWED_NODEJS = { '/nodejs/IdentityServer/session': true };

function parseConfig(env) {
  env = env || {};
  var appHosts = String(env.LK_APP_HOSTS || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
  var worlds = String(env.LK_WORLDS_ORIGIN || '').trim().replace(/\/+$/, '');
  if (worlds && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(worlds)) worlds = '';
  return { appHosts: appHosts, worldsOrigin: worlds || null };
}

function _hostMatches(entry, host) {
  if (entry.indexOf(':') !== -1) return entry === host;
  return entry === host.replace(/:\d+$/, '');
}

function _isAppHost(host, cfg) {
  return cfg.appHosts.some(function (e) { return _hostMatches(e, host); });
}

// 'inert' (feature off), 'app', 'vault' or 'content'.
function realmOf(hostHeader, cfg) {
  if (!cfg.appHosts.length) return 'inert';
  var host = String(hostHeader || '').toLowerCase();
  if (_isAppHost(host, cfg)) return 'app';
  if (/^vault\.[^.]/.test(host) && _isAppHost(host.slice('vault.'.length), cfg)) return 'vault';
  return 'content';
}

// null when the request may proceed on the content realm, else a reason.
function contentDenial(method, path) {
  var m = String(method || '').toUpperCase();
  var p = String(path || '').split('?')[0];
  if (!CONTENT_ALLOWED_METHODS[m]) return 'This host serves published content read-only.';
  if (CONTENT_DENIED_PATH_RES.some(function (re) { return re.test(p); })) return 'Not available on this host.';
  if (/^\/nodejs(\/|$)/.test(p) && !CONTENT_ALLOWED_NODEJS[p.replace(/\/+$/, '')]) return 'Not available on this host.';
  return null;
}

// Should GET /@handle/objId for this world be sent to the content hostname? Only a
// PUBLIC world that belongs to someone else, requested on the app realm. A private or
// shared world needs the viewer's identity to decrypt, so it stays on the app realm; the
// owner's own world keeps today's behaviour.
function shouldRedirectToWorlds(hostHeader, envelope, identity, cfg) {
  if (!cfg.worldsOrigin) return false;
  if (realmOf(hostHeader, cfg) !== 'app') return false;
  if (!envelope || envelope.type !== 'world' || envelope.visibility !== 'public') return false;
  if (identity && identity.did && identity.did === envelope.did) return false;
  return true;
}

function worldsUrl(originalUrl, cfg) {
  return cfg.worldsOrigin + (String(originalUrl || '/').charAt(0) === '/' ? '' : '/') + originalUrl;
}

var config = parseConfig(process.env);

// Registered as a life_star "additional subserver" (see bin/lk-server.js).
module.exports = function (route, app) {
  if (!config.appHosts.length) return; // inert: register nothing
  console.log('[ContentRealm] enabled; app hosts: ' + config.appHosts.join(', ') +
    '; worlds origin: ' + (config.worldsOrigin || '(no redirect)'));
  app.all('/*', function (req, res, next) {
    if (realmOf(req.headers.host, config) !== 'content') { next(); return; }
    var denial = contentDenial(req.method, req.url);
    if (denial) {
      res.status(req.method === 'GET' || req.method === 'HEAD' ? 404 : 405);
      res.end(denial);
      return;
    }
    next();
  });
};

module.exports.config = config;
module.exports.parseConfig = parseConfig;
module.exports.realmOf = realmOf;
module.exports.contentDenial = contentDenial;
module.exports.shouldRedirectToWorlds = function (hostHeader, envelope, identity) {
  return shouldRedirectToWorlds(hostHeader, envelope, identity, config);
};
module.exports.worldsUrl = function (originalUrl) { return worldsUrl(originalUrl, config); };
module.exports._pure = { shouldRedirectToWorlds: shouldRedirectToWorlds, worldsUrl: worldsUrl };
