/**
 * Integration Test Runner
 * Runs all OAuth + World Sync tests and provides comprehensive reporting
 */

const { runOAuthTests } = require('./oauth-tests');
const { runWorldSyncTests } = require('./world-sync-tests');

/**
 * Main test runner
 */
async function runAllTests() {
  const startTime = Date.now();

  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║       Lively Kernel - Integration Test Suite v1.0         ║');
  console.log('║         OAuth + World Sync End-to-End Testing             ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  console.log('\n📦 Test Scope:');
  console.log('  • OAuth flow with dynamic PDS discovery');
  console.log('  • Session management and token handling');
  console.log('  • World creation and AT Protocol sync');
  console.log('  • Conflict detection and resolution');
  console.log('  • Version history and content integrity');

  // Run test suites
  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests = 0;

  // OAuth Tests
  console.log('\n');
  const oauthResults = await runOAuthTests();
  totalPassed += oauthResults.passed;
  totalFailed += oauthResults.failed;
  totalTests += oauthResults.total;

  // World Sync Tests
  console.log('\n');
  const syncResults = await runWorldSyncTests();
  totalPassed += syncResults.passed;
  totalFailed += syncResults.failed;
  totalTests += syncResults.total;

  // Final Summary
  const totalTime = Date.now() - startTime;
  const percentage = Math.round((totalPassed / totalTests) * 100);

  console.log('\n');
  console.log('═'.repeat(60));
  console.log('📊 FINAL TEST SUMMARY');
  console.log('═'.repeat(60));

  console.log(`
  Total Tests:    ${totalTests}
  Passed:         ${totalPassed} ✅
  Failed:         ${totalFailed} ❌
  Success Rate:   ${percentage}%
  Total Time:     ${totalTime}ms
`);

  if (totalFailed === 0) {
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log('║  🎉 ALL TESTS PASSED! System ready for Phase 4.           ║');
    console.log('╚' + '═'.repeat(58) + '╝');
  } else {
    console.log('╔' + '═'.repeat(58) + '╗');
    console.log(`║  ⚠️  ${totalFailed} test(s) failed. Review errors above.           ║`);
    console.log('╚' + '═'.repeat(58) + '╝');
  }

  console.log('\n📋 Test Breakdown:');
  console.log(`  • OAuth Tests:      ${oauthResults.passed}/${oauthResults.total} passed`);
  console.log(`  • Sync Tests:       ${syncResults.passed}/${syncResults.total} passed`);

  console.log('\n🔍 Tested Components:');
  console.log('  ✓ atproto-config.js - Configuration management');
  console.log('  ✓ atproto-oauth.js - OAuth flow with discovery');
  console.log('  ✓ atproto-pds-discovery.js - Dynamic PDS resolution');
  console.log('  ✓ atproto-session.js - Session management');
  console.log('  ✓ atproto-world-db.js - SQLite storage');
  console.log('  ✓ atproto-world-sync.js - Bidirectional sync');
  console.log('  ✓ WorldAPIServer.js - REST API endpoints');

  console.log('\n📝 Next Steps:');
  if (totalFailed === 0) {
    console.log('  1. Phase 4: Migrate existing worlds to AT Protocol format');
    console.log('  2. Build frontend world management UI');
    console.log('  3. Implement advanced collaborative editing');
    console.log('  4. Add Phase 3b Redis optimization (optional)');
  } else {
    console.log('  1. Review and fix failed tests above');
    console.log('  2. Re-run integration tests');
    console.log('  3. Proceed to Phase 4 when all tests pass');
  }

  console.log('\n📚 Test Documentation:');
  console.log('  • See core/tests/integration/ for test files');
  console.log('  • See core/lib/WORLD_STORAGE.md for architecture');
  console.log('  • See core/lib/PDS_DISCOVERY.md for PDS resolution');

  console.log('\n' + '═'.repeat(60) + '\n');

  return {
    passed: totalPassed,
    failed: totalFailed,
    total: totalTests,
    percentage,
    time: totalTime,
  };
}

// Run if called directly
if (require.main === module) {
  runAllTests()
    .then(results => {
      process.exit(results.failed > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error('\n❌ Test runner error:', err);
      process.exit(1);
    });
}

module.exports = { runAllTests };
