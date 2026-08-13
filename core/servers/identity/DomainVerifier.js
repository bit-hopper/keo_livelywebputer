/**
 * core/servers/identity/DomainVerifier.js
 *
 * Server-side verification of a domain claim, via either of two methods:
 *
 *   - A signed /.well-known/lively-did document (verifyDomainClaimFile) —
 *     the Node-side counterpart to core/lively/identity/WebKey.js's
 *     browser-side _verifyWellKnown, using CryptoVerify.js's synchronous
 *     Node crypto port instead of Web Crypto.
 *   - A DNS TXT record at _lively-did.<domain> (verifyDomainClaimDns) —
 *     no signing ceremony needed; DNS control of the domain is itself the
 *     proof, same idea as ATProto's _atproto TXT handle verification.
 *
 * verifyDomainClaim tries the file method first, falling back to DNS, so
 * either one succeeding is enough. Also runs the periodic recheck job that
 * keeps HandleRegistry's `domains` table status fresh (ProfileCard.js's
 * green tick / yellow "?" badge), since a domain's hosted file or DNS
 * record can disappear or change at any time without this server being told.
 */

'use strict';

var https        = require('https');
var dns          = require('dns');
var handleRegistry = require('./HandleRegistry');
var cryptoVerify  = require('./CryptoVerify');

var FETCH_TIMEOUT_MS = 5000;
var MAX_RESPONSE_BYTES = 64 * 1024;
var RECHECK_DELAY_MS = 250; // between domains, so recheckAllDomains doesn't burst-hit many hosts at once
var DNS_TXT_HOST_PREFIX = '_lively-did.';

// Fetch and JSON-parse https://<domain>/.well-known/lively-did.
// Calls thenDo(err, doc).
function fetchWellKnown(domain, thenDo) {
  var called = false;
  function done(err, doc) {
    if (called) return;
    called = true;
    thenDo(err || null, doc);
  }

  var req = https.get(
    { hostname: domain, path: '/.well-known/lively-did', timeout: FETCH_TIMEOUT_MS },
    function (res) {
      if (res.statusCode !== 200) {
        res.resume();
        return done(new Error('HTTP ' + res.statusCode + ' fetching /.well-known/lively-did from ' + domain));
      }
      var chunks = [];
      var size = 0;
      res.on('data', function (chunk) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy();
          return done(new Error('Response from ' + domain + ' exceeded ' + MAX_RESPONSE_BYTES + ' bytes'));
        }
        chunks.push(chunk);
      });
      res.on('end', function () {
        try {
          done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          done(new Error('Malformed JSON from ' + domain + '/.well-known/lively-did: ' + e.message));
        }
      });
      res.on('error', function (err) { done(err); });
    }
  );
  req.on('timeout', function () { req.destroy(new Error('Timed out fetching /.well-known/lively-did from ' + domain)); });
  req.on('error', function (err) { done(err); });
}

// Verify that `domain` currently hosts a validly-signed /.well-known/lively-did
// document claiming `expectedDid`.
// Calls thenDo(null, { valid: true }) or thenDo(null, { valid: false, reason }).
// Never calls thenDo with an err — a fetch/parse/verify failure is reported
// as { valid: false, reason }, since "the domain doesn't verify" is the
// expected outcome for an unverified or lapsed claim, not a server error.
function verifyDomainClaimFile(domain, expectedDid, thenDo) {
  fetchWellKnown(domain, function (err, doc) {
    if (err) return thenDo(null, { valid: false, reason: err.message });
    if (!doc || !doc.did || !doc.sig) {
      return thenDo(null, { valid: false, reason: 'Document missing did/sig fields' });
    }
    if (doc.did !== expectedDid) {
      return thenDo(null, { valid: false, reason: 'Document claims a different DID than the requesting account' });
    }
    if (doc.domain !== domain) {
      return thenDo(null, { valid: false, reason: 'Document\'s domain field does not match ' + domain });
    }

    var jwk;
    try {
      jwk = cryptoVerify.jwkFromDid(doc.did);
    } catch (e) {
      return thenDo(null, { valid: false, reason: 'Malformed did:jwk in document' });
    }

    // Mirrors WebKey.js's _verifyWellKnown: the JWS payload is
    // canonicalJson({ did, handle, domain }), so the signature also binds
    // the handle even though this check only requires did/domain to match.
    if (!cryptoVerify.verifyJws(doc.sig, jwk)) {
      return thenDo(null, { valid: false, reason: 'Signature verification failed' });
    }

    thenDo(null, { valid: true });
  });
}

// Verify domain ownership via a DNS TXT record at _lively-did.<domain>
// whose value is exactly "did=<expectedDid>". No signature needed — being
// able to publish that record is itself proof of DNS control over `domain`.
// A single logical TXT value can arrive as multiple character-string
// segments (DNS's 255-byte-per-segment limit), so segments are joined
// before comparing.
// Calls thenDo(null, { valid: true }) or thenDo(null, { valid: false, reason }).
// Never calls thenDo with an err, matching verifyDomainClaimFile's contract.
function verifyDomainClaimDns(domain, expectedDid, thenDo) {
  var host = DNS_TXT_HOST_PREFIX + domain;
  dns.resolveTxt(host, function (err, records) {
    if (err) return thenDo(null, { valid: false, reason: 'No TXT record found at ' + host + ': ' + err.message });
    var expected = 'did=' + expectedDid;
    var matches = (records || []).some(function (segments) {
      return segments.join('') === expected;
    });
    thenDo(null, matches
      ? { valid: true }
      : { valid: false, reason: 'TXT record at ' + host + ' does not equal "' + expected + '"' });
  });
}

// Try the file method first, falling back to DNS — either one succeeding
// is enough. This is what routes and the recheck job call; the two
// individual methods above are exported separately in case a caller wants
// to distinguish which one passed.
// Calls thenDo(null, { valid, reason? }); never calls thenDo with an err.
function verifyDomainClaim(domain, expectedDid, thenDo) {
  verifyDomainClaimFile(domain, expectedDid, function (err, fileResult) {
    if (fileResult && fileResult.valid) return thenDo(null, fileResult);
    verifyDomainClaimDns(domain, expectedDid, function (err2, dnsResult) {
      if (dnsResult && dnsResult.valid) return thenDo(null, dnsResult);
      thenDo(null, {
        valid: false,
        reason: 'File check: ' + (fileResult && fileResult.reason) + ' — DNS check: ' + (dnsResult && dnsResult.reason),
      });
    });
  });
}

// Recheck every registered domain and update its status in HandleRegistry.
// Serial with a small delay between checks so this doesn't burst-request
// many different third-party domains at once. Calls thenDo(err) when done;
// thenDo is optional (this is also invoked from a bare setInterval).
function recheckAllDomains(thenDo) {
  thenDo = thenDo || function () {};
  handleRegistry.listAllDomains(function (err, rows) {
    if (err) return thenDo(err);
    (function next(i) {
      if (i >= rows.length) return thenDo(null);
      var row = rows[i];
      verifyDomainClaim(row.domain, row.did, function (err2, result) {
        var newStatus = (!err2 && result && result.valid) ? 'verified' : 'invalid';
        handleRegistry.updateDomainStatus(row.domain, newStatus, function () {
          setTimeout(function () { next(i + 1); }, RECHECK_DELAY_MS);
        });
      });
    })(0);
  });
}

module.exports = {
  fetchWellKnown:        fetchWellKnown,
  verifyDomainClaimFile: verifyDomainClaimFile,
  verifyDomainClaimDns:  verifyDomainClaimDns,
  verifyDomainClaim:     verifyDomainClaim,
  recheckAllDomains:     recheckAllDomains,
};
