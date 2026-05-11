/**
 * AT Protocol World Sync Engine
 * 
 * Syncs worlds between SQLite storage and AT Protocol repositories
 * Handles creation, updates, versioning, and conflict resolution
 */

const crypto = require('crypto');
const { AtpAgent } = require('@atproto/api');
const { getConfig } = require('./atproto-config');
const { getWorldStorageDB } = require('./atproto-world-db');

class WorldSyncEngine {
  constructor() {
    this.config = getConfig();
    this.db = getWorldStorageDB();
    this.recordType = 'app.lively.world';
    this.syncInterval = 5 * 60 * 1000; // 5 minutes
    this.isSyncing = false;
  }

  /**
   * Start continuous sync process
   */
  startSyncLoop() {
    console.log('[WorldSyncEngine] Starting sync loop');

    this.syncTimer = setInterval(async () => {
      if (!this.isSyncing) {
        try {
          await this.processPendingSyncs();
        } catch (error) {
          console.error('[WorldSyncEngine] Sync loop error:', error);
        }
      }
    }, this.syncInterval);
  }

  /**
   * Stop sync loop
   */
  stopSyncLoop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      console.log('[WorldSyncEngine] Sync loop stopped');
    }
  }

  /**
   * Process pending sync operations
   */
  async processPendingSyncs(limit = 10) {
    try {
      this.isSyncing = true;

      const pendingOps = await this.db.getPendingSyncOps(limit);

      console.log(`[WorldSyncEngine] Processing ${pendingOps.length} pending syncs`);

      for (const op of pendingOps) {
        try {
          await this.processSyncOp(op);
        } catch (error) {
          console.error(`[WorldSyncEngine] Sync failed for operation ${op.id}:`, error);
          await this.db.updateSyncStatus(op.id, 'failed', error.message);
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Process individual sync operation
   */
  async processSyncOp(op) {
    const { id, world_id, operation } = op;

    console.log(`[WorldSyncEngine] Processing ${operation} for world ${world_id}`);

    const world = await this.db.getWorld(world_id);
    if (!world) {
      throw new Error('World not found');
    }

    let result;

    switch (operation) {
      case 'create':
        result = await this.syncCreateWorld(world);
        break;
      case 'update':
        result = await this.syncUpdateWorld(world);
        break;
      case 'delete':
        result = await this.syncDeleteWorld(world);
        break;
      case 'version':
        result = await this.syncWorldVersion(world);
        break;
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    // Update sync status
    await this.db.updateSyncStatus(id, 'completed');

    // Update world with AT Protocol URI
    if (result.uri && result.cid) {
      await this.db.updateWorldAtprotoUri(world_id, result.uri, result.cid);
    }

    return result;
  }

  /**
   * Sync world creation to AT Protocol
   */
  async syncCreateWorld(world) {
    try {
      const agent = await this.createAgentForUser(world.owner_did);

      const record = {
        $type: this.recordType,
        name: world.name,
        description: world.description || '',
        isPublic: world.is_public ? true : false,
        contentHash: world.content_hash,
        createdAt: world.created_at,
        metadata: {
          localId: world.id,
          version: '1.0',
        },
      };

      // Create record in user's repository
      const rkey = this.generateRkey(world.id);
      const response = await agent.com.atproto.repo.createRecord({
        repo: world.owner_did,
        collection: this.recordType,
        record,
        rkey,
      });

      console.log('[WorldSyncEngine] World created on AT Protocol:', response.uri);

      return {
        uri: response.uri,
        cid: response.cid,
      };
    } catch (error) {
      console.error('[WorldSyncEngine] Create sync error:', error);
      throw error;
    }
  }

  /**
   * Sync world update to AT Protocol
   */
  async syncUpdateWorld(world) {
    try {
      // If not yet on AT Protocol, create it
      if (!world.atproto_uri) {
        return this.syncCreateWorld(world);
      }

      const agent = await this.createAgentForUser(world.owner_did);
      const rkey = this.extractRkeyFromUri(world.atproto_uri);

      const record = {
        $type: this.recordType,
        name: world.name,
        description: world.description || '',
        isPublic: world.is_public ? true : false,
        contentHash: world.content_hash,
        createdAt: world.created_at,
        updatedAt: world.updated_at,
        metadata: {
          localId: world.id,
          version: '1.0',
        },
      };

      // Update record in user's repository
      const response = await agent.com.atproto.repo.putRecord({
        repo: world.owner_did,
        collection: this.recordType,
        rkey,
        record,
      });

      console.log('[WorldSyncEngine] World updated on AT Protocol:', response.uri);

      return {
        uri: response.uri,
        cid: response.cid,
      };
    } catch (error) {
      console.error('[WorldSyncEngine] Update sync error:', error);
      throw error;
    }
  }

  /**
   * Sync world deletion to AT Protocol
   */
  async syncDeleteWorld(world) {
    try {
      if (!world.atproto_uri) {
        // Not on AT Protocol yet, just mark as deleted locally
        return { success: true };
      }

      const agent = await this.createAgentForUser(world.owner_did);
      const rkey = this.extractRkeyFromUri(world.atproto_uri);

      // Delete record from user's repository
      await agent.com.atproto.repo.deleteRecord({
        repo: world.owner_did,
        collection: this.recordType,
        rkey,
      });

      console.log('[WorldSyncEngine] World deleted from AT Protocol');

      return { success: true };
    } catch (error) {
      console.error('[WorldSyncEngine] Delete sync error:', error);
      throw error;
    }
  }

  /**
   * Sync world version to AT Protocol
   */
  async syncWorldVersion(world) {
    try {
      // Get latest version
      const versions = await this.db.getWorldVersions(world.id, 1);
      if (!versions.length) {
        throw new Error('No versions found');
      }

      const version = versions[0];
      const agent = await this.createAgentForUser(world.owner_did);

      const versionRecord = {
        $type: `${this.recordType}.version`,
        worldId: world.id,
        contentHash: version.content_hash,
        sizeBytes: version.size_bytes,
        message: version.message || '',
        createdAt: version.created_at,
        metadata: {
          localId: version.id,
        },
      };

      // Create version record
      const rkey = this.generateRkey(version.id);
      const response = await agent.com.atproto.repo.createRecord({
        repo: world.owner_did,
        collection: `${this.recordType}.version`,
        record: versionRecord,
        rkey,
      });

      console.log('[WorldSyncEngine] World version created on AT Protocol:', response.uri);

      return {
        uri: response.uri,
        cid: response.cid,
      };
    } catch (error) {
      console.error('[WorldSyncEngine] Version sync error:', error);
      throw error;
    }
  }

  /**
   * Create authenticated agent for user
   */
  async createAgentForUser(did) {
    try {
      // TODO: Get user's access token from session
      // For now, this is a placeholder
      const agent = new AtpAgent({
        service: this.config.pds.url,
      });

      // Would set auth header with user's token
      // agent.setHeader('authorization', `Bearer ${accessToken}`);

      return agent;
    } catch (error) {
      console.error('[WorldSyncEngine] Agent creation error:', error);
      throw error;
    }
  }

  /**
   * Queue world for sync
   */
  async queueWorldForSync(worldId, operation) {
    try {
      const syncId = await this.db.queueForSync(worldId, operation);
      console.log(`[WorldSyncEngine] Queued world ${worldId} for ${operation}`);
      return syncId;
    } catch (error) {
      console.error('[WorldSyncEngine] Queue error:', error);
      throw error;
    }
  }

  /**
   * Generate record key from identifier
   */
  generateRkey(id) {
    // Use TID-like format (timestamp + random)
    const timestamp = Date.now().toString(16);
    const random = crypto.randomBytes(4).toString('hex');
    return `${timestamp}${random}`.toLowerCase();
  }

  /**
   * Extract rkey from AT Protocol URI
   */
  extractRkeyFromUri(uri) {
    // URI format: at://did:plc:xxx/app.lively.world/rkey
    const parts = uri.split('/');
    return parts[parts.length - 1];
  }

  /**
   * Fetch world from AT Protocol
   */
  async fetchWorldFromAtproto(did, rkey) {
    try {
      const agent = new AtpAgent({
        service: this.config.pds.url,
      });

      const response = await agent.com.atproto.repo.getRecord({
        repo: did,
        collection: this.recordType,
        rkey,
      });

      return response.value;
    } catch (error) {
      console.error('[WorldSyncEngine] Fetch from AT Protocol error:', error);
      throw error;
    }
  }

  /**
   * List all worlds from AT Protocol for a user
   */
  async listWorldsFromAtproto(did) {
    try {
      const agent = new AtpAgent({
        service: this.config.pds.url,
      });

      const response = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection: this.recordType,
      });

      return response.records || [];
    } catch (error) {
      console.error('[WorldSyncEngine] List from AT Protocol error:', error);
      throw error;
    }
  }

  /**
   * Get sync status for world
   */
  async getSyncStatus(worldId) {
    try {
      const world = await this.db.getWorld(worldId);
      if (!world) {
        throw new Error('World not found');
      }

      return {
        worldId,
        syncStatus: world.sync_status,
        lastSynced: world.last_synced_at,
        atprotoUri: world.atproto_uri,
        atprotoCid: world.atproto_cid,
      };
    } catch (error) {
      console.error('[WorldSyncEngine] Get sync status error:', error);
      throw error;
    }
  }

  /**
   * Get world from local DB (check cache before AT Protocol)
   */
  async getWorldLocal(worldId) {
    try {
      return await this.db.getWorld(worldId);
    } catch (error) {
      console.error('[WorldSyncEngine] Get world local error:', error);
      throw error;
    }
  }

  /**
   * Resolve world conflict (prefer local if newer)
   */
  async resolveWorldConflict(localWorld, atprotoWorld) {
    try {
      const localTime = new Date(localWorld.updated_at).getTime();
      const atprotoTime = new Date(atprotoWorld.updatedAt || atprotoWorld.createdAt).getTime();

      if (localTime > atprotoTime) {
        console.log('[WorldSyncEngine] Using local version (newer)');
        return localWorld;
      } else {
        console.log('[WorldSyncEngine] Using AT Protocol version (newer)');
        return atprotoWorld;
      }
    } catch (error) {
      console.error('[WorldSyncEngine] Conflict resolution error:', error);
      throw error;
    }
  }
}

// Singleton instance
let syncEngine = null;

function getWorldSyncEngine() {
  if (!syncEngine) {
    syncEngine = new WorldSyncEngine();
  }
  return syncEngine;
}

module.exports = {
  WorldSyncEngine,
  getWorldSyncEngine,
};
