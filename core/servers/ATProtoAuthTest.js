/**
 * Simple AT Protocol Authentication Endpoint for Testing
 * Handles basic login without requiring full session/config infrastructure
 */

module.exports = function(route, app) {
  
  // Simple login endpoint for testing
  app.post(route + 'auth/login', async function(req, res) {
    try {
      const { pdsUrl, handle, password } = req.body;

      if (!handle || !password) {
        return res.status(400).json({ error: 'handle and password required' });
      }

      let targetPdsUrl = pdsUrl || 'https://bsky.social';
      
      // Ensure URL has protocol
      if (!targetPdsUrl.startsWith('http://') && !targetPdsUrl.startsWith('https://')) {
        targetPdsUrl = 'https://' + targetPdsUrl;
      }

      // Log the attempt
      console.log(`[ATProtoAuthTest] Login attempt - handle: ${handle}, pds: ${targetPdsUrl}`);

      try {
        // Try to use @atproto/api if available
        const { AtpAgent } = require('@atproto/api');
        const agent = new AtpAgent({ service: targetPdsUrl });
        
        const sessionResponse = await agent.login({
          identifier: handle,
          password: password,
        });

        if (!sessionResponse.data.did || !sessionResponse.data.handle) {
          throw new Error('Invalid session response: missing DID or handle');
        }

        // Generate a simple session token (in production, use proper JWT/session storage)
        const sessionToken = Buffer.from(JSON.stringify({
          did: sessionResponse.data.did,
          handle: sessionResponse.data.handle,
          iat: Date.now(),
        })).toString('base64');

        console.log(`[ATProtoAuthTest] Login successful for ${sessionResponse.data.handle}`);

        res.json({
          sessionId: sessionToken,
          token: sessionToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          user: {
            did: sessionResponse.data.did,
            handle: sessionResponse.data.handle,
            displayName: sessionResponse.data.profile?.displayName,
          },
        });
      } catch (error) {
        // If @atproto/api is not available or login fails
        console.error(`[ATProtoAuthTest] ATP login failed: ${error.message}`);
        
        if (error.status === 401 || error.message.includes('Invalid identifier')) {
          return res.status(401).json({ error: 'Invalid handle or password' });
        }
        
        if (!error.message.includes('Cannot find module')) {
          throw error;
        }
        
        // Fallback: mock response for testing without @atproto/api
        console.warn('[ATProtoAuthTest] @atproto/api not available, using mock response');
        const mockDID = `did:key:${handle.replace(/[@.]/g, '_')}`;
        const sessionToken = Buffer.from(JSON.stringify({
          did: mockDID,
          handle: handle,
          iat: Date.now(),
          mock: true,
        })).toString('base64');

        res.json({
          sessionId: sessionToken,
          token: sessionToken,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          user: {
            did: mockDID,
            handle: handle,
            displayName: handle,
          },
          _note: 'Mock response - @atproto/api not available',
        });
      }
    } catch (error) {
      console.error('[ATProtoAuthTest] Login error:', error);
      res.status(500).json({ 
        error: 'Login failed', 
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  });

  // Health check endpoint
  app.get(route + 'auth/status', function(req, res) {
    res.json({ status: 'AT Protocol auth endpoint ready', timestamp: new Date().toISOString() });
  });

  console.log('[ATProtoAuthTest] Auth endpoints registered at', route + 'auth/*');
};
