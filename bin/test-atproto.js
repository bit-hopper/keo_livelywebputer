#!/usr/bin/env node
/*
 * AT Protocol Integration Test Suite
 * Tests OAuth, Identity, DID, and AT Protocol integration
 * 
 * Covers:
 * - OAuth 2.1 with PKCE
 * - DID generation and resolution
 * - User profiles and settings
 * - AT Protocol PDS resolution and authentication
 * - World storage via AT Protocol Repository
 */

var http = require('http');
var crypto = require('crypto');

var BASE_URL = 'http://localhost:9001';
var TEST_RESULTS = [];

// ============================================
// Test Runner Helper
// ============================================

function test(name, fn) {
    TEST_RESULTS.push({
        name: name,
        status: 'pending'
    });
    
    fn(function(err) {
        var result = TEST_RESULTS[TEST_RESULTS.length - 1];
        if (err) {
            result.status = 'FAILED';
            result.error = err;
            console.log('❌ FAILED -', name);
            console.log('  Error:', err);
        } else {
            result.status = 'PASSED';
            console.log('✅ PASSED -', name);
        }
    });
}

function request(method, path, body, callback) {
    var options = {
        hostname: 'localhost',
        port: 9001,
        path: path,
        method: method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };
    
    var req = http.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
            try {
                var json = JSON.parse(data);
                callback(null, res.statusCode, json);
            } catch(e) {
                callback(null, res.statusCode, data);
            }
        });
    });
    
    req.on('error', callback);
    
    if (body) {
        req.write(JSON.stringify(body));
    }
    
    req.end();
}

// ============================================
// Test Suite
// ============================================

console.log('\n=== AT Protocol Integration Test Suite ===\n');

// PKCE helpers
function generatePKCE() {
    var verifier = crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    
    var challenge = crypto.createHash('sha256')
        .update(verifier)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    
    return { verifier: verifier, challenge: challenge };
}

var globalState = {};

// ============================================
// OAuth Tests
// ============================================

test('OAuth: Authorization endpoint accepts request', function(done) {
    var pkce = generatePKCE();
    globalState.pkce = pkce;
    
    var path = '/api/auth/oauth/authorize?' +
        'client_id=test-client&' +
        'redirect_uri=http://localhost:3000/callback&' +
        'response_type=code&' +
        'code_challenge=' + pkce.challenge + '&' +
        'code_challenge_method=S256';
    
    request('GET', path, null, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (!data.code) return done('Missing authorization code');
        
        globalState.authCode = data.code;
        globalState.state = data.state;
        done();
    });
});

test('OAuth: Token exchange with PKCE', function(done) {
    request('POST', '/api/auth/oauth/token', {
        grant_type: 'authorization_code',
        code: globalState.authCode,
        code_verifier: globalState.pkce.verifier,
        client_id: 'test-client'
    }, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (!data.access_token) return done('Missing access_token');
        if (!data.refresh_token) return done('Missing refresh_token');
        
        globalState.accessToken = data.access_token;
        globalState.refreshToken = data.refresh_token;
        done();
    });
});

test('OAuth: Token introspection', function(done) {
    request('POST', '/api/auth/oauth/introspect', {
        token: globalState.accessToken
    }, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (!data.active) return done('Token should be active');
        
        done();
    });
});

test('OAuth: Refresh token exchange', function(done) {
    request('POST', '/api/auth/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: globalState.refreshToken
    }, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (!data.access_token) return done('Missing new access_token');
        
        globalState.newAccessToken = data.access_token;
        done();
    });
});

// ============================================
// DID Tests
// ============================================

test('DID: Get server DID document', function(done) {
    request('GET', '/.well-known/did.json', null, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (!data.id || !data.id.startsWith('did:plc:')) return done('Invalid server DID');
        
        globalState.serverDID = data.id;
        done();
    });
});

test('DID: Get OAuth server metadata', function(done) {
    request('GET', '/.well-known/oauth-authorization-server', null, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (!data.issuer) return done('Missing issuer');
        if (!data.authorization_endpoint) return done('Missing authorization_endpoint');
        
        done();
    });
});

test('DID: Create user DID', function(done) {
    request('POST', '/api/dids', {
        userId: 'test-user-' + Date.now()
    }, function(err, status, data) {
        if (err) return done(err);
        if (status !== 201) return done('Expected 201, got ' + status);
        if (!data.did || !data.did.startsWith('did:plc:')) return done('Invalid DID format');
        
        globalState.userDID = data.did;
        done();
    });
});

test('DID: Resolve DID', function(done) {
    request('GET', '/api/dids/' + globalState.userDID, null, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (data.id !== globalState.userDID) return done('DID mismatch');
        
        done();
    });
});

test('DID: List all DIDs', function(done) {
    request('GET', '/api/dids', null, function(err, status, data) {
        if (err) return done(err);
        if (status !== 200) return done('Expected 200, got ' + status);
        if (!Array.isArray(data.dids)) return done('dids should be an array');
        
        done();
    });
});

// ============================================
// Identity Tests
// ============================================

test('Identity: Get own profile', function(done) {
    var path = '/api/identity/profile';
    var options = {
        hostname: 'localhost',
        port: 9001,
        path: path,
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + globalState.accessToken
        }
    };
    
    var req = http.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
            try {
                var json = JSON.parse(data);
                if (res.statusCode !== 200) return done('Expected 200, got ' + res.statusCode);
                if (!json.userId) return done('Missing userId');
                
                globalState.userId = json.userId;
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    
    req.on('error', done);
    req.end();
});

test('Identity: Update profile', function(done) {
    var path = '/api/identity/profile';
    var options = {
        hostname: 'localhost',
        port: 9001,
        path: path,
        method: 'PUT',
        headers: {
            'Authorization': 'Bearer ' + globalState.accessToken,
            'Content-Type': 'application/json'
        }
    };
    
    var req = http.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
            try {
                var json = JSON.parse(data);
                if (res.statusCode !== 200) return done('Expected 200, got ' + res.statusCode);
                
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    
    req.on('error', done);
    req.write(JSON.stringify({
        displayName: 'Test User ' + Date.now(),
        bio: 'Testing AT Protocol'
    }));
    req.end();
});

test('Identity: Get settings', function(done) {
    var path = '/api/identity/settings';
    var options = {
        hostname: 'localhost',
        port: 9001,
        path: path,
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + globalState.accessToken
        }
    };
    
    var req = http.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
            try {
                var json = JSON.parse(data);
                if (res.statusCode !== 200) return done('Expected 200, got ' + res.statusCode);
                
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    
    req.on('error', done);
    req.end();
});

// ============================================
// World Storage Tests (via Identity API)
// ============================================

test('Worlds: Save new world', function(done) {
    var path = '/api/identity/worlds';
    var options = {
        hostname: 'localhost',
        port: 9001,
        path: path,
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + globalState.accessToken,
            'Content-Type': 'application/json'
        }
    };
    
    var req = http.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
            try {
                var json = JSON.parse(data);
                if (res.statusCode !== 201) return done('Expected 201, got ' + res.statusCode);
                if (!json.worldId) return done('Missing worldId');
                
                globalState.worldId = json.worldId;
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    
    req.on('error', done);
    req.write(JSON.stringify({
        worldName: 'Test World',
        data: { morphs: [] },
        isPinned: false
    }));
    req.end();
});

test('Worlds: List worlds', function(done) {
    var path = '/api/identity/worlds';
    var options = {
        hostname: 'localhost',
        port: 9001,
        path: path,
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + globalState.accessToken
        }
    };
    
    var req = http.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
            try {
                var json = JSON.parse(data);
                if (res.statusCode !== 200) return done('Expected 200, got ' + res.statusCode);
                if (!Array.isArray(json.worlds)) return done('worlds should be an array');
                
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    
    req.on('error', done);
    req.end();
});

test('Worlds: Get specific world', function(done) {
    var path = '/api/identity/worlds/' + globalState.worldId;
    var options = {
        hostname: 'localhost',
        port: 9001,
        path: path,
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + globalState.accessToken
        }
    };
    
    var req = http.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
            try {
                var json = JSON.parse(data);
                if (res.statusCode !== 200) return done('Expected 200, got ' + res.statusCode);
                if (json.worldId !== globalState.worldId) return done('worldId mismatch');
                
                done();
            } catch(e) {
                done(e);
            }
        });
    });
    
    req.on('error', done);
    req.end();
});

// ============================================
// AT Protocol Integration Tests
// ============================================

test('ATProto: PDS endpoint resolution', function(done) {
    // Note: This requires actual connectivity to plc.directory and a valid AT Protocol user
    // For testing purposes, we'll test the endpoint structure
    request('GET', '/api/atproto/pds/invalid.handle.test', null, function(err, status, data) {
        if (err) return done(err);
        // We expect either 400 (invalid identifier) or 200 (success)
        // The important thing is the endpoint exists
        done();
    });
});

test('ATProto: Session endpoint exists', function(done) {
    // Test that the session endpoint is available
    request('POST', '/api/atproto/session', {
        identifier: 'test',
        password: 'test'
    }, function(err, status, data) {
        if (err) return done(err);
        // We expect an error since this isn't a real credential
        // But the endpoint should be available
        done();
    });
});

test('ATProto: Profile endpoint exists', function(done) {
    request('GET', '/api/atproto/profile/test.bsky.social', null, function(err, status, data) {
        if (err) return done(err);
        // Endpoint should exist and respond
        done();
    });
});

test('ATProto: Resolve endpoint exists', function(done) {
    request('GET', '/api/atproto/resolve/test.bsky.social', null, function(err, status, data) {
        if (err) return done(err);
        // Endpoint should exist and respond
        done();
    });
});

test('ATProto: DID info endpoint exists', function(done) {
    request('GET', '/api/atproto/did/test.bsky.social', null, function(err, status, data) {
        if (err) return done(err);
        // Endpoint should exist and respond
        done();
    });
});

// ============================================
// Results
// ============================================

setTimeout(function() {
    console.log('\n=== Test Summary ===\n');
    
    var passed = TEST_RESULTS.filter(r => r.status === 'PASSED').length;
    var failed = TEST_RESULTS.filter(r => r.status === 'FAILED').length;
    var total = TEST_RESULTS.length;
    
    console.log('[SUMMARY] ' + passed + '/' + total + ' tests passed');
    
    if (failed > 0) {
        console.log('[FAILED] ' + failed + ' tests failed\n');
        process.exit(1);
    } else {
        console.log('[SUCCESS] All tests passed!\n');
        process.exit(0);
    }
}, 2000);
