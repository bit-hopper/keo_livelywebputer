/**
 * DidHome.js
 *
 * Records a member's home instance in their DID document as a standard
 * `service` entry:
 *
 *   { id: "<did>#home", type: "LivelyHomeInstance", serviceEndpoint: "https://tinylil.world" }
 *
 * The DID document is built by the client and stored as-is (see the note on
 * PUT /@:handle/did-document in IdentityServer.js: no signature check on the
 * document), so a host the client sent would only be self-asserted. The
 * server therefore always strips whatever `#home` entry arrives and writes its
 * own, from an origin it derived itself (canonicalOrigin in IdentityServer.js)
 * or from the entry it already stored for that member.
 */

var HOME_TYPE = 'LivelyHomeInstance';

function homeId(did) { return did + '#home'; }

function findHome(doc, did) {
  var services = (doc && Array.isArray(doc.service)) ? doc.service : [];
  for (var i = 0; i < services.length; i++) {
    if (services[i] && services[i].id === homeId(did)) return services[i];
  }
  return null;
}

// The `#home` endpoint of a document (e.g. "https://tinylil.world"), or null.
function homeEndpointOf(doc) {
  if (!doc || typeof doc.id !== 'string') return null;
  var entry = findHome(doc, doc.id);
  return (entry && typeof entry.serviceEndpoint === 'string' && entry.serviceEndpoint) || null;
}

// A copy of `doc` carrying exactly one server-authoritative `#home` entry.
//   origin:    the origin to record when storedDoc has none yet
//   storedDoc: the member's currently stored document, or null (registration).
//              Its `#home` endpoint wins over `origin`: a member's home does
//              not change because a later request arrived on another alias.
function withHomeService(doc, did, origin, storedDoc) {
  var endpoint = (storedDoc && homeEndpointOf(storedDoc)) || origin;
  var others = (Array.isArray(doc.service) ? doc.service : []).filter(function (s) {
    return !(s && s.id === homeId(did));
  });
  var out = {};
  Object.keys(doc).forEach(function (k) { out[k] = doc[k]; });
  out.service = others.concat([{ id: homeId(did), type: HOME_TYPE, serviceEndpoint: endpoint }]);
  return out;
}

module.exports = {
  withHomeService: withHomeService,
  homeEndpointOf: homeEndpointOf,
  hasHome: function (doc) { return !!homeEndpointOf(doc); },
};
