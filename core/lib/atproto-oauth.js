/**
 * AT Protocol OAuth Client
 * 
 * Handles OAuth 2.0 authorization code flow with PKCE
 * Using @atproto/oauth-client-node for official OAuth support
 */

const { NodeOAuthClient } = require('@atproto/oauth-client-node');
const { AtpAgent } = require('@atproto/api');
const { getConfig } = require('./atproto-config');
const { getPDSDiscovery } = require('./atproto-pds-discovery');
const crypto = require('crypto');

class ATProtoOAuthClient {
  constructor() {
    this.config = getConfig();
    this.discovery = getPDSDiscovery();
    this.client = null;
    this.endpoints = null;
  }

  /**
   * Initialize OAuth client (called lazily when needed)
   */
  async initializeClient(pdsUrl) {
    try {
      // Discover OAuth endpoints for the PDS
      const endpoints = await this.discovery.discoverOAuthEndpoints(pdsUrl);
      this.endpoints = endpoints;

      // OAuth client configuration
      this.client = new NodeOAuthClient({
        clientId: this.config.oauth.clientId,
        clientSecret: this.config.oauth.clientSecret,
        redirectUri: this.config.oauth.redirectUri,
        scopes: ['atproto'],
        authorizeUrl: endpoints.authorizationUrl,
        tokenUrl: endpoints.tokenUrl,
      });

      console.log('[ATProtoOAuthClient] OAuth client initialized for PDS:', pdsUrl);
    } catch (error) {
      console.error('[ATProtoOAuthClient] Failed to initialize OAuth client:', error);
      throw error;
    }
  }

  /**
   * Generate authorization URL for user to visit
   */
  async generateAuthorizationUrl(state, redirectUri, pdsUrl) {
    try {
      // Discover PDS if not provided
      if (!pdsUrl) {
        const defaultPds = await this.discovery.discoverPDS('default');
        pdsUrl = defaultPds.url;
      }

      // Initialize client for this PDS
      await this.initializeClient(pdsUrl);

      // Generate PKCE parameters
      const codeVerifier = this.generateCodeVerifier();
      const codeChallenge = await this.generateCodeChallenge(codeVerifier);

      // Build authorization URL
      const authUrl = new URL(this.endpoints.authorizationUrl);
      authUrl.searchParams.set('client_id', this.config.oauth.clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri || this.config.oauth.redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'atproto');
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      authUrl.searchParams.set('state', state);

      return {
        url: authUrl.toString(),
        codeVerifier,
        codeChallenge,
        pdsUrl,
        endpoints: this.endpoints,
      };
    } catch (error) {
      console.error('[ATProtoOAuthClient] Authorization URL generation error:', error);
      throw error;
    }
  }

  /**
   * Exchange authorization code for access token
   */
  async exchangeCodeForToken(code, codeVerifier, redirectUri, pdsUrl) {
    try {
      // Discover PDS if not provided
      if (!pdsUrl) {
        const defaultPds = await this.discovery.discoverPDS('default');
        pdsUrl = defaultPds.url;
      }

      // Initialize client for this PDS
      await this.initializeClient(pdsUrl);

      const tokenUrl = this.endpoints.tokenUrl;

      // Prepare token request
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.oauth.clientId,
        client_secret: this.config.oauth.clientSecret,
        redirect_uri: redirectUri || this.config.oauth.redirectUri,
        code_verifier: codeVerifier,
      });

      // Exchange code for token
      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
      }

      const tokenData = await response.json();

      // Resolve user identity from access token
      const userInfo = await this.resolveUserIdentity(tokenData.access_token, pdsUrl);

      return {
        did: userInfo.did,
        handle: userInfo.handle,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
        tokenType: tokenData.token_type,
        profile: userInfo.profile,
        email: userInfo.email,
        pdsUrl,
      };
    } catch (error) {
      console.error('[ATProtoOAuthClient] Code exchange error:', error);
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshAccessToken(refreshToken, pdsUrl) {
    try {
      // Discover PDS if not provided
      if (!pdsUrl) {
        const defaultPds = await this.discovery.discoverPDS('default');
        pdsUrl = defaultPds.url;
      }

      // Initialize client for this PDS
      await this.initializeClient(pdsUrl);

      const tokenUrl = this.endpoints.tokenUrl;

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.oauth.clientId,
        client_secret: this.config.oauth.clientSecret,
      });

      const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token refresh failed: ${error}`);
      }

      const tokenData = await response.json();

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshToken,
        expiresIn: tokenData.expires_in,
        tokenType: tokenData.token_type,
      };
    } catch (error) {
      console.error('[ATProtoOAuthClient] Token refresh error:', error);
      throw error;
    }
  }

  /**
   * Resolve user identity (DID, handle, profile) from access token
   */
  async resolveUserIdentity(accessToken, pdsUrl) {
    try {
      // Discover PDS if not provided
      if (!pdsUrl) {
        const defaultPds = await this.discovery.discoverPDS('default');
        pdsUrl = defaultPds.url;
      }

      const agent = new AtpAgent({
        service: pdsUrl,
      });

      // Set authorization header
      agent.setHeader('authorization', `Bearer ${accessToken}`);

      // Get user profile information
      const profile = await agent.com.atproto.server.getSession();

      return {
        did: profile.did,
        handle: profile.handle,
        email: profile.email,
        profile: {
          displayName: profile.profile?.displayName,
          description: profile.profile?.description,
          avatar: profile.profile?.avatar,
        },
      };
    } catch (error) {
      console.error('[ATProtoOAuthClient] User identity resolution error:', error);
      throw error;
    }
  }

  /**
   * Validate token with AT Protocol server
   */
  async validateToken(accessToken, pdsUrl) {
    try {
      // Discover PDS if not provided
      if (!pdsUrl) {
        const defaultPds = await this.discovery.discoverPDS('default');
        pdsUrl = defaultPds.url;
      }

      const agent = new AtpAgent({
        service: pdsUrl,
      });

      agent.setHeader('authorization', `Bearer ${accessToken}`);

      const session = await agent.com.atproto.server.getSession();

      return {
        valid: true,
        did: session.did,
        handle: session.handle,
        expiresAt: session.expiresAt,
        pdsUrl,
      };
    } catch (error) {
      console.error('[ATProtoOAuthClient] Token validation error:', error);
      return {
        valid: false,
        error: error.message,
      };
    }
  }

  /**
   * Generate PKCE code verifier
   */
  generateCodeVerifier() {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Generate PKCE code challenge from verifier
   */
  async generateCodeChallenge(codeVerifier) {
    const hash = crypto.createHash('sha256').update(codeVerifier).digest();
    return hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /**
   * Generate state token for CSRF protection
   */
  generateStateToken() {
    return crypto.randomBytes(32).toString('hex');
  }
}

// Singleton instance
let oauthClient = null;

function getOAuthClient() {
  if (!oauthClient) {
    oauthClient = new ATProtoOAuthClient();
  }
  return oauthClient;
}

module.exports = {
  ATProtoOAuthClient,
  getOAuthClient,
};
