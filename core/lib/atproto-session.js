/**
 * AT Protocol Session Management
 * 
 * Server-side session storage with 180-day expiry
 * Uses SQLite for persistence and JWT for stateless validation
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { getConfig } = require('./atproto-config');

class SessionManager {
  constructor() {
    this.config = getConfig();
    this.db = null;
    this.initializeDatabase();
  }

  /**
   * Initialize SQLite database for sessions
   */
  initializeDatabase() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.config.database.path, (err) => {
        if (err) {
          console.error('[SessionManager] Database error:', err);
          reject(err);
        } else {
          this.createTablesIfNeeded();
          console.log('[SessionManager] Database initialized');
          resolve();
        }
      });
    });
  }

  /**
   * Create necessary tables if they don't exist
   */
  createTablesIfNeeded() {
    const queries = [
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        handle TEXT NOT NULL,
        token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        pds_url TEXT,
        user_data TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_did ON sessions(did)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_handle ON sessions(handle)`,
      `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    ];

    queries.forEach((query) => {
      this.db.run(query, (err) => {
        if (err) console.error('[SessionManager] Schema error:', err);
      });
    });
  }

  /**
   * Create a new session
   */
  async createSession(did, handle, oauthToken, refreshToken, pdsUrl, userData = {}) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.config.session.duration);

    // Create JWT token
    const jwtToken = jwt.sign(
      {
        sessionId,
        did,
        handle,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(expiresAt.getTime() / 1000),
      },
      this.config.session.jwtSecret
    );

    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO sessions 
        (id, did, handle, token, refresh_token, expires_at, pds_url, user_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      this.db.run(
        query,
        [
          sessionId,
          did,
          handle,
          jwtToken,
          refreshToken || null,
          expiresAt.toISOString(),
          pdsUrl,
          JSON.stringify(userData),
        ],
        function (err) {
          if (err) {
            console.error('[SessionManager] Create session error:', err);
            reject(err);
          } else {
            resolve({
              sessionId,
              token: jwtToken,
              expiresAt,
            });
          }
        }
      );
    });
  }

  /**
   * Verify JWT token and session validity
   */
  async verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.config.session.jwtSecret);

      // Check if session still exists in database
      const session = await this.getSession(decoded.sessionId);
      if (!session) {
        throw new Error('Session not found in database');
      }

      // Update last accessed time
      await this.updateLastAccessed(decoded.sessionId);

      return {
        valid: true,
        sessionId: decoded.sessionId,
        did: decoded.did,
        handle: decoded.handle,
        session,
      };
    } catch (err) {
      console.error('[SessionManager] Token verification error:', err);
      return {
        valid: false,
        error: err.message,
      };
    }
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM sessions WHERE id = ? AND expires_at > datetime("now")';

      this.db.get(query, [sessionId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          if (row && row.user_data) {
            row.user_data = JSON.parse(row.user_data);
          }
          resolve(row || null);
        }
      });
    });
  }

  /**
   * Get session by DID
   */
  async getSessionByDID(did) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM sessions WHERE did = ? AND expires_at > datetime("now") LIMIT 1';

      this.db.get(query, [did], (err, row) => {
        if (err) {
          reject(err);
        } else {
          if (row && row.user_data) {
            row.user_data = JSON.parse(row.user_data);
          }
          resolve(row || null);
        }
      });
    });
  }

  /**
   * Update last accessed time for session
   */
  async updateLastAccessed(sessionId) {
    return new Promise((resolve, reject) => {
      const query = 'UPDATE sessions SET last_accessed_at = datetime("now") WHERE id = ?';

      this.db.run(query, [sessionId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Revoke session (logout)
   */
  async revokeSession(sessionId) {
    return new Promise((resolve, reject) => {
      const query = 'DELETE FROM sessions WHERE id = ?';

      this.db.run(query, [sessionId], function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  /**
   * Revoke all sessions for a DID
   */
  async revokeAllSessions(did) {
    return new Promise((resolve, reject) => {
      const query = 'DELETE FROM sessions WHERE did = ?';

      this.db.run(query, [did], function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      });
    });
  }

  /**
   * Refresh access token if needed
   */
  async refreshSession(sessionId) {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const expiresAt = new Date(session.expires_at);
    const now = Date.now();
    const refreshThreshold = this.config.session.refreshThreshold;

    // If session expires soon, issue new token
    if (expiresAt.getTime() - now < refreshThreshold) {
      const newExpiresAt = new Date(now + this.config.session.duration);

      const newJwtToken = jwt.sign(
        {
          sessionId,
          did: session.did,
          handle: session.handle,
          iat: Math.floor(now / 1000),
          exp: Math.floor(newExpiresAt.getTime() / 1000),
        },
        this.config.session.jwtSecret
      );

      return new Promise((resolve, reject) => {
        const query = 'UPDATE sessions SET token = ?, expires_at = ? WHERE id = ?';

        this.db.run(query, [newJwtToken, newExpiresAt.toISOString(), sessionId], (err) => {
          if (err) reject(err);
          else resolve({ token: newJwtToken, expiresAt: newExpiresAt });
        });
      });
    }

    return { token: session.token, expiresAt };
  }

  /**
   * Clean up expired sessions (periodic maintenance)
   */
  async cleanupExpiredSessions() {
    return new Promise((resolve, reject) => {
      const query = 'DELETE FROM sessions WHERE expires_at < datetime("now")';

      this.db.run(query, function (err) {
        if (err) {
          console.error('[SessionManager] Cleanup error:', err);
          reject(err);
        } else {
          console.log(`[SessionManager] Cleaned up ${this.changes} expired sessions`);
          resolve(this.changes);
        }
      });
    });
  }

  /**
   * Close database connection
   */
  close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }
    });
  }
}

// Singleton instance
let sessionManager = null;

function getSessionManager() {
  if (!sessionManager) {
    sessionManager = new SessionManager();
  }
  return sessionManager;
}

module.exports = {
  SessionManager,
  getSessionManager,
};
