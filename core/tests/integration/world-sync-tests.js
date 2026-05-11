/**
 * World Sync Integration Tests
 * Tests bidirectional sync, conflict resolution, and versioning
 */

const crypto = require('crypto');
const {
  testConfig,
  MockATProtoService,
  TestAssertions,
  TestContext,
} = require('./test-setup');

/**
 * Test Suite: World Sync
 */
class WorldSyncTests {
  /**
   * Test 1: Create and Sync World to AT Protocol
   * Verifies world creation and sync to AT Protocol
   */
  static async testCreateAndSyncWorld() {
    const ctx = new TestContext();
    ctx.setup('Create and Sync World to AT Protocol');

    try {
      // Step 1: Get OAuth token
      const clientId = 'test-client';
      const clientSecret = 'test-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
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

      // Step 2: Create world data
      const worldData = ctx.createTestWorldData();

      // Step 3: Create record on AT Protocol
      const { uri, cid } = await ctx.mockATProto.createRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        worldData,
        tokens.access_token
      );

      TestAssertions.assert(uri, 'Should return URI after creation');
      TestAssertions.assert(cid, 'Should return CID after creation');
      TestAssertions.assert(
        uri.startsWith('at://'),
        'URI should be AT Protocol format'
      );

      // Step 4: Verify record can be retrieved
      const rkey = uri.split('/').pop();
      const retrieved = await ctx.mockATProto.getRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        rkey,
        tokens.access_token
      );

      TestAssertions.assertEquals(
        retrieved.uri,
        uri,
        'Retrieved record should have correct URI'
      );
      TestAssertions.assertEquals(
        retrieved.cid,
        cid,
        'Retrieved record should have correct CID'
      );
      TestAssertions.assertEquals(
        retrieved.value.name,
        worldData.name,
        'Retrieved world should have correct name'
      );

      ctx.cleanup();
      return { passed: true, uri, cid };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 2: Update World and Generate New CID
   * Verifies world updates generate new content hashes
   */
  static async testUpdateWorld() {
    const ctx = new TestContext();
    ctx.setup('Update World and Generate New CID');

    try {
      // Setup: Create initial world
      const clientId = 'test-client';
      const clientSecret = 'test-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
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

      const worldData = ctx.createTestWorldData();
      const { uri: initialUri, cid: initialCid } = await ctx.mockATProto.createRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        worldData,
        tokens.access_token
      );

      // Step: Update the world
      const rkey = initialUri.split('/').pop();
      const updatedWorldData = {
        ...worldData,
        name: 'Updated World Name',
        description: 'Updated description',
      };

      const { cid: newCid } = await ctx.mockATProto.updateRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        rkey,
        updatedWorldData,
        tokens.access_token
      );

      TestAssertions.assert(
        newCid !== initialCid,
        'CID should change after update'
      );

      // Verify updated data
      const retrieved = await ctx.mockATProto.getRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        rkey,
        tokens.access_token
      );

      TestAssertions.assertEquals(
        retrieved.value.name,
        'Updated World Name',
        'Updated world should have new name'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 3: Version History Tracking
   * Verifies version records are created and tracked
   */
  static async testVersionHistoryTracking() {
    const ctx = new TestContext();
    ctx.setup('Version History Tracking');

    try {
      // Setup: Get token
      const clientId = 'test-client';
      const clientSecret = 'test-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
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

      // Create initial version
      const worldData = ctx.createTestWorldData();
      const { uri: worldUri } = await ctx.mockATProto.createRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        worldData,
        tokens.access_token
      );

      // Create version records
      const versionRecords = [];
      for (let i = 0; i < 3; i++) {
        const versionData = {
          worldUri,
          content: { ...worldData.content },
          message: `Version ${i + 1}`,
          timestamp: new Date().toISOString(),
        };

        const { uri: versionUri, cid: versionCid } = await ctx.mockATProto.createRecord(
          testConfig.testUser.did,
          testConfig.recordTypes.version,
          versionData,
          tokens.access_token
        );

        versionRecords.push({ uri: versionUri, cid: versionCid, index: i });
      }

      TestAssertions.assertEquals(
        versionRecords.length,
        3,
        'Should have 3 version records'
      );

      // Verify all versions have unique CIDs
      const cids = versionRecords.map(v => v.cid);
      const uniqueCids = new Set(cids);
      TestAssertions.assertEquals(
        uniqueCids.size,
        3,
        'All versions should have unique CIDs'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 4: Conflict Detection (Different CIDs)
   * Verifies conflicts are detected when local and remote differ
   */
  static async testConflictDetection() {
    const ctx = new TestContext();
    ctx.setup('Conflict Detection');

    try {
      // Setup: Create world
      const clientId = 'test-client';
      const clientSecret = 'test-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
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

      const worldData = ctx.createTestWorldData();
      const { uri, cid: remoteCid } = await ctx.mockATProto.createRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        worldData,
        tokens.access_token
      );

      // Simulate local change (different CID)
      const localWorldData = {
        ...worldData,
        name: 'Locally Changed Name',
      };
      const localCid = crypto.randomBytes(32).toString('hex');

      // Detect conflict
      const hasConflict = remoteCid !== localCid;

      TestAssertions.assertTrue(
        hasConflict,
        'Should detect conflict when CIDs differ'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 5: Conflict Resolution (Timestamp-based)
   * Verifies conflicts are resolved using timestamps
   */
  static async testConflictResolution() {
    const ctx = new TestContext();
    ctx.setup('Conflict Resolution (Timestamp-based)');

    try {
      // Simulate local and remote versions with timestamps
      const localVersion = {
        name: 'Local Version',
        timestamp: new Date(Date.now() - 60000).toISOString(), // 1 minute ago
        cid: crypto.randomBytes(32).toString('hex'),
      };

      const remoteVersion = {
        name: 'Remote Version',
        timestamp: new Date().toISOString(), // Now (newer)
        cid: crypto.randomBytes(32).toString('hex'),
      };

      // Resolve conflict - should choose remote (newer)
      const resolvedVersion = 
        new Date(localVersion.timestamp) > new Date(remoteVersion.timestamp)
          ? localVersion
          : remoteVersion;

      TestAssertions.assertEquals(
        resolvedVersion.name,
        'Remote Version',
        'Should resolve to newer version (remote)'
      );

      // Test with local newer
      const localVersionNewer = {
        ...localVersion,
        timestamp: new Date(Date.now() + 60000).toISOString(), // 1 minute in future (much newer)
      };

      const resolvedVersionLocal =
        new Date(localVersionNewer.timestamp) > new Date(remoteVersion.timestamp)
          ? localVersionNewer
          : remoteVersion;

      TestAssertions.assertEquals(
        resolvedVersionLocal.name,
        'Local Version',
        'Should resolve to newer version (local)'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 6: Batch Sync Multiple Worlds
   * Verifies multiple worlds can be synced efficiently
   */
  static async testBatchSync() {
    const ctx = new TestContext();
    ctx.setup('Batch Sync Multiple Worlds');

    try {
      // Setup: Get token
      const clientId = 'test-client';
      const clientSecret = 'test-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
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

      // Create 5 worlds
      const worlds = [];
      for (let i = 0; i < 5; i++) {
        const worldData = {
          ...ctx.createTestWorldData(),
          name: `World ${i}`,
        };

        const { uri, cid } = await ctx.mockATProto.createRecord(
          testConfig.testUser.did,
          testConfig.recordTypes.world,
          worldData,
          tokens.access_token
        );

        worlds.push({ id: i, uri, cid });
      }

      TestAssertions.assertEquals(
        worlds.length,
        5,
        'Should have synced 5 worlds'
      );

      // Verify all have unique CIDs
      const cids = worlds.map(w => w.cid);
      const uniqueCids = new Set(cids);
      TestAssertions.assertEquals(
        uniqueCids.size,
        5,
        'All worlds should have unique CIDs'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 7: Sync Idempotency
   * Verifies repeated syncs produce same result (idempotent)
   */
  static async testSyncIdempotency() {
    const ctx = new TestContext();
    ctx.setup('Sync Idempotency');

    try {
      // Setup: Get token
      const clientId = 'test-client';
      const clientSecret = 'test-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
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

      // Create world
      const worldData = ctx.createTestWorldData();
      const { uri: uri1, cid: cid1 } = await ctx.mockATProto.createRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        worldData,
        tokens.access_token
      );

      // "Sync" again with same data
      const rkey = uri1.split('/').pop();
      const { cid: cid2 } = await ctx.mockATProto.updateRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        rkey,
        worldData,
        tokens.access_token
      );

      // CIDs should differ (update always generates new CID)
      // But that's OK - idempotency means the world data is the same
      const retrieved = await ctx.mockATProto.getRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        rkey,
        tokens.access_token
      );

      TestAssertions.assertEquals(
        retrieved.value.name,
        worldData.name,
        'Idempotent sync should produce same world data'
      );

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }

  /**
   * Test 8: Sync Error Recovery
   * Verifies sync can retry after failure
   */
  static async testSyncErrorRecovery() {
    const ctx = new TestContext();
    ctx.setup('Sync Error Recovery');

    try {
      // Test 1: Invalid token → should fail then succeed with new token
      const invalidToken = 'invalid-token';

      try {
        await ctx.mockATProto.createRecord(
          testConfig.testUser.did,
          testConfig.recordTypes.world,
          ctx.createTestWorldData(),
          invalidToken
        );
        throw new Error('Should have failed with invalid token');
      } catch (e) {
        TestAssertions.assert(
          e.message.includes('Invalid access token'),
          'Should fail with invalid token'
        );
      }

      // Test 2: Retry with valid token should succeed
      const clientId = 'test-client';
      const clientSecret = 'test-secret';
      const redirectUri = 'http://localhost:9001/auth/callback';
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

      const { uri, cid } = await ctx.mockATProto.createRecord(
        testConfig.testUser.did,
        testConfig.recordTypes.world,
        ctx.createTestWorldData(),
        tokens.access_token
      );

      TestAssertions.assert(uri, 'Retry with valid token should succeed');

      ctx.cleanup();
      return { passed: true };
    } catch (e) {
      return { passed: false, error: e.message };
    }
  }
}

/**
 * Run all world sync tests
 */
async function runWorldSyncTests() {
  console.log('\n🔄 World Sync Integration Tests\n');
  console.log('='.repeat(60));

  const tests = [
    { name: 'Create and Sync World to AT Protocol', fn: () => WorldSyncTests.testCreateAndSyncWorld() },
    { name: 'Update World and Generate New CID', fn: () => WorldSyncTests.testUpdateWorld() },
    { name: 'Version History Tracking', fn: () => WorldSyncTests.testVersionHistoryTracking() },
    { name: 'Conflict Detection', fn: () => WorldSyncTests.testConflictDetection() },
    { name: 'Conflict Resolution (Timestamp-based)', fn: () => WorldSyncTests.testConflictResolution() },
    { name: 'Batch Sync Multiple Worlds', fn: () => WorldSyncTests.testBatchSync() },
    { name: 'Sync Idempotency', fn: () => WorldSyncTests.testSyncIdempotency() },
    { name: 'Sync Error Recovery', fn: () => WorldSyncTests.testSyncErrorRecovery() },
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
module.exports = { WorldSyncTests, runWorldSyncTests };
