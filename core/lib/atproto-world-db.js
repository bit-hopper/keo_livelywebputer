/**
 * AT Protocol World Storage Schema & Migrations
 * 
 * SQLite schema for storing world metadata, versions, and permissions
 * World content is synced to AT Protocol as app.lively.world records
 */

const sqlite3 = require('sqlite3').verbose();
const { getConfig } = require('./atproto-config');

class WorldStorageDB {
  constructor() {
    this.config = getConfig();
    this.db = null;
    this.initializeDatabase();
  }

  /**
   * Initialize database connection
   */
  initializeDatabase() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.config.database.path, (err) => {
        if (err) {
          console.error('[WorldStorageDB] Database error:', err);
          reject(err);
        } else {
          this.createTablesIfNeeded();
          console.log('[WorldStorageDB] Database initialized');
          resolve();
        }
      });
    });
  }

  /**
   * Create all necessary tables if they don't exist
   */
  createTablesIfNeeded() {
    const queries = [
      // Worlds table - stores metadata
      `CREATE TABLE IF NOT EXISTS worlds (
        id TEXT PRIMARY KEY,
        owner_did TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        content_hash TEXT,
        atproto_uri TEXT,
        atproto_cid TEXT,
        is_public BOOLEAN DEFAULT 0,
        is_archived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_synced_at DATETIME,
        sync_status TEXT DEFAULT 'pending'
      )`,

      // World versions table - stores snapshots
      `CREATE TABLE IF NOT EXISTS world_versions (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        owner_did TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER,
        message TEXT,
        atproto_uri TEXT,
        atproto_cid TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
      )`,

      // World permissions table - access control
      `CREATE TABLE IF NOT EXISTS world_permissions (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        did TEXT NOT NULL,
        permission_type TEXT NOT NULL,
        granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
        UNIQUE(world_id, did, permission_type)
      )`,

      // World share links table
      `CREATE TABLE IF NOT EXISTS world_share_links (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        owner_did TEXT NOT NULL,
        share_token TEXT NOT NULL UNIQUE,
        link_type TEXT DEFAULT 'view',
        expires_at DATETIME,
        max_uses INTEGER,
        current_uses INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
      )`,

      // World metadata/tags table
      `CREATE TABLE IF NOT EXISTS world_metadata (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE,
        UNIQUE(world_id, key)
      )`,

      // Sync queue table - tracks what needs syncing
      `CREATE TABLE IF NOT EXISTS sync_queue (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(world_id) REFERENCES worlds(id) ON DELETE CASCADE
      )`,

      // Indexes for performance
      `CREATE INDEX IF NOT EXISTS idx_worlds_owner ON worlds(owner_did)`,
      `CREATE INDEX IF NOT EXISTS idx_worlds_public ON worlds(is_public)`,
      `CREATE INDEX IF NOT EXISTS idx_worlds_sync_status ON worlds(sync_status)`,
      `CREATE INDEX IF NOT EXISTS idx_world_versions_world ON world_versions(world_id)`,
      `CREATE INDEX IF NOT EXISTS idx_world_versions_created ON world_versions(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_permissions_did ON world_permissions(did)`,
      `CREATE INDEX IF NOT EXISTS idx_share_links_world ON world_share_links(world_id)`,
      `CREATE INDEX IF NOT EXISTS idx_share_links_token ON world_share_links(share_token)`,
      `CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON sync_queue(status)`,
      `CREATE INDEX IF NOT EXISTS idx_sync_queue_world ON sync_queue(world_id)`,
    ];

    queries.forEach((query) => {
      this.db.run(query, (err) => {
        if (err) {
          console.error('[WorldStorageDB] Schema error:', err);
        }
      });
    });
  }

  /**
   * Create a new world
   */
  async createWorld(worldData) {
    return new Promise((resolve, reject) => {
      const {
        id,
        ownerDid,
        name,
        description,
        contentHash,
        isPublic = false,
      } = worldData;

      const query = `
        INSERT INTO worlds 
        (id, owner_did, name, description, content_hash, is_public, sync_status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `;

      this.db.run(query, [id, ownerDid, name, description, contentHash, isPublic ? 1 : 0], function (err) {
        if (err) {
          console.error('[WorldStorageDB] Create world error:', err);
          reject(err);
        } else {
          resolve({ id, ownerDid, name });
        }
      });
    });
  }

  /**
   * Get world by ID
   */
  async getWorld(worldId) {
    return new Promise((resolve, reject) => {
      const query = 'SELECT * FROM worlds WHERE id = ?';

      this.db.get(query, [worldId], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || null);
        }
      });
    });
  }

  /**
   * List worlds for a user
   */
  async listWorldsByOwner(ownerDid, limit = 100, offset = 0) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM worlds 
        WHERE owner_did = ? 
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `;

      this.db.all(query, [ownerDid, limit, offset], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  /**
   * Update world metadata
   */
  async updateWorld(worldId, updates) {
    return new Promise((resolve, reject) => {
      const { name, description, isPublic } = updates;

      const query = `
        UPDATE worlds 
        SET name = ?, description = ?, is_public = ?, updated_at = datetime('now')
        WHERE id = ?
      `;

      this.db.run(
        query,
        [name, description, isPublic ? 1 : 0, worldId],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(this.changes);
          }
        }
      );
    });
  }

  /**
   * Delete world
   */
  async deleteWorld(worldId) {
    return new Promise((resolve, reject) => {
      const query = 'DELETE FROM worlds WHERE id = ?';

      this.db.run(query, [worldId], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  /**
   * Create world version (snapshot)
   */
  async createWorldVersion(versionData) {
    return new Promise((resolve, reject) => {
      const {
        id,
        worldId,
        ownerDid,
        contentHash,
        sizeBytes,
        message,
      } = versionData;

      const query = `
        INSERT INTO world_versions 
        (id, world_id, owner_did, content_hash, size_bytes, message)
        VALUES (?, ?, ?, ?, ?, ?)
      `;

      this.db.run(
        query,
        [id, worldId, ownerDid, contentHash, sizeBytes, message],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(id);
          }
        }
      );
    });
  }

  /**
   * Get world versions (history)
   */
  async getWorldVersions(worldId, limit = 50) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM world_versions 
        WHERE world_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `;

      this.db.all(query, [worldId, limit], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  /**
   * Grant permission to user
   */
  async grantPermission(worldId, did, permissionType) {
    return new Promise((resolve, reject) => {
      const id = `perm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const query = `
        INSERT OR REPLACE INTO world_permissions 
        (id, world_id, did, permission_type)
        VALUES (?, ?, ?, ?)
      `;

      this.db.run(query, [id, worldId, did, permissionType], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(id);
        }
      });
    });
  }

  /**
   * Check user permission
   */
  async checkPermission(worldId, did, permissionType) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM world_permissions 
        WHERE world_id = ? AND did = ? AND permission_type = ?
      `;

      this.db.get(query, [worldId, did, permissionType], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(!!row);
        }
      });
    });
  }

  /**
   * Create share link
   */
  async createShareLink(shareData) {
    return new Promise((resolve, reject) => {
      const {
        id,
        worldId,
        ownerDid,
        shareToken,
        linkType = 'view',
        expiresAt,
        maxUses,
      } = shareData;

      const query = `
        INSERT INTO world_share_links 
        (id, world_id, owner_did, share_token, link_type, expires_at, max_uses)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;

      this.db.run(
        query,
        [id, worldId, ownerDid, shareToken, linkType, expiresAt, maxUses],
        function (err) {
          if (err) {
            reject(err);
          } else {
            resolve(id);
          }
        }
      );
    });
  }

  /**
   * Verify and use share link
   */
  async useShareLink(shareToken) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM world_share_links 
        WHERE share_token = ? 
        AND (expires_at IS NULL OR expires_at > datetime('now'))
        AND (max_uses IS NULL OR current_uses < max_uses)
      `;

      this.db.get(query, [shareToken], (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        if (!row) {
          resolve(null);
          return;
        }

        // Increment use count
        const updateQuery = `
          UPDATE world_share_links 
          SET current_uses = current_uses + 1 
          WHERE id = ?
        `;

        this.db.run(updateQuery, [row.id], (err) => {
          if (err) {
            reject(err);
          } else {
            resolve(row);
          }
        });
      });
    });
  }

  /**
   * Add to sync queue
   */
  async queueForSync(worldId, operation) {
    return new Promise((resolve, reject) => {
      const id = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const query = `
        INSERT INTO sync_queue 
        (id, world_id, operation, status)
        VALUES (?, ?, ?, 'pending')
      `;

      this.db.run(query, [id, worldId, operation], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(id);
        }
      });
    });
  }

  /**
   * Get pending sync operations
   */
  async getPendingSyncOps(limit = 100) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT * FROM sync_queue 
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT ?
      `;

      this.db.all(query, [limit], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  /**
   * Update sync operation status
   */
  async updateSyncStatus(syncId, status, error = null) {
    return new Promise((resolve, reject) => {
      const query = `
        UPDATE sync_queue 
        SET status = ?, last_error = ?, updated_at = datetime('now')
        WHERE id = ?
      `;

      this.db.run(query, [status, error, syncId], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  /**
   * Update world AT Protocol URI after sync
   */
  async updateWorldAtprotoUri(worldId, uri, cid) {
    return new Promise((resolve, reject) => {
      const query = `
        UPDATE worlds 
        SET atproto_uri = ?, atproto_cid = ?, sync_status = 'synced', last_synced_at = datetime('now')
        WHERE id = ?
      `;

      this.db.run(query, [uri, cid, worldId], function (err) {
        if (err) {
          reject(err);
        } else {
          resolve(this.changes);
        }
      });
    });
  }

  /**
   * Get storage statistics
   */
  async getStorageStats(did) {
    return new Promise((resolve, reject) => {
      const query = `
        SELECT 
          COUNT(*) as total_worlds,
          SUM(CASE WHEN is_public = 1 THEN 1 ELSE 0 END) as public_worlds,
          COUNT(DISTINCT w.id) as total_versions,
          COALESCE(SUM(wv.size_bytes), 0) as total_bytes
        FROM worlds w
        LEFT JOIN world_versions wv ON w.id = wv.world_id
        WHERE w.owner_did = ?
      `;

      this.db.get(query, [did], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row || {});
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
let worldStorageDB = null;

function getWorldStorageDB() {
  if (!worldStorageDB) {
    worldStorageDB = new WorldStorageDB();
  }
  return worldStorageDB;
}

module.exports = {
  WorldStorageDB,
  getWorldStorageDB,
};
