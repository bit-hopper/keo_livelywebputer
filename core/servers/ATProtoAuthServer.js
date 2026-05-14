/**
 * AT Protocol Authentication Server
 * 
 * Replaces legacy AuthServer.js with proper AT Protocol integration
 * Handles OAuth flows, handle validation, session management, and user accounts
 */

const express = require('express');
const { AtpAgent } = require('@atproto/api');
const { getConfig } = require('../lib/atproto-config');
const { getSessionManager } = require('../lib/atproto-session');
const { getOAuthClient } = require('../lib/atproto-oauth');
const { getPDSManager } = require('../lib/atproto-pds');
const { getPDSDiscovery } = require('../lib/atproto-pds-discovery');
const crypto = require('crypto');

class ATProtoAuthServer {
  constructor(app) {
    this.app = app;
    this.config = getConfig();
    this.sessionManager = getSessionManager();
    this.oauthClient = getOAuthClient();
    this.pdsManager = getPDSManager();
    this.discovery = getPDSDiscovery();
    this.router = express.Router();
    this.setupRoutes();
  }

  /**
   * Setup all authentication routes
   */
  setupRoutes() {
    // OAuth initiation
    this.router.post('/auth/oauth-authorize', this.handleOAuthAuthorize.bind(this));
    
    // OAuth callback
    this.router.post('/auth/oauth-callback', this.handleOAuthCallback.bind(this));
    
    // Signup with new handle
    this.router.post('/auth/signup', this.handleSignup.bind(this));
    
    // Simple login with handle and password
    this.router.post('/auth/login', this.handleLogin.bind(this));
    
    // Handle availability check
    this.router.get('/auth/handle-available/:handle', this.checkHandleAvailable.bind(this));
    
    // Session verification
    this.router.post('/auth/verify-session', this.handleVerifySession.bind(this));
    
    // Logout
    this.router.post('/auth/logout', this.handleLogout.bind(this));
    
    // Get current user info
    this.router.get('/auth/me', this.handleGetCurrentUser.bind(this));
    
    // Revoke all sessions (password change scenario)
    this.router.post('/auth/revoke-all', this.handleRevokeAll.bind(this));
  }

  /**
   * Middleware to attach routes to Express app
   */
  attachToApp() {
    this.app.use(this.router);
    console.log('[ATProtoAuthServer] Routes attached to Express app');
  }

  /**
   * Handle OAuth authorization initiation
   * Discovers PDS from handle if provided, otherwise uses configured default
   */
  async handleOAuthAuthorize(req, res) {
    try {
      const { redirectUri, handle, pdsUrl } = req.body;

      if (!redirectUri) {
        return res.status(400).json({ error: 'redirectUri required' });
      }

      // Discover PDS endpoint
      let discoveredPdsUrl = pdsUrl;
      if (!discoveredPdsUrl && handle) {
        // Discover PDS from handle (e.g., user.bsky.social)
        try {
          const pdsInfo = await this.discovery.discoverPDS(handle);
          discoveredPdsUrl = pdsInfo.url;
          console.log('[ATProtoAuthServer] Discovered PDS for handle:', { handle, pdsUrl: discoveredPdsUrl });
        } catch (error) {
          console.warn('[ATProtoAuthServer] PDS discovery failed, using default:', error.message);
          discoveredPdsUrl = this.config.pds.url;
        }
      } else if (!discoveredPdsUrl) {
        discoveredPdsUrl = this.config.pds.url;
      }

      // Generate state token for CSRF protection
      const state = this.oauthClient.generateStateToken();

      // Generate authorization URL with PKCE
      const { url, codeVerifier } = await this.oauthClient.generateAuthorizationUrl(
        state,
        redirectUri,
        discoveredPdsUrl
      );

      // TODO: Store state and codeVerifier in Redis or session for verification

      res.json({
        authorizationUrl: url,
        state,
        codeVerifier,
        pdsUrl: discoveredPdsUrl,
      });
    } catch (error) {
      console.error('[ATProtoAuthServer] OAuth authorize error:', error);
      res.status(500).json({ error: 'Authorization initiation failed', details: error.message });
    }
  }

  /**
   * Handle OAuth callback with authorization code
   */
  async handleOAuthCallback(req, res) {
    try {
      const { code, codeVerifier, redirectUri, pdsUrl } = req.body;

      if (!code || !codeVerifier) {
        return res.status(400).json({ error: 'code and codeVerifier required' });
      }

      // Exchange code for tokens (pdsUrl optional - will use default if not provided)
      const tokenResponse = await this.oauthClient.exchangeCodeForToken(
        code,
        codeVerifier,
        redirectUri,
        pdsUrl
      );

      if (!tokenResponse.did || !tokenResponse.handle) {
        throw new Error('Invalid token response: missing DID or handle');
      }

      // Create session
      const sessionData = await this.sessionManager.createSession(
        tokenResponse.did,
        tokenResponse.handle,
        tokenResponse.accessToken,
        tokenResponse.refreshToken,
        tokenResponse.pdsUrl || this.config.pds.url,
        {
          profile: tokenResponse.profile || {},
          email: tokenResponse.email,
        }
      );

      res.json({
        sessionId: sessionData.sessionId,
        token: sessionData.token,
        expiresAt: sessionData.expiresAt,
        user: {
          did: tokenResponse.did,
          handle: tokenResponse.handle,
          displayName: tokenResponse.profile?.displayName,
        },
      });
    } catch (error) {
      console.error('[ATProtoAuthServer] OAuth callback error:', error);
      res.status(500).json({ error: 'OAuth callback failed', details: error.message });
    }
  }

  /**
   * Handle signup with new handle (create PDS account)
   */
  async handleSignup(req, res) {
    try {
      const { handle, password, email, inviteCode } = req.body;

      if (!handle || !password) {
        return res.status(400).json({ error: 'handle and password required' });
      }

      // Validate handle format
      if (!this.isValidHandle(handle)) {
        return res.status(400).json({ error: 'Invalid handle format' });
      }

      // Check handle availability via PDS
      const isAvailable = await this.pdsManager.isHandleAvailable(handle);
      if (!isAvailable) {
        return res.status(409).json({ error: 'Handle already taken' });
      }

      // Create account on PDS
      const account = await this.pdsManager.createAccount(handle, email, password, inviteCode);

      // Create local session
      const sessionData = await this.sessionManager.createSession(
        account.did,
        account.handle,
        null, // No OAuth token for local PDS accounts
        null,
        this.config.pds.url,
        {
          email: account.email,
          createdVia: 'local_signup',
        }
      );

      // Send email verification
      await this.pdsManager.sendEmailVerification(email, handle);

      res.status(201).json({
        sessionId: sessionData.sessionId,
        token: sessionData.token,
        expiresAt: sessionData.expiresAt,
        user: {
          did: account.did,
          handle: account.handle,
          email: account.email,
          emailVerified: false,
        },
      });
    } catch (error) {
      console.error('[ATProtoAuthServer] Signup error:', error);
      res.status(500).json({ error: 'Signup failed', details: error.message });
    }
  }

  /**
   * Handle simple login with handle and password
   * For testing and direct authentication flows
   */
  async handleLogin(req, res) {
    try {
      const { pdsUrl, handle, password } = req.body;

      if (!handle || !password) {
        return res.status(400).json({ error: 'handle and password required' });
      }

      // Use provided PDS URL or default
      const targetPdsUrl = pdsUrl || this.config.pds.url;

      // Create ATP agent for the target PDS
      const agent = new AtpAgent({
        service: targetPdsUrl,
      });

      // Attempt login using createSession endpoint
      try {
        const sessionResponse = await agent.login({
          identifier: handle,
          password: password,
        });

        if (!sessionResponse.data.did || !sessionResponse.data.handle) {
          throw new Error('Invalid session response: missing DID or handle');
        }

        // Create local session record
        const sessionData = await this.sessionManager.createSession(
          sessionResponse.data.did,
          sessionResponse.data.handle,
          sessionResponse.data.accessJwt, // access token
          sessionResponse.data.refreshJwt, // refresh token
          targetPdsUrl,
          {
            profile: sessionResponse.data.profile || {},
            createdVia: 'password_login',
          }
        );

        res.json({
          sessionId: sessionData.sessionId,
          token: sessionData.token,
          expiresAt: sessionData.expiresAt,
          user: {
            did: sessionResponse.data.did,
            handle: sessionResponse.data.handle,
            displayName: sessionResponse.data.profile?.displayName,
          },
        });
      } catch (authError) {
        console.error('[ATProtoAuthServer] ATP login failed:', authError.message);
        
        // Check if it's an invalid credentials error
        if (authError.status === 401 || authError.message.includes('Invalid identifier')) {
          return res.status(401).json({ error: 'Invalid handle or password' });
        }
        
        throw authError;
      }
    } catch (error) {
      console.error('[ATProtoAuthServer] Login error:', error);
      res.status(500).json({ error: 'Login failed', details: error.message });
    }
  }

  /**
   * Check if handle is available
   */
  async checkHandleAvailable(req, res) {
    try {
      const { handle } = req.params;

      if (!this.isValidHandle(handle)) {
        return res.status(400).json({ error: 'Invalid handle format' });
      }

      // Discover PDS for this handle
      let pdsUrl;
      try {
        const pdsInfo = await this.discovery.discoverPDS(handle);
        pdsUrl = pdsInfo.url;
      } catch (error) {
        pdsUrl = this.config.pds.url;
      }

      const isAvailable = await this.pdsManager.isHandleAvailable(handle, pdsUrl);

      res.json({ available: isAvailable, pdsUrl });
    } catch (error) {
      console.error('[ATProtoAuthServer] Handle check error:', error);
      res.status(500).json({ error: 'Handle availability check failed' });
    }
  }

  /**
   * Verify session token
   */
  async handleVerifySession(req, res) {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({ error: 'token required' });
      }

      const verification = await this.sessionManager.verifyToken(token);

      if (!verification.valid) {
        return res.status(401).json({ error: 'Invalid token', details: verification.error });
      }

      res.json({
        valid: true,
        sessionId: verification.sessionId,
        did: verification.did,
        handle: verification.handle,
      });
    } catch (error) {
      console.error('[ATProtoAuthServer] Session verify error:', error);
      res.status(500).json({ error: 'Session verification failed' });
    }
  }

  /**
   * Logout (revoke session)
   */
  async handleLogout(req, res) {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
      }

      await this.sessionManager.revokeSession(sessionId);

      res.json({ success: true });
    } catch (error) {
      console.error('[ATProtoAuthServer] Logout error:', error);
      res.status(500).json({ error: 'Logout failed' });
    }
  }

  /**
   * Get current user info from session
   */
  async handleGetCurrentUser(req, res) {
    try {
      const token = this.extractTokenFromRequest(req);

      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const verification = await this.sessionManager.verifyToken(token);

      if (!verification.valid) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const session = await this.sessionManager.getSession(verification.sessionId);

      res.json({
        did: session.did,
        handle: session.handle,
        userData: session.user_data,
      });
    } catch (error) {
      console.error('[ATProtoAuthServer] Get current user error:', error);
      res.status(500).json({ error: 'Failed to get current user' });
    }
  }

  /**
   * Revoke all sessions for a user (e.g., on password change)
   */
  async handleRevokeAll(req, res) {
    try {
      const token = this.extractTokenFromRequest(req);

      if (!token) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const verification = await this.sessionManager.verifyToken(token);

      if (!verification.valid) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      const revokedCount = await this.sessionManager.revokeAllSessions(verification.did);

      res.json({ success: true, revokedCount });
    } catch (error) {
      console.error('[ATProtoAuthServer] Revoke all error:', error);
      res.status(500).json({ error: 'Failed to revoke sessions' });
    }
  }

  /**
   * Validate handle format
   */
  isValidHandle(handle) {
    // AT Protocol handle validation
    // Handles are 3-253 chars, alphanumeric + hyphens, but not starting/ending with hyphen
    const handleRegex = /^[a-z0-9]([a-z0-9-]{1,251}[a-z0-9])?$/i;
    return handleRegex.test(handle) && handle.length >= 3 && handle.length <= 253;
  }

  /**
   * Check handle availability on PDS
   */
  async checkHandleOnPDS(handle) {
    return this.pdsManager.isHandleAvailable(handle);
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCodeForTokens(code, codeVerifier) {
    return this.oauthClient.exchangeCodeForToken(code, codeVerifier);
  }

  /**
   * Extract Bearer token from request header
   */
  extractTokenFromRequest(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return null;

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

    return parts[1];
  }

  /**
   * Middleware for protecting routes that require authentication
   */
  requireAuth() {
    return async (req, res, next) => {
      try {
        const token = this.extractTokenFromRequest(req);

        if (!token) {
          return res.status(401).json({ error: 'No token provided' });
        }

        const verification = await this.sessionManager.verifyToken(token);

        if (!verification.valid) {
          return res.status(401).json({ error: 'Invalid token' });
        }

        // Attach to request for downstream handlers
        req.user = {
          sessionId: verification.sessionId,
          did: verification.did,
          handle: verification.handle,
        };

        next();
      } catch (error) {
        console.error('[ATProtoAuthServer] Auth middleware error:', error);
        res.status(500).json({ error: 'Authentication failed' });
      }
    };
  }
}

// Singleton instance
let authServer = null;

function getATProtoAuthServer(app) {
  if (!authServer && app) {
    authServer = new ATProtoAuthServer(app);
  }
  return authServer;
}

module.exports = {
  ATProtoAuthServer,
  getATProtoAuthServer,
};
