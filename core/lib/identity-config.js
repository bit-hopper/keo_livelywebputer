/**
 * Identity Service Configuration
 * 
 * Provides configuration for OAuth, Identity, and DID services
 */

const path = require('path');

let config = null;

function getConfig() {
    if (config) return config;
    
    // Initialize configuration
    config = {
        // Database configuration
        identityDb: path.join(__dirname, '../../objects-identity.sqlite'),
        
        // OAuth configuration
        tokenExpiryMs: 60 * 60 * 1000, // 1 hour
        refreshTokenExpiryMs: 30 * 24 * 60 * 60 * 1000, // 30 days
        authCodeExpiryMs: 10 * 60 * 1000, // 10 minutes
        
        // AT Protocol / PDS configuration
        pdsEndpoint: process.env.PDS_ENDPOINT || 'http://localhost:9001',
        livelyDomain: process.env.LIVELY_DOMAIN || 'lively.local',
        
        // Session configuration
        sessionSecret: process.env.SESSION_SECRET || 'lively-kernel-session-secret-dev',
        
        // Security configuration
        corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:9001').split(','),
        
        // Logging
        logLevel: process.env.LOG_LEVEL || 'info',
        
        // API configuration
        apiPort: process.env.API_PORT || 9001,
        apiHost: process.env.API_HOST || 'localhost'
    };
    
    console.log('[identity-config] Configuration loaded:', {
        identityDb: config.identityDb,
        pdsEndpoint: config.pdsEndpoint,
        livelyDomain: config.livelyDomain,
        tokenExpiryMs: config.tokenExpiryMs
    });
    
    return config;
}

module.exports = {
    getConfig,
    updateConfig: function(updates) {
        if (!config) getConfig();
        Object.assign(config, updates);
        return config;
    }
};
