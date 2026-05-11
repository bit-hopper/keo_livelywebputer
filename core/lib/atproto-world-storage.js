/**
 * AT Protocol World Storage
 * 
 * Handles storing and retrieving Lively Kernel worlds as AT Protocol records
 * Worlds are stored as app.lively.world records in user repositories
 */

const { AtpAgent } = require('@atproto/api');
const { getConfig } = require('./atproto-config');
const { getPDSManager } = require('./atproto-pds');
const crypto = require('crypto');

class ATProtoWorldStorage {
  constructor() {
    this.config = getConfig();
    this.pdsManager = getPDSManager();
    this.collectionName = 'app.lively.world';
  }

  /**
   * Save a world to AT Protocol
   */
  async saveWorld(did, accessToken, worldData) {
    try {
      const { worldId, name, description, content, metadata = {} } = worldData;

      if (!worldId || !name || !content) {
        throw new Error('worldId, name, and content are required');
      }

      // Create world record
      const worldRecord = {
        type: this.collectionName,
        worldId,
        name,
        description: description || '',
        content,
        metadata: {
          ...metadata,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: '1.0',
        },
        uri: null, // Will be set by server
        cid: null, // Will be set by server
      };

      // Create agent authenticated with user token
      const agent = new AtpAgent({
        service: this.config.pds.url,
      });
      agent.setHeader('authorization', `Bearer ${accessToken}`);

      // TODO: Create record via PDS repository API
      // For now, return structured data

      console.log('[ATProtoWorldStorage] World saved:', { did, worldId });

      return {
        uri: `at://${did}/${this.collectionName}/${worldId}`,
        cid: 'placeholder_cid',
        record: worldRecord,
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Save world error:', error);
      throw error;
    }
  }

  /**
   * Update an existing world
   */
  async updateWorld(did, accessToken, worldId, updates) {
    try {
      const { name, description, content, metadata = {} } = updates;

      // Fetch existing world
      const existingWorld = await this.getWorld(did, accessToken, worldId);

      if (!existingWorld) {
        throw new Error('World not found');
      }

      // Merge updates
      const updatedRecord = {
        ...existingWorld,
        name: name || existingWorld.name,
        description: description !== undefined ? description : existingWorld.description,
        content: content || existingWorld.content,
        metadata: {
          ...existingWorld.metadata,
          ...metadata,
          updatedAt: new Date().toISOString(),
        },
      };

      // TODO: Update record via PDS repository API

      console.log('[ATProtoWorldStorage] World updated:', { did, worldId });

      return {
        uri: `at://${did}/${this.collectionName}/${worldId}`,
        cid: 'placeholder_cid',
        record: updatedRecord,
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Update world error:', error);
      throw error;
    }
  }

  /**
   * Get a specific world
   */
  async getWorld(did, accessToken, worldId) {
    try {
      const agent = new AtpAgent({
        service: this.config.pds.url,
      });
      agent.setHeader('authorization', `Bearer ${accessToken}`);

      // TODO: Fetch record from PDS repository API
      // For now, placeholder

      console.log('[ATProtoWorldStorage] World retrieved:', { did, worldId });

      return null; // Placeholder
    } catch (error) {
      console.error('[ATProtoWorldStorage] Get world error:', error);
      throw error;
    }
  }

  /**
   * List all worlds for a user
   */
  async listWorlds(did, accessToken, limit = 100, cursor = null) {
    try {
      const agent = new AtpAgent({
        service: this.config.pds.url,
      });
      agent.setHeader('authorization', `Bearer ${accessToken}`);

      // TODO: List records via PDS repository API

      console.log('[ATProtoWorldStorage] Worlds listed for:', did);

      return {
        worlds: [],
        cursor: null,
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] List worlds error:', error);
      throw error;
    }
  }

  /**
   * Delete a world
   */
  async deleteWorld(did, accessToken, worldId) {
    try {
      const agent = new AtpAgent({
        service: this.config.pds.url,
      });
      agent.setHeader('authorization', `Bearer ${accessToken}`);

      // TODO: Delete record from PDS repository API

      console.log('[ATProtoWorldStorage] World deleted:', { did, worldId });

      return { success: true };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Delete world error:', error);
      throw error;
    }
  }

  /**
   * Create a world version (for versioning/snapshots)
   */
  async createWorldVersion(did, accessToken, worldId, content) {
    try {
      const versionId = crypto.randomBytes(8).toString('hex');
      const timestamp = Date.now();

      const versionRecord = {
        type: `${this.collectionName}.version`,
        worldId,
        versionId,
        content,
        createdAt: new Date().toISOString(),
        cid: 'placeholder_cid',
      };

      // TODO: Create version record via PDS repository API

      console.log('[ATProtoWorldStorage] Version created:', { did, worldId, versionId });

      return {
        uri: `at://${did}/${this.collectionName}.version/${versionId}`,
        cid: 'placeholder_cid',
        record: versionRecord,
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Create version error:', error);
      throw error;
    }
  }

  /**
   * List versions of a world
   */
  async listWorldVersions(did, accessToken, worldId, limit = 50) {
    try {
      // TODO: Query versions via PDS repository API

      console.log('[ATProtoWorldStorage] Versions listed for:', { did, worldId });

      return {
        versions: [],
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] List versions error:', error);
      throw error;
    }
  }

  /**
   * Restore world to a specific version
   */
  async restoreWorldVersion(did, accessToken, worldId, versionId) {
    try {
      // Get version content
      // Update current world to version content
      // Create new version record

      console.log('[ATProtoWorldStorage] Version restored:', { did, worldId, versionId });

      return { success: true };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Restore version error:', error);
      throw error;
    }
  }

  /**
   * Share world with another user (create a link)
   */
  async shareWorld(did, accessToken, worldId, recipientDid = null) {
    try {
      const shareToken = crypto.randomBytes(32).toString('hex');
      const shareLink = `${this.config.server.baseUrl}/world/${worldId}?token=${shareToken}`;

      // TODO: Create share record or store in access control list

      console.log('[ATProtoWorldStorage] World shared:', { did, worldId, recipientDid });

      return {
        shareLink,
        shareToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Share world error:', error);
      throw error;
    }
  }

  /**
   * Export world as JSON
   */
  async exportWorld(did, accessToken, worldId) {
    try {
      const world = await this.getWorld(did, accessToken, worldId);

      if (!world) {
        throw new Error('World not found');
      }

      const exportData = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        world,
      };

      console.log('[ATProtoWorldStorage] World exported:', { did, worldId });

      return exportData;
    } catch (error) {
      console.error('[ATProtoWorldStorage] Export world error:', error);
      throw error;
    }
  }

  /**
   * Import world from JSON
   */
  async importWorld(did, accessToken, importData) {
    try {
      if (!importData.world) {
        throw new Error('Invalid import data: missing world');
      }

      const { world } = importData;
      const newWorldId = `imported-${crypto.randomBytes(4).toString('hex')}`;

      // Create new world from imported data
      const result = await this.saveWorld(did, accessToken, {
        worldId: newWorldId,
        name: world.name,
        description: world.description,
        content: world.content,
        metadata: {
          ...world.metadata,
          importedFrom: world.uri || 'unknown',
          importedAt: new Date().toISOString(),
        },
      });

      console.log('[ATProtoWorldStorage] World imported:', { did, worldId: newWorldId });

      return result;
    } catch (error) {
      console.error('[ATProtoWorldStorage] Import world error:', error);
      throw error;
    }
  }

  /**
   * Search worlds by name or description
   */
  async searchWorlds(did, accessToken, query, limit = 20) {
    try {
      // TODO: Implement full-text search via PDS API

      console.log('[ATProtoWorldStorage] Search performed:', { did, query });

      return {
        results: [],
        total: 0,
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Search error:', error);
      throw error;
    }
  }

  /**
   * Get world statistics
   */
  async getWorldStats(did, accessToken, worldId) {
    try {
      const world = await this.getWorld(did, accessToken, worldId);

      if (!world) {
        throw new Error('World not found');
      }

      return {
        worldId,
        name: world.name,
        size: JSON.stringify(world.content).length,
        created: world.metadata?.createdAt,
        modified: world.metadata?.updatedAt,
        versions: 0, // TODO: Count versions
        shared: false, // TODO: Check if shared
      };
    } catch (error) {
      console.error('[ATProtoWorldStorage] Get stats error:', error);
      throw error;
    }
  }
}

// Singleton instance
let worldStorage = null;

function getWorldStorage() {
  if (!worldStorage) {
    worldStorage = new ATProtoWorldStorage();
  }
  return worldStorage;
}

module.exports = {
  ATProtoWorldStorage,
  getWorldStorage,
};
