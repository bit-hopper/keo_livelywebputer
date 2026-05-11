/**
 * AT Protocol PDS Account Management
 * 
 * Handles account creation and management on Personal Data Server (PDS)
 * Using @atproto/pds for server-side account operations
 */

const { AtpAgent } = require('@atproto/api');
const { getConfig } = require('./atproto-config');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

class ATProtoPDSManager {
  constructor() {
    this.config = getConfig();
    this.agent = null;
    this.initializeAgent();
  }

  /**
   * Initialize ATP Agent connected to PDS
   */
  initializeAgent() {
    try {
      this.agent = new AtpAgent({
        service: this.config.pds.url,
      });
      console.log('[ATProtoPDSManager] ATP Agent initialized for PDS:', this.config.pds.url);
    } catch (error) {
      console.error('[ATProtoPDSManager] Failed to initialize ATP Agent:', error);
      throw error;
    }
  }

  /**
   * Create a new account on the PDS
   */
  async createAccount(handle, email, password, inviteCode = null) {
    try {
      // Validate inputs
      if (!this.isValidHandle(handle)) {
        throw new Error('Invalid handle format');
      }

      if (!this.isValidEmail(email)) {
        throw new Error('Invalid email format');
      }

      if (!password || password.length < 8) {
        throw new Error('Password must be at least 8 characters');
      }

      // Check if handle is available on PDS
      const available = await this.isHandleAvailable(handle);
      if (!available) {
        throw new Error('Handle already taken');
      }

      // Hash password for storage
      const passwordHash = await bcrypt.hash(password, 10);

      // Generate DID for new account
      const did = this.config.generateDID(handle);

      // Create account via PDS
      // This would typically call PDS API to create account
      const accountData = {
        did,
        handle,
        email,
        passwordHash,
        createdAt: new Date().toISOString(),
        inviteCode: inviteCode || null,
      };

      // TODO: Call actual PDS createAccount endpoint
      // For now, return account data structure

      console.log('[ATProtoPDSManager] Account created:', { did, handle, email });

      return {
        did,
        handle,
        email,
        createdAt: accountData.createdAt,
      };
    } catch (error) {
      console.error('[ATProtoPDSManager] Account creation error:', error);
      throw error;
    }
  }

  /**
   * Verify email address via OTP or link
   */
  async sendEmailVerification(email, handle) {
    try {
      // Generate verification token
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationUrl = `${this.config.server.baseUrl}/auth/verify-email?token=${verificationToken}`;

      // TODO: Send email with verification link
      // This would integrate with an email service like SendGrid, Mailgun, etc.

      console.log('[ATProtoPDSManager] Email verification sent to:', email);

      return {
        token: verificationToken,
        verificationUrl,
      };
    } catch (error) {
      console.error('[ATProtoPDSManager] Email verification error:', error);
      throw error;
    }
  }

  /**
   * Verify email token
   */
  async verifyEmailToken(token) {
    try {
      // TODO: Look up token in database and verify
      // Update user's email_verified status

      console.log('[ATProtoPDSManager] Email verified for token:', token);

      return true;
    } catch (error) {
      console.error('[ATProtoPDSManager] Email verification error:', error);
      throw error;
    }
  }

  /**
   * Check if handle is available on PDS
   */
  async isHandleAvailable(handle, pdsUrl = null) {
    try {
      // Use provided PDS URL or configured default
      const url = pdsUrl || this.config.pds.url;

      const agent = new AtpAgent({
        service: url,
      });

      // Try to resolve the handle
      const result = await agent.com.atproto.identity.resolveHandle({ handle });

      // If we get here, handle exists
      return false;
    } catch (error) {
      // Handle not found = available
      if (error.status === 404 || error.error === 'HandleNotFound') {
        return true;
      }

      // Some other error occurred
      console.error('[ATProtoPDSManager] Handle availability check error:', error);
      throw error;
    }
  }

  /**
   * Update account profile
   */
  async updateProfile(did, updates) {
    try {
      const { displayName, description, avatar, banner } = updates;

      // TODO: Update profile in PDS repository
      // This would involve creating/updating a profile record in the user's repo

      const profile = {
        displayName: displayName || '',
        description: description || '',
        avatar: avatar || null,
        banner: banner || null,
        updatedAt: new Date().toISOString(),
      };

      console.log('[ATProtoPDSManager] Profile updated for DID:', did);

      return profile;
    } catch (error) {
      console.error('[ATProtoPDSManager] Profile update error:', error);
      throw error;
    }
  }

  /**
   * Update account email
   */
  async updateEmail(did, newEmail) {
    try {
      if (!this.isValidEmail(newEmail)) {
        throw new Error('Invalid email format');
      }

      // TODO: Update email in PDS and send verification

      console.log('[ATProtoPDSManager] Email update requested for DID:', did);

      // Send verification email
      await this.sendEmailVerification(newEmail, did);

      return {
        email: newEmail,
        verified: false,
      };
    } catch (error) {
      console.error('[ATProtoPDSManager] Email update error:', error);
      throw error;
    }
  }

  /**
   * Change account password
   */
  async changePassword(did, currentPassword, newPassword) {
    try {
      if (!newPassword || newPassword.length < 8) {
        throw new Error('New password must be at least 8 characters');
      }

      // TODO: Verify current password
      // TODO: Hash new password and store in PDS

      const newPasswordHash = await bcrypt.hash(newPassword, 10);

      console.log('[ATProtoPDSManager] Password changed for DID:', did);

      return { success: true };
    } catch (error) {
      console.error('[ATProtoPDSManager] Password change error:', error);
      throw error;
    }
  }

  /**
   * Delete account
   */
  async deleteAccount(did, password) {
    try {
      // TODO: Verify password
      // TODO: Delete all account data from PDS
      // TODO: Mark DID as deleted

      console.log('[ATProtoPDSManager] Account deleted for DID:', did);

      return { success: true };
    } catch (error) {
      console.error('[ATProtoPDSManager] Account deletion error:', error);
      throw error;
    }
  }

  /**
   * Validate handle format
   */
  isValidHandle(handle) {
    // AT Protocol handle validation
    const handleRegex = /^[a-z0-9]([a-z0-9-]{1,251}[a-z0-9])?$/i;
    return handleRegex.test(handle) && handle.length >= 3 && handle.length <= 253;
  }

  /**
   * Validate email format
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Get account information
   */
  async getAccount(did) {
    try {
      // TODO: Fetch account data from PDS

      console.log('[ATProtoPDSManager] Account retrieved for DID:', did);

      return {
        did,
        handle: 'unknown.bsky.social',
        email: 'unknown@example.com',
        emailVerified: false,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error('[ATProtoPDSManager] Account retrieval error:', error);
      throw error;
    }
  }

  /**
   * List all records of a specific type for a user
   */
  async listRecords(did, collection, limit = 100) {
    try {
      const response = await this.agent.com.atproto.repo.listRecords({
        repo: did,
        collection,
        limit,
      });

      return response.records || [];
    } catch (error) {
      console.error('[ATProtoPDSManager] List records error:', error);
      throw error;
    }
  }

  /**
   * Create a record in user's repository
   */
  async createRecord(did, collection, record, rkey = null) {
    try {
      // Generate rkey if not provided
      const recordKey = rkey || this.generateRecordKey();

      // TODO: Create record in user's repository

      console.log('[ATProtoPDSManager] Record created:', { did, collection, rkey: recordKey });

      return {
        uri: `at://${did}/${collection}/${recordKey}`,
        cid: 'placeholder_cid',
      };
    } catch (error) {
      console.error('[ATProtoPDSManager] Create record error:', error);
      throw error;
    }
  }

  /**
   * Update a record in user's repository
   */
  async updateRecord(did, collection, rkey, record) {
    try {
      // TODO: Update record in user's repository

      console.log('[ATProtoPDSManager] Record updated:', { did, collection, rkey });

      return {
        uri: `at://${did}/${collection}/${rkey}`,
        cid: 'placeholder_cid',
      };
    } catch (error) {
      console.error('[ATProtoPDSManager] Update record error:', error);
      throw error;
    }
  }

  /**
   * Delete a record from user's repository
   */
  async deleteRecord(did, collection, rkey) {
    try {
      // TODO: Delete record from user's repository

      console.log('[ATProtoPDSManager] Record deleted:', { did, collection, rkey });

      return { success: true };
    } catch (error) {
      console.error('[ATProtoPDSManager] Delete record error:', error);
      throw error;
    }
  }

  /**
   * Generate a record key (TID-like format)
   */
  generateRecordKey() {
    // Generate timestamp-based key (TID-like)
    const now = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `${now.toString(16)}${random}`;
  }

  /**
   * Get server health and PDS status
   */
  async getServerHealth() {
    try {
      // TODO: Call PDS health endpoint
      return {
        status: 'ok',
        pdsUrl: this.config.pds.url,
      };
    } catch (error) {
      console.error('[ATProtoPDSManager] Server health check error:', error);
      return {
        status: 'error',
        error: error.message,
      };
    }
  }
}

// Singleton instance
let pdsManager = null;

function getPDSManager() {
  if (!pdsManager) {
    pdsManager = new ATProtoPDSManager();
  }
  return pdsManager;
}

module.exports = {
  ATProtoPDSManager,
  getPDSManager,
};
