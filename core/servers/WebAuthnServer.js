/*
 * WebAuthn authentication subserver for LivelyKernel.
 *
 * Registered by life_star at route: /nodejs/WebAuthnServer/
 *
 * Routes:
 *   POST /register/begin    — start passkey registration
 *   POST /register/finish   — verify & store credential
 *   POST /login/begin       — start passkey login
 *   POST /login/finish      — verify assertion, set session
 *   GET  /me                — return current session data
 *   POST /logout            — clear session
 *
 * Env vars (all optional):
 *   WEBAUTHN_RP_NAME  — display name shown by the browser (default: 'LivelyKernel')
 *   WEBAUTHN_RP_ID    — effective domain, must match page origin (default: 'localhost')
 *   WEBAUTHN_ORIGIN   — full origin including scheme+port (default: 'http://localhost:9001')
 *   WEBAUTHN_DB       — path to users.sqlite (default: WORKSPACE_LK/users.sqlite)
 *
 * Run the migration script first:
 *   node bin/migrate-webauthn-db.js
 */

var path    = require('path');
var crypto  = require('crypto');
var sqlite3 = require('sqlite3').verbose();

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Config
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

var rpName = process.env.WEBAUTHN_RP_NAME || 'LivelyKernel';
var rpID   = process.env.WEBAUTHN_RP_ID   || 'localhost';
var origin = process.env.WEBAUTHN_ORIGIN  || 'http://localhost:9001';

var CHALLENGE_TTL_MS = 5 * 60 * 1000;  // 5 minutes
var COOKIE_FIELD     = 'lvUserData_2013-10-12';  // mirrors SessionTracker.js

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// DB (lazy init — opened on first request, not at require() time)
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

var db;

function getDB() {
  if (!db) {
    var dbPath = process.env.WEBAUTHN_DB
      || path.join(process.env.WORKSPACE_LK || process.cwd(), 'users.sqlite');
    db = new sqlite3.Database(dbPath, function(err) {
      if (err) {
        console.error('[WebAuthnServer] Cannot open users.sqlite at', dbPath);
        console.error('[WebAuthnServer] Run: node bin/migrate-webauthn-db.js');
        console.error(err.message);
      }
    });
  }
  return db;
}

function dbRun(sql, params, cb) {
  if (typeof params === 'function') { cb = params; params = []; }
  getDB().run(sql, params, function(err) { cb(err, this); });
}

function dbGet(sql, params, cb) {
  if (typeof params === 'function') { cb = params; params = []; }
  getDB().get(sql, params, cb);
}

function dbAll(sql, params, cb) {
  if (typeof params === 'function') { cb = params; params = []; }
  getDB().all(sql, params, cb);
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Session helpers — mirrors SessionTracker.js exactly
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function getLivelySessionData(req) {
  return req.session ? req.session[COOKIE_FIELD] || (req.session[COOKIE_FIELD] = {}) : {};
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Schema initialization
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function initializeSchema(cb) {
  var ddl = [
    'CREATE TABLE IF NOT EXISTS users (' +
      'id TEXT PRIMARY KEY, ' +
      'username TEXT UNIQUE NOT NULL, ' +
      'display_name TEXT, ' +
      'created_at TEXT DEFAULT (datetime(\'now\'))' +
    ')',
    'CREATE TABLE IF NOT EXISTS webauthn_credentials (' +
      'id TEXT PRIMARY KEY, ' +
      'user_id TEXT NOT NULL REFERENCES users(id), ' +
      'credential_id TEXT UNIQUE NOT NULL, ' +
      'public_key TEXT NOT NULL, ' +
      'counter INTEGER NOT NULL DEFAULT 0, ' +
      'transports TEXT DEFAULT \'[]\', ' +
      'device_type TEXT, ' +
      'backed_up INTEGER DEFAULT 0, ' +
      'created_at TEXT DEFAULT (datetime(\'now\')), ' +
      'last_used_at TEXT' +
    ')',
    'CREATE TABLE IF NOT EXISTS webauthn_challenges (' +
      'id TEXT PRIMARY KEY, ' +
      'challenge TEXT NOT NULL, ' +
      'username TEXT, ' +
      'type TEXT NOT NULL, ' +
      'expires_at INTEGER NOT NULL' +
    ')'
  ];

  var db = getDB();
  var i = 0;
  function next(err) {
    if (err) { console.error('[WebAuthnServer] schema init error:', err); if (cb) cb(err); return; }
    if (i >= ddl.length) { if (cb) cb(null); return; }
    db.run(ddl[i++], next);
  }
  next(null);
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Challenge helpers
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function storeChallenge(challenge, username, type, cb) {
  var id = crypto.randomUUID();
  var expiresAt = Date.now() + CHALLENGE_TTL_MS;
  dbRun(
    'INSERT INTO webauthn_challenges (id, challenge, username, type, expires_at) VALUES (?, ?, ?, ?, ?)',
    [id, challenge, username || null, type, expiresAt],
    function(err) { cb(err, id); }
  );
}

function consumeChallenge(challengeId, cb) {
  dbGet('SELECT * FROM webauthn_challenges WHERE id = ?', [challengeId], function(err, row) {
    if (err) return cb(err);
    if (!row) return cb(new Error('Challenge not found or already used'));
    if (Date.now() > row.expires_at) return cb(new Error('Challenge expired'));
    // Delete immediately — one-time use
    dbRun('DELETE FROM webauthn_challenges WHERE id = ?', [challengeId], function(delErr) {
      cb(delErr, row);
    });
  });
}

function cleanupExpiredChallenges() {
  dbRun('DELETE FROM webauthn_challenges WHERE expires_at < ?', [Date.now()], function(err) {
    if (err) console.error('[WebAuthnServer] challenge cleanup error:', err);
  });
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// User helpers
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

function findOrCreateUser(username, displayName, cb) {
  dbGet('SELECT * FROM users WHERE username = ?', [username], function(err, user) {
    if (err) return cb(err);
    if (user) return cb(null, user);
    var id = crypto.randomUUID();
    dbRun(
      'INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)',
      [id, username, displayName || username],
      function(err2) {
        if (err2) return cb(err2);
        dbGet('SELECT * FROM users WHERE id = ?', [id], cb);
      }
    );
  });
}

// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-
// Subserver export
// -=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-

module.exports = function(route, app) {

  // Ensure schema exists, then start periodic cleanup
  initializeSchema(function(err) {
    if (!err) console.log('[WebAuthnServer] schema ready');
    cleanupExpiredChallenges();
    setInterval(cleanupExpiredChallenges, 10 * 60 * 1000);
  });

  // Lazy-load @simplewebauthn/server so a missing install gives a clear error
  // at request time rather than crashing the whole server at startup.
  var webauthn;
  function getWebAuthn() {
    if (!webauthn) {
      try {
        webauthn = require('@simplewebauthn/server');
      } catch (e) {
        throw new Error('[WebAuthnServer] @simplewebauthn/server not installed. Run: npm install');
      }
    }
    return webauthn;
  }

  // -=- POST /register/begin -=-
  // Body: { username: STRING, displayName?: STRING }
  // Returns: PublicKeyCredentialCreationOptionsJSON
  app.post(route + 'register/begin', function(req, res) {
    var username    = req.body && req.body.username;
    var displayName = (req.body && req.body.displayName) || username;

    if (!username) return res.status(400).json({ error: 'username required' });

    var wa;
    try { wa = getWebAuthn(); } catch(e) { return res.status(500).json({ error: e.message }); }

    findOrCreateUser(username, displayName, function(err, user) {
      if (err) return res.status(500).json({ error: String(err) });

      // Exclude credentials the user has already registered so they cannot
      // double-register the same device.
      dbAll(
        'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?',
        [user.id],
        function(err2, rows) {
          if (err2) return res.status(500).json({ error: String(err2) });

          var excludeCredentials = (rows || []).map(function(row) {
            return { id: row.credential_id, transports: JSON.parse(row.transports || '[]') };
          });

          wa.generateRegistrationOptions({
            rpName:          rpName,
            rpID:            rpID,
            userID:          Buffer.from(user.id),
            userName:        username,
            userDisplayName: displayName,
            excludeCredentials: excludeCredentials,
            authenticatorSelection: {
              residentKey:        'preferred',
              userVerification:   'preferred'
            }
          }).then(function(options) {
            // @simplewebauthn/server v9 returns user.id as a Buffer; normalize to base64url string
            if (options.user && Buffer.isBuffer(options.user.id)) {
              options = Object.assign({}, options, {
                user: Object.assign({}, options.user, {
                  id: options.user.id.toString('base64')
                      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
                })
              });
            }
            storeChallenge(options.challenge, username, 'registration', function(err3, challengeId) {
              if (err3) return res.status(500).json({ error: String(err3) });
              // Store the challenge lookup ID in the session cookie (not the challenge itself)
              getLivelySessionData(req).webauthnChallengeId = challengeId;
              res.json(options);
            });
          }).catch(function(e) {
            console.error('[WebAuthnServer] register/begin:', e);
            res.status(500).json({ error: String(e) });
          });
        }
      );
    });
  });

  // -=- POST /register/finish -=-
  // Body: RegistrationResponseJSON (from navigator.credentials.create)
  // Returns: { verified: true, username: STRING }
  app.post(route + 'register/finish', function(req, res) {
    var session     = getLivelySessionData(req);
    var challengeId = session.webauthnChallengeId;

    if (!challengeId) return res.status(400).json({ error: 'No pending registration challenge' });

    var wa;
    try { wa = getWebAuthn(); } catch(e) { return res.status(500).json({ error: e.message }); }

    consumeChallenge(challengeId, function(err, challengeRow) {
      if (err) return res.status(400).json({ error: String(err) });
      delete session.webauthnChallengeId;

      wa.verifyRegistrationResponse({
        response:          req.body,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin:    origin,
        expectedRPID:      rpID
      }).then(function(verification) {
        if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

        var info         = verification.registrationInfo;
        // @simplewebauthn/server v9 uses flat fields; v10+ nests them under .credential
        var cred         = info.credential || {};
        var credentialId = cred.id
          || Buffer.from(info.credentialID).toString('base64')
                 .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        var publicKey    = Buffer.from(cred.publicKey || info.credentialPublicKey).toString('base64');
        var counter      = cred.counter != null ? cred.counter : info.counter;
        var transports   = JSON.stringify(cred.transports || []);
        var deviceType   = info.credentialDeviceType || null;
        var backedUp     = info.credentialBackedUp ? 1 : 0;

        dbGet('SELECT id FROM users WHERE username = ?', [challengeRow.username], function(err2, user) {
          if (err2 || !user) return res.status(500).json({ error: 'User not found' });

          dbRun(
            'INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [crypto.randomUUID(), user.id, credentialId, publicKey, counter, transports, deviceType, backedUp],
            function(err3) {
              if (err3) return res.status(500).json({ error: String(err3) });

              // Wire into lively session — identical shape to /login response in SessionTracker.js
              session.username  = challengeRow.username;
              session.lastLogin = new Date().toISOString();

              console.log('[WebAuthnServer] registered & logged in:', challengeRow.username);
              res.json({ verified: true, username: challengeRow.username });
            }
          );
        });
      }).catch(function(e) {
        console.error('[WebAuthnServer] register/finish:', e);
        res.status(400).json({ error: String(e) });
      });
    });
  });

  // -=- POST /login/begin -=-
  // Body: { username?: STRING }  (omit username for passkey/discoverable flow)
  // Returns: PublicKeyCredentialRequestOptionsJSON
  app.post(route + 'login/begin', function(req, res) {
    var username = req.body && req.body.username;

    var wa;
    try { wa = getWebAuthn(); } catch(e) { return res.status(500).json({ error: e.message }); }

    function buildOptions(allowCredentials) {
      wa.generateAuthenticationOptions({
        rpID:             rpID,
        allowCredentials: allowCredentials,
        userVerification: 'preferred'
      }).then(function(options) {
        storeChallenge(options.challenge, username || null, 'authentication', function(err, challengeId) {
          if (err) return res.status(500).json({ error: String(err) });
          getLivelySessionData(req).webauthnChallengeId = challengeId;
          res.json(options);
        });
      }).catch(function(e) {
        console.error('[WebAuthnServer] login/begin:', e);
        res.status(500).json({ error: String(e) });
      });
    }

    if (username) {
      // Username provided — send back only this user's credentials so the
      // browser can pre-select the right authenticator.
      dbGet('SELECT id FROM users WHERE username = ?', [username], function(err, user) {
        if (err)  return res.status(500).json({ error: String(err) });
        if (!user) return res.status(404).json({ error: 'User not found' });

        dbAll(
          'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?',
          [user.id],
          function(err2, rows) {
            if (err2) return res.status(500).json({ error: String(err2) });
            buildOptions((rows || []).map(function(r) {
              return { id: r.credential_id, type: 'public-key', transports: JSON.parse(r.transports || '[]') };
            }));
          }
        );
      });
    } else {
      // Discoverable credential (passkey) flow — browser prompts the user to
      // pick any stored passkey without knowing the username upfront.
      buildOptions([]);
    }
  });

  // -=- POST /login/finish -=-
  // Body: AuthenticationResponseJSON (from navigator.credentials.get)
  // Returns: { verified: true, username, email, group, lastLogin }
  //          — same shape as /login in SessionTracker.js so client code is reusable
  app.post(route + 'login/finish', function(req, res) {
    var session     = getLivelySessionData(req);
    var challengeId = session.webauthnChallengeId;

    if (!challengeId) return res.status(400).json({ error: 'No pending authentication challenge' });

    var credentialId = req.body && req.body.id;
    if (!credentialId) return res.status(400).json({ error: 'Missing credential id' });

    var wa;
    try { wa = getWebAuthn(); } catch(e) { return res.status(500).json({ error: e.message }); }

    consumeChallenge(challengeId, function(err, challengeRow) {
      if (err) return res.status(400).json({ error: String(err) });
      delete session.webauthnChallengeId;

      dbGet(
        'SELECT wc.*, u.username FROM webauthn_credentials wc JOIN users u ON u.id = wc.user_id WHERE wc.credential_id = ?',
        [credentialId],
        function(err2, storedCred) {
          if (err2)        return res.status(500).json({ error: String(err2) });
          if (!storedCred) return res.status(400).json({ error: 'Credential not found' });

          // If a username was specified during login/begin, verify the credential belongs to them.
          if (challengeRow.username && challengeRow.username !== storedCred.username) {
            return res.status(400).json({ error: 'Credential does not belong to this user' });
          }

          // Build the stored-credential descriptor for both v9 and v10+ of @simplewebauthn/server.
          // v9 uses authenticator.credentialID (Uint8Array) + credentialPublicKey;
          // v10+ uses credential.id (string) + publicKey.
          var credIdBuf = Buffer.from(
            storedCred.credential_id.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
          var pubKeyBuf = Buffer.from(storedCred.public_key, 'base64');
          var storedTransports = JSON.parse(storedCred.transports || '[]');

          wa.verifyAuthenticationResponse({
            response:          req.body,
            expectedChallenge: challengeRow.challenge,
            expectedOrigin:    origin,
            expectedRPID:      rpID,
            // v10+ field
            credential: {
              id:         storedCred.credential_id,
              publicKey:  pubKeyBuf,
              counter:    storedCred.counter,
              transports: storedTransports
            },
            // v9 field (ignored by v10+, required by v9)
            authenticator: {
              credentialID:        credIdBuf,
              credentialPublicKey: pubKeyBuf,
              counter:             storedCred.counter,
              transports:          storedTransports
            }
          }).then(function(verification) {
            if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

            var newCounter = verification.authenticationInfo.newCounter;
            var now        = new Date().toISOString();

            dbRun(
              'UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?',
              [newCounter, now, credentialId],
              function(err3) {
                if (err3) console.error('[WebAuthnServer] counter update error:', err3);

                // -=- Wire username into lively session -=-
                // Same fields as the /login POST handler in SessionTracker.js (line 917-920)
                // so the rest of the system (versioned_objects author, users/<name>/ redirect,
                // $world.getUserName()) all pick up the authenticated identity.
                session.username  = storedCred.username;
                session.email     = null;
                session.group     = null;
                session.lastLogin = now;

                console.log('[WebAuthnServer] authenticated:', storedCred.username);
                res.json({
                  verified:  true,
                  username:  storedCred.username,
                  email:     null,
                  group:     null,
                  lastLogin: now
                });
              }
            );
          }).catch(function(e) {
            console.error('[WebAuthnServer] login/finish:', e);
            res.status(400).json({ error: String(e) });
          });
        }
      );
    });
  });

  // -=- GET /me -=-
  // Returns the current lively session data — username, lastLogin, etc.
  app.get(route + 'me', function(req, res) {
    res.json(getLivelySessionData(req));
  });

  // -=- POST /logout -=-
  app.post(route + 'logout', function(req, res) {
    var session  = getLivelySessionData(req);
    var username = session.username;
    // Clear all session fields without destroying the session object itself
    Object.keys(session).forEach(function(k) { delete session[k]; });
    console.log('[WebAuthnServer] logged out:', username || 'unknown');
    res.json({ ok: true });
  });

};
