/**
 * Phase 7 – KMS/HSM Integration Stub
 * AES-256-GCM encryption with HashiCorp Vault / AWS KMS stub.
 * Falls back to env-seeded keys in staging.
 * Tenant-scoped key derivation for PII field encryption at rest.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string;         // base64
  tag: string;        // base64
  keyId: string;      // KMS key reference
  algorithm: string;
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyCache = new Map<string, Buffer>();

  constructor(private readonly config: ConfigService) {}

  /**
   * Fetch or derive a tenant-scoped AES-256 key.
   * In production: calls Vault/KMS. In staging: derives from env seed.
   */
  private async getTenantKey(tenantId: string): Promise<{ key: Buffer; keyId: string }> {
    const cacheKey = `tenant:${tenantId}`;
    if (this.keyCache.has(cacheKey)) {
      return { key: this.keyCache.get(cacheKey)!, keyId: `env-${tenantId.slice(0, 8)}` };
    }

    const kmsEnabled = this.config.get<string>('KMS_ENABLED') === 'true';

    if (kmsEnabled) {
      // Production: call Vault/KMS stub
      const key = await this.fetchFromKmsStub(tenantId);
      this.keyCache.set(cacheKey, key);
      return { key, keyId: `kms-${tenantId.slice(0, 8)}` };
    }

    // Staging/dev: derive from env seed + tenantId
    const masterKey = this.config.get<string>('ENCRYPTION_MASTER_KEY') ?? 'beba-sacco-dev-master-key-32bytes!';
    const key = crypto.createHmac('sha256', masterKey).update(tenantId).digest();
    this.keyCache.set(cacheKey, key);
    return { key, keyId: `env-${tenantId.slice(0, 8)}` };
  }

  /**
   * Vault/KMS stub – replace with actual SDK call in production.
   */
  private async fetchFromKmsStub(tenantId: string): Promise<Buffer> {
    this.logger.debug(`[KMS] Fetching key for tenant ${tenantId}`);
    // Stub: derive deterministically from Vault transit key
    const vaultToken = this.config.get<string>('VAULT_TOKEN') ?? 'dev-token';
    return crypto.createHmac('sha256', vaultToken).update(`tenant-key:${tenantId}`).digest();
  }

  /**
   * Encrypt a plaintext string with AES-256-GCM.
   */
  async encrypt(plaintext: string, tenantId: string): Promise<EncryptedPayload> {
    const { key, keyId } = await this.getTenantKey(tenantId);
    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      keyId,
      algorithm: this.algorithm,
    };
  }

  /**
   * Decrypt an AES-256-GCM payload.
   */
  async decrypt(payload: EncryptedPayload, tenantId: string): Promise<string> {
    const { key } = await this.getTenantKey(tenantId);
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const ciphertext = Buffer.from(payload.ciphertext, 'base64');

    const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ciphertext).toString('utf8') + decipher.final('utf8');
  }

  /**
   * Encrypt a JSON object (PII fields at rest).
   */
  async encryptObject<T extends object>(obj: T, tenantId: string): Promise<EncryptedPayload> {
    return this.encrypt(JSON.stringify(obj), tenantId);
  }

  /**
   * Decrypt a JSON object.
   */
  async decryptObject<T extends object>(payload: EncryptedPayload, tenantId: string): Promise<T> {
    const json = await this.decrypt(payload, tenantId);
    return JSON.parse(json) as T;
  }

  /**
   * Rotate the cached key for a tenant (called by SecretRotationService).
   */
  evictKeyCache(tenantId: string): void {
    this.keyCache.delete(`tenant:${tenantId}`);
    this.logger.log(`[KMS] Key cache evicted for tenant ${tenantId}`);
  }
}
