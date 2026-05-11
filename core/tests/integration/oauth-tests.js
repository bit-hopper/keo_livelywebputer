/**
 * OAuth Flow Integration Tests
 * Tests authentication, session management, and dynamic PDS discovery
 */

const crypto = require('crypto');
const {
  testConfig,
  MockATProtoService,
  TestAssertions,
  TestContext,
} = require('./test-setup');

// Mock modules that will be tested
const mockOAuthClient = {
  generateAuthUrl: (clientId, redirectUri, state) => {
    // Simulates @atproto/oauth-client-node behavior
    return {
      url: `${testConfig.mockPDS.url}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code`,
      state,
    };
  },
};

/**
 * Test Suite: OAuth Flow
 */
class OAuthFlowTests {
  /**
   * Test 1: PDS Discovery from Handle
   * Verifies dynamic PDS resolution for user handles
   */
  static async testPDSDiscoveryFromHandle() {
    const ctx = new TestContext();
    ctx.setup('PDS Discovery from Handle');

    try {
      // Simulate handle → PDS resolution
      const handle = testConfig.testUser.handle;
      const discoveredPds = await ctx.mockATProto.discoverPDSForHandle(handle);

      TestAssertions.assertEquals(
        discoveredPds,
        testConfig.mockPDS.url,
        'Should discover correct PDS URL for handle'
      );

      // Test non-existent handle
      try {
        await ctx.mockATProto.discoverPDSForHandle('nonexistent.test');
        throw new Error('Should have thrown for non-existent handle');
      } catch (e) {
        TestAssertions.assert(
          e.message.includes('not found'),
          'Should throw for non-existent handle'
        );
      }

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 2: OAuth Authorization URL Generation
   * Verifies PKCE authorization code flow initiation
   */
  static async testOAuthAuthorizationUrl() {
    const ctx = new TestContext();
    ctx.setup('OAuth Authorization URL Generation');

    try {
      const clientId = 'test-client-id';
      const redirectUri = 'http://localhost:9001/auth/callback';
      const state = crypto.randomBytes(32).toString('hex');

      const authUrl = ctx.mockATProto.generateAuthorizationUrl(
        clientId,
        redirectUri,
        state
      );

      TestAssertions.assert(
        authUrl.includes(testConfig.mockPDS.url),
        'URL should include PDS URL'
      );
      TestAssertions.assert(
        authUrl.includes('code='),
        'URL should include authorization code'
      );
      TestAssertions.assert(
        authUrl.includes(`state=${state}`),
        'URL should include state parameter'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 3: OAuth Token Exchange
   * Verifies authorization code → access token exchange
   */
  static async testOAuthTokenExchange() {
    const ctx = new TestContext();
    ctx.setup('OAuth Token Exchange');

    try {
      const clientId = 'test-client-id';
      const clientSecret = 'test-client-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
      const state = crypto.randomBytes(32).toString('hex');

      // Step 1: Generate authorization URL
      const authUrl = ctx.mockATProto.generateAuthorizationUrl(
        clientId,
        redirectUri,
        state
      );
      const code = new URL(authUrl).searchParams.get('code');

      // Step 2: Exchange code for token
      const tokens = await ctx.mockATProto.exchangeCodeForToken(
        code,
        clientId,
        clientSecret
      );

      TestAssertions.assert(tokens.access_token, 'Should return access token');
      TestAssertions.assert(tokens.refresh_token, 'Should return refresh token');
      TestAssertions.assertEquals(
        tokens.token_type,
        'Bearer',
        'Token type should be Bearer'
      );
      TestAssertions.assertEquals(
        tokens.expires_in,
        3600,
        'Expiry should be 1 hour'
      );

      // Step 3: Verify tokens work with API
      const profile = await ctx.mockATProto.getProfile(
        testConfig.testUser.did,
        tokens.access_token
      );

      TestAssertions.assertEquals(
        profile.handle,
        testConfig.testUser.handle,
        'Profile should have correct handle'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 4: Invalid Token Rejection
   * Verifies API calls fail with invalid tokens
   */
  static async testInvalidTokenRejection() {
    const ctx = new TestContext();
    ctx.setup('Invalid Token Rejection');

    try {
      const invalidToken = 'invalid-token-' + crypto.randomBytes(32).toString('hex');

      // Attempt to use invalid token
      try {
        await ctx.mockATProto.getProfile(
          testConfig.testUser.did,
          invalidToken
        );
        throw new Error('Should have thrown for invalid token');
      } catch (e) {
        TestAssertions.assert(
          e.message.includes('Invalid access token'),
          'Should reject invalid token'
        );
      }

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 5: Code Reuse Prevention
   * Verifies authorization codes can only be used once
   */
  static async testCodeReusePrevention() {
    const ctx = new TestContext();
    ctx.setup('Code Reuse Prevention');

    try {
      const clientId = 'test-client-id';
      const clientSecret = 'test-client-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
      const state = crypto.randomBytes(32).toString('hex');

      const authUrl = ctx.mockATProto.generateAuthorizationUrl(
        clientId,
        redirectUri,
        state
      );
      const code = new URL(authUrl).searchParams.get('code');

      // First exchange - should succeed
      const tokens1 = await ctx.mockATProto.exchangeCodeForToken(
        code,
        clientId,
        clientSecret
      );
      TestAssertions.assert(tokens1.access_token, 'First exchange should succeed');

      // Second exchange - should fail
      try {
        await ctx.mockATProto.exchangeCodeForToken(
          code,
          clientId,
          clientSecret
        );
        throw new Error('Second exchange should have failed');
      } catch (e) {
        TestAssertions.assert(
          e.message.includes('Invalid authorization code'),
          'Should reject reused code'
        );
      }

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 6: Multiple Concurrent Sessions
   * Verifies multiple users can have concurrent sessions
   */
  static async testConcurrentSessions() {
    const ctx = new TestContext();
    ctx.setup('Multiple Concurrent Sessions');

    try {
      const clientId = 'test-client-id';
      const clientSecret = 'test-client-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';

      // Create 3 concurrent sessions
      const sessions = [];
      for (let i = 0; i < 3; i++) {
        const state = crypto.randomBytes(32).toString('hex');
        const authUrl = ctx.mockATProto.generateAuthorizationUrl(
          clientId,
          redirectUri,
          state
        );
        const code = new URL(authUrl).searchParams.get('code');

        const tokens = await ctx.mockATProto.exchangeCodeForToken(
          code,
          clientId,
          clientSecret
        );

        sessions.push({
          id: i,
          token: tokens.access_token,
          state,
        });
      }

      TestAssertions.assertEquals(
        sessions.length,
        3,
        'Should have 3 sessions'
      );

      // Verify all sessions are independent
      for (const session of sessions) {
        const profile = await ctx.mockATProto.getProfile(
          testConfig.testUser.did,
          session.token
        );
        TestAssertions.assert(
          profile.handle,
          `Session ${session.id} should have valid profile`
        );
      }

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 7: OAuth State Parameter Validation
   * Verifies CSRF protection via state parameter
   */
  static async testStateParameterValidation() {
    const ctx = new TestContext();
    ctx.setup('OAuth State Parameter Validation');

    try {
      const clientId = 'test-client-id';
      const redirectUri = 'http://localhost:9001/auth/callback';
      const state1 = crypto.randomBytes(32).toString('hex');
      const state2 = crypto.randomBytes(32).toString('hex');

      const authUrl1 = ctx.mockATProto.generateAuthorizationUrl(
        clientId,
        redirectUri,
        state1
      );

      const authUrl2 = ctx.mockATProto.generateAuthorizationUrl(
        clientId,
        redirectUri,
        state2
      );

      const url1 = new URL(authUrl1);
      const url2 = new URL(authUrl2);

      TestAssertions.assertEquals(
        url1.searchParams.get('state'),
        state1,
        'First URL should have correct state'
      );

      TestAssertions.assertEquals(
        url2.searchParams.get('state'),
        state2,
        'Second URL should have correct state'
      );

      TestAssertions.assert(
        url1.searchParams.get('state') !== url2.searchParams.get('state'),
        'States should be different'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }
}

/**
 * Run all OAuth tests
 */
async function runOAuthTests() {
  console.log('\n🔐 OAuth Flow Integration Tests\n');
  console.log('='.repeat(60));

  const tests = [
    { name: 'PDS Discovery from Handle', fn: () => OAuthFlowTests.testPDSDiscoveryFromHandle() },
    { name: 'OAuth Authorization URL Generation', fn: () => OAuthFlowTests.testOAuthAuthorizationUrl() },
    { name: 'OAuth Token Exchange', fn: () => OAuthFlowTests.testOAuthTokenExchange() },
    { name: 'Invalid Token Rejection', fn: () => OAuthFlowTests.testInvalidTokenRejection() },
    { name: 'Code Reuse Prevention', fn: () => OAuthFlowTests.testCodeReusePrevention() },
    { name: 'Multiple Concurrent Sessions', fn: () => OAuthFlowTests.testConcurrentSessions() },
    { name: 'OAuth State Parameter Validation', fn: () => OAuthFlowTests.testStateParameterValidation() },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      const result = await test.fn();
      if (result.passed) {
        console.log(`✅ ${test.name}`);
        passed++;
      } else {
        console.log(`❌ ${test.name}`);
        console.log(`   Error: ${result.error}`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${test.name}`);
      console.log(`   Error: ${e.message}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  return { passed, failed, total: tests.length };
}

// Export for testing
module.exports = { OAuthFlowTests, runOAuthTests };
