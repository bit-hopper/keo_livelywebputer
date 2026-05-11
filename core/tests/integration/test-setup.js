/**
 * Integration Test Setup
 * Provides test configuration, utilities, and mock services
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Test configuration
const testConfig = {
  // Test ports (avoid conflicts with actual server on 9001)
  testServerPort: 9002,
  
  // Test database (in-memory SQLite for speed)
  testDatabase: ':memory:',
  
  // Mock PDS configuration
  mockPDS: {
    url: 'https://mock.pds.test',
    host: 'mock.pds.test',
  },
  
  // Test credentials
  testUser: {
    did: 'did:plc:test123456789abcdefghijk',
    handle: 'test.test',
    email: 'test@test.test',
    password: 'TestPassword123!',
  },
  
  // Timeouts
  timeouts: {
    oauth: 5000,
    sync: 10000,
    db: 3000,
  },
  
  // AT Protocol record types
  recordTypes: {
    world: 'app.lively.world',
    version: 'app.lively.world.version',
    snapshot: 'app.lively.world.snapshot',
  },
};

/**
 * Mock AT Protocol Response Generator
 */
class MockATProtoService {
  constructor() {
    this.records = new Map();
    this.sessions = new Map();
    this.users = new Map();
    this.pendingOperations = [];
  }

  /**
   * Mock OAuth Authorization Endpoint
   */
  generateAuthorizationUrl(clientId, redirectUri, state) {
    // Simulate authorization code generation
    const code = crypto.randomBytes(32).toString('hex');
    this.pendingOperations.push({
      type: 'auth',
      code,
      state,
      clientId,
      redirectUri,
      createdAt: Date.now(),
    });
    return `${testConfig.mockPDS.url}/oauth/authorize?code=${code}&state=${state}`;
  }

  /**
   * Mock OAuth Token Exchange
   */
  async exchangeCodeForToken(code, clientId, clientSecret) {
    const operation = this.pendingOperations.find(
      op => op.type === 'auth' && op.code === code && op.clientId === clientId
    );

    if (!operation) {
      throw new Error('Invalid authorization code');
    }

    // Remove operation (one-time use)
    this.pendingOperations = this.pendingOperations.filter(op => op !== operation);

    // Generate tokens
    const sessionId = crypto.randomBytes(32).toString('hex');
    const accessToken = crypto.randomBytes(64).toString('hex');
    const refreshToken = crypto.randomBytes(64).toString('hex');

    this.sessions.set(sessionId, {
      accessToken,
      refreshToken,
      user: testConfig.testUser,
      createdAt: Date.now(),
      expiresIn: 3600,
    });

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      scope: 'default',
      token_type: 'Bearer',
    };
  }

  /**
   * Mock User Profile Lookup
   */
  async getProfile(did, accessToken) {
    // Verify token exists
    const session = Array.from(this.sessions.values()).find(
      s => s.accessToken === accessToken
    );
    if (!session) {
      throw new Error('Invalid access token');
    }

    return {
      did,
      handle: testConfig.testUser.handle,
      displayName: 'Test User',
      avatar: null,
      description: 'Test user for integration tests',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Mock Create World Record
   */
  async createRecord(did, collection, record, accessToken) {
    // Verify token
    const session = Array.from(this.sessions.values()).find(
      s => s.accessToken === accessToken
    );
    if (!session) {
      throw new Error('Invalid access token');
    }

    // Generate rkey (record key)
    const rkey = crypto.randomBytes(16).toString('hex').slice(0, 13);
    const uri = `at://${did}/${collection}/${rkey}`;
    const cid = crypto.randomBytes(32).toString('hex');

    // Store record
    const recordKey = `${did}/${collection}/${rkey}`;
    this.records.set(recordKey, {
      uri,
      cid,
      collection,
      record,
      createdAt: new Date().toISOString(),
    });

    return { uri, cid };
  }

  /**
   * Mock Get Record
   */
  async getRecord(did, collection, rkey, accessToken) {
    const recordKey = `${did}/${collection}/${rkey}`;
    const stored = this.records.get(recordKey);

    if (!stored) {
      throw new Error('Record not found');
    }

    return {
      uri: stored.uri,
      cid: stored.cid,
      value: stored.record,
    };
  }

  /**
   * Mock Update Record
   */
  async updateRecord(did, collection, rkey, record, accessToken) {
    const recordKey = `${did}/${collection}/${rkey}`;
    const existing = this.records.get(recordKey);

    if (!existing) {
      throw new Error('Record not found');
    }

    // Generate new CID
    const newCid = crypto.randomBytes(32).toString('hex');

    this.records.set(recordKey, {
      uri: existing.uri,
      cid: newCid,
      collection,
      record,
      updatedAt: new Date().toISOString(),
    });

    return { uri: existing.uri, cid: newCid };
  }

  /**
   * Mock PDS Discovery
   */
  async discoverPDSForHandle(handle) {
    if (handle === testConfig.testUser.handle) {
      return testConfig.mockPDS.url;
    }
    throw new Error('Handle not found');
  }

  /**
   * Mock Well-Known Endpoints
   */
  async getWellKnownEndpoints(pdsUrl) {
    return {
      oauth_authorization_endpoint: `${pdsUrl}/oauth/authorize`,
      oauth_token_endpoint: `${pdsUrl}/oauth/token`,
      revocation_endpoint: `${pdsUrl}/oauth/revoke`,
    };
  }

  /**
   * Clear all state
   */
  reset() {
    this.records.clear();
    this.sessions.clear();
    this.users.clear();
    this.pendingOperations = [];
  }

  /**
   * Get state for debugging
   */
  getState() {
    return {
      recordCount: this.records.size,
      sessionCount: this.sessions.size,
      pendingOps: this.pendingOperations.length,
      records: Array.from(this.records.entries()),
    };
  }
}

/**
 * Test Assertion Helpers
 */
class TestAssertions {
  static assert(condition, message) {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  static assertEquals(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(
        `Assertion failed: ${message}\n  Expected: ${expected}\n  Actual: ${actual}`
      );
    }
  }

  static assertDeepEquals(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Assertion failed: ${message}\n  Expected: ${JSON.stringify(
          expected,
          null,
          2
        )}\n  Actual: ${JSON.stringify(actual, null, 2)}`
      );
    }
  }

  static assertTrue(value, message) {
    if (value !== true) {
      throw new Error(`Assertion failed: ${message} (expected true, got ${value})`);
    }
  }

  static assertFalse(value, message) {
    if (value !== false) {
      throw new Error(`Assertion failed: ${message} (expected false, got ${value})`);
    }
  }

  static assertExists(value, message) {
    if (value === null || value === undefined) {
      throw new Error(`Assertion failed: ${message} (expected to exist)`);
    }
  }

  static assertNull(value, message) {
    if (value !== null && value !== undefined) {
      throw new Error(`Assertion failed: ${message} (expected null/undefined)`);
    }
  }

  static assertThrows(fn, expectedMessage, message) {
    try {
      fn();
      throw new Error(`Assertion failed: ${message} (expected to throw)`);
    } catch (e) {
      if (expectedMessage && !e.message.includes(expectedMessage)) {
        throw new Error(
          `Assertion failed: ${message}\n  Expected message: ${expectedMessage}\n  Actual: ${e.message}`
        );
      }
    }
  }

  static async assertRejects(promise, expectedMessage, message) {
    try {
      await promise;
      throw new Error(`Assertion failed: ${message} (expected to reject)`);
    } catch (e) {
      if (expectedMessage && !e.message.includes(expectedMessage)) {
        throw new Error(
          `Assertion failed: ${message}\n  Expected message: ${expectedMessage}\n  Actual: ${e.message}`
        );
      }
    }
  }
}

/**
 * Test Context - Provides isolated test environment
 */
class TestContext {
  constructor() {
    this.mockATProto = new MockATProtoService();
    this.config = testConfig;
    this.startTime = null;
    this.testName = null;
  }

  /**
   * Setup test with name
   */
  setup(testName) {
    this.testName = testName;
    this.startTime = Date.now();
    this.mockATProto.reset();
    console.log(`\n📋 Setup: ${testName}`);
  }

  /**
   * Cleanup after test
   */
  cleanup() {
    const duration = Date.now() - this.startTime;
    console.log(`✅ Complete: ${this.testName} (${duration}ms)`);
  }

  /**
   * Generate unique world ID for test
   */
  generateWorldId() {
    return `test-world-${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * Generate unique DID for test
   */
  generateTestDid() {
    return `did:plc:${crypto.randomBytes(32).toString('base32').slice(0, 24)}`;
  }

  /**
   * Create test world data
   */
  createTestWorldData() {
    return {
      name: `Test World ${Date.now()}`,
      description: 'A test world for integration testing',
      content: {
        morphs: [
          {
            id: 'morph1',
            type: 'Rectangle',
            position: { x: 100, y: 100 },
            extent: { x: 200, y: 200 },
            color: 'red',
          },
        ],
      },
      metadata: {
        createdAt: new Date().toISOString(),
        version: '1.0',
      },
    };
  }

  /**
   * Wait for async operation with timeout
   */
  async waitFor(condition, timeout = 5000, interval = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await condition()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`Timeout waiting for condition (${timeout}ms)`);
  }

  /**
   * Simulate time delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = {
  testConfig,
  MockATProtoService,
  TestAssertions,
  TestContext,
};
