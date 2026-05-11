/**
 * AT Protocol PDS Discovery
 * 
 * Dynamically discover PDS endpoints from DIDs, well-known endpoints, and cached data
 * Supports any AT Protocol-compatible PDS, not just Bluesky
 */

const { getConfig } = require('./atproto-config');
const crypto = require('crypto');

class PDSDiscovery {
  constructor() {
    this.config = getConfig();
    this.cache = new Map();
    this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Discover PDS endpoints for a handle or DID
   * Tries: DID document → well-known endpoint → defaults
   */
  async discoverPDS(identifier) {
    try {
      // Check cache first
      const cached = this.getFromCache(identifier);
      if (cached) {
        console.log('[PDSDiscovery] Using cached PDS for:', identifier);
        return cached;
      }

      let pdsInfo = null;

      // Try DID document lookup
      if (identifier.startsWith('did:')) {
        pdsInfo = await this.resolvePDSFromDID(identifier);
      } else {
        // Handle provided - try to resolve
        pdsInfo = await this.resolvePDSFromHandle(identifier);
      }

      // Try well-known endpoint if DID lookup failed
      if (!pdsInfo && !identifier.startsWith('did:')) {
        pdsInfo = await this.resolvePDSFromWellKnown(identifier);
      }

      // Fall back to default
      if (!pdsInfo) {
        pdsInfo = this.getDefaultPDS();
      }

      // Cache the result
      this.setCache(identifier, pdsInfo);

      console.log('[PDSDiscovery] Discovered PDS:', { identifier, url: pdsInfo.url });
      return pdsInfo;
    } catch (error) {
      console.error('[PDSDiscovery] Discovery error:', error);
      // Fall back to default on error
      return this.getDefaultPDS();
    }
  }

  /**
   * Resolve PDS from DID document
   * Looks for service endpoints in the DID document
   */
  async resolvePDSFromDID(did) {
    try {
      // Parse DID to get method
      const [method, identifier] = did.split(':').slice(1, 3);

      if (method === 'plc') {
        // PLC DIDs resolve via directory
        return await this.resolvePLCDID(identifier);
      } else if (method === 'key') {
        // key DIDs are self-describing
        return await this.resolveKeyDID(did);
      }

      return null;
    } catch (error) {
      console.error('[PDSDiscovery] DID resolution error:', error);
      return null;
    }
  }

  /**
   * Resolve PLC DID from directory
   */
  async resolvePLCDID(identifier) {
    try {
      // Query PLC directory (typically at plc.directory)
      const response = await fetch(`https://plc.directory/${identifier}`);

      if (!response.ok) {
        throw new Error(`PLC lookup failed: ${response.status}`);
      }

      const didDoc = await response.json();

      // Look for service endpoints
      if (didDoc.service && Array.isArray(didDoc.service)) {
        for (const service of didDoc.service) {
          if (service.type === 'AtprotoPersonalDataServer' || service.type === 'AtprotoPersonalDataServerV2') {
            const endpoint = service.serviceEndpoint;
            if (typeof endpoint === 'string') {
              return {
                url: endpoint,
                method: 'plc_did',
                did: `did:plc:${identifier}`,
              };
            }
          }
        }
      }

      return null;
    } catch (error) {
      console.error('[PDSDiscovery] PLC DID error:', error);
      return null;
    }
  }

  /**
   * Resolve key DID (self-describing)
   */
  async resolveKeyDID(did) {
    try {
      // key DIDs don't inherently have service endpoints
      // but we can try to resolve the user from other sources
      console.log('[PDSDiscovery] key DID detected, no service endpoints:', did);
      return null;
    } catch (error) {
      console.error('[PDSDiscovery] Key DID error:', error);
      return null;
    }
  }

  /**
   * Resolve PDS from handle via domain well-known endpoint
   */
  async resolvePDSFromHandle(handle) {
    try {
      // Extract domain from handle (e.g., "user.bsky.social" → "bsky.social")
      const parts = handle.split('.');
      if (parts.length < 2) {
        return null;
      }

      const domain = parts.slice(-2).join('.');

      // Query well-known endpoint
      return await this.queryWellKnownPDS(`https://${domain}`);
    } catch (error) {
      console.error('[PDSDiscovery] Handle resolution error:', error);
      return null;
    }
  }

  /**
   * Resolve PDS from well-known endpoint for a domain
   */
  async resolvePDSFromWellKnown(domain) {
    try {
      // Ensure domain is a proper URL
      let url = domain;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://${domain}`;
      }

      return await this.queryWellKnownPDS(url);
    } catch (error) {
      console.error('[PDSDiscovery] Well-known resolution error:', error);
      return null;
    }
  }

  /**
   * Query /.well-known/atproto-pds endpoint
   */
  async queryWellKnownPDS(baseUrl) {
    try {
      const wellKnownUrl = `${baseUrl}/.well-known/atproto-pds`;

      const response = await fetch(wellKnownUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      if (data.s || data.url) {
        return {
          url: data.s || data.url,
          method: 'well_known',
          source: baseUrl,
        };
      }

      return null;
    } catch (error) {
      console.error('[PDSDiscovery] Well-known query error:', error);
      return null;
    }
  }

  /**
   * Discover OAuth endpoints for a PDS
   */
  async discoverOAuthEndpoints(pdsUrl) {
    try {
      // Check cache
      const cacheKey = `oauth:${pdsUrl}`;
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        return cached;
      }

      // Query well-known endpoint
      const endpoints = await this.queryOAuthWellKnown(pdsUrl);

      if (endpoints) {
        this.setCache(cacheKey, endpoints);
        return endpoints;
      }

      // Fall back to defaults for the domain
      const defaults = this.getDefaultOAuthEndpoints(pdsUrl);
      this.setCache(cacheKey, defaults);
      return defaults;
    } catch (error) {
      console.error('[PDSDiscovery] OAuth endpoint discovery error:', error);
      return this.getDefaultOAuthEndpoints(pdsUrl);
    }
  }

  /**
   * Query OAuth well-known endpoints
   */
  async queryOAuthWellKnown(pdsUrl) {
    try {
      const wellKnownUrl = `${pdsUrl}/.well-known/oauth-authorization-server`;

      const response = await fetch(wellKnownUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      return {
        authorizationUrl: data.authorization_endpoint,
        tokenUrl: data.token_endpoint,
        revokeUrl: data.revocation_endpoint,
        source: 'oauth_well_known',
      };
    } catch (error) {
      console.error('[PDSDiscovery] OAuth well-known error:', error);
      return null;
    }
  }

  /**
   * Get default OAuth endpoints for a PDS domain
   */
  getDefaultOAuthEndpoints(pdsUrl) {
    try {
      const url = new URL(pdsUrl);
      const baseUrl = `${url.protocol}//${url.host}`;

      // Standard OAuth endpoint paths
      return {
        authorizationUrl: `${baseUrl}/oauth/authorize`,
        tokenUrl: `${baseUrl}/oauth/token`,
        revokeUrl: `${baseUrl}/oauth/revoke`,
        source: 'defaults',
      };
    } catch (error) {
      console.error('[PDSDiscovery] Default OAuth endpoints error:', error);
      // Ultimate fallback
      return {
        authorizationUrl: `${pdsUrl}/oauth/authorize`,
        tokenUrl: `${pdsUrl}/oauth/token`,
        revokeUrl: `${pdsUrl}/oauth/revoke`,
        source: 'fallback',
      };
    }
  }

  /**
   * Get default PDS (configured or Bluesky)
   */
  getDefaultPDS() {
    return {
      url: this.config.pds.url || 'https://bsky.social',
      method: 'default',
      isDynamic: false,
    };
  }

  /**
   * Cache discovered endpoint
   */
  setCache(key, value) {
    this.cache.set(key, {
      value,
      expiry: Date.now() + this.cacheExpiry,
    });
  }

  /**
   * Get cached endpoint if not expired
   */
  getFromCache(key) {
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    if (Date.now() > cached.expiry) {
      this.cache.delete(key);
      return null;
    }

    return cached.value;
  }

  /**
   * Clear entire cache
   */
  clearCache() {
    this.cache.clear();
    console.log('[PDSDiscovery] Cache cleared');
  }

  /**
   * Clear specific cache entry
   */
  clearCacheEntry(key) {
    this.cache.delete(key);
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    let validEntries = 0;
    let expiredEntries = 0;

    for (const [key, data] of this.cache.entries()) {
      if (Date.now() > data.expiry) {
        expiredEntries++;
      } else {
        validEntries++;
      }
    }

    return {
      total: this.cache.size,
      valid: validEntries,
      expired: expiredEntries,
    };
  }

  /**
   * Validate PDS URL
   */
  async validatePDS(pdsUrl) {
    try {
      const response = await fetch(`${pdsUrl}/xrpc/_atproto.getServer`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        return {
          valid: true,
          version: data.version,
          description: data.description,
        };
      }

      return { valid: false };
    } catch (error) {
      console.error('[PDSDiscovery] PDS validation error:', error);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Resolve multiple identifiers in parallel
   */
  async discoverMultiple(identifiers) {
    const results = await Promise.allSettled(
      identifiers.map((id) => this.discoverPDS(id))
    );

    return results.map((result, index) => ({
      identifier: identifiers[index],
      pds: result.status === 'fulfilled' ? result.value : null,
      error: result.status === 'rejected' ? result.reason.message : null,
    }));
  }
}

// Singleton instance
let discovery = null;

function getPDSDiscovery() {
  if (!discovery) {
    discovery = new PDSDiscovery();
  }
  return discovery;
}

module.exports = {
  PDSDiscovery,
  getPDSDiscovery,
};
