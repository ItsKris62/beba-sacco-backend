/**
 * Global feature flags driven by Render environment variables.
 *
 * Pattern: FEATURE_<NAME> = 'true' | 'false' | 'canary'
 *
 * Usage:
 *   if (FeatureFlags.SECURE_UPLOAD_V2) { ... }
 *   if (FeatureFlags.isEnabled('VIRUS_SCAN', tenantId)) { ... }
 */
export const FEATURE_FLAG_NAMES = [
  'SECURE_UPLOAD_V2',
  'VIRUS_SCAN',
  'RLS_ENFORCEMENT',
  'KYC_STATUS_ALIAS',
] as const;

export type FeatureFlagName = (typeof FEATURE_FLAG_NAMES)[number];

const readFlagValue = (flagName: FeatureFlagName): string =>
  (process.env[`FEATURE_${flagName}`] ?? 'false').trim().toLowerCase();

const isTrue = (flagName: FeatureFlagName): boolean => readFlagValue(flagName) === 'true';

const canaryTenantsFor = (flagName: FeatureFlagName): string[] =>
  (process.env[`FEATURE_${flagName}_CANARY_TENANTS`] ?? '')
    .split(',')
    .map((tenantId) => tenantId.trim())
    .filter(Boolean);

export const FeatureFlags = {
  get SECURE_UPLOAD_V2(): boolean {
    return isTrue('SECURE_UPLOAD_V2');
  },

  get VIRUS_SCAN(): boolean {
    return isTrue('VIRUS_SCAN');
  },

  get RLS_ENFORCEMENT(): boolean {
    return isTrue('RLS_ENFORCEMENT');
  },

  get KYC_STATUS_ALIAS(): boolean {
    return isTrue('KYC_STATUS_ALIAS');
  },

  isEnabled(flagName: FeatureFlagName, tenantId?: string): boolean {
    const value = readFlagValue(flagName);
    if (value === 'true') return true;
    if (value === 'canary' && tenantId) {
      return canaryTenantsFor(flagName).includes(tenantId);
    }
    return false;
  },

  snapshot(tenantId?: string): Record<FeatureFlagName, boolean> {
    return FEATURE_FLAG_NAMES.reduce(
      (acc, flagName) => ({
        ...acc,
        [flagName]: FeatureFlags.isEnabled(flagName, tenantId),
      }),
      {} as Record<FeatureFlagName, boolean>,
    );
  },
} as const;

/**
 * Legacy product-rule flag retained for existing imports.
 * ENABLE_PRODUCT_RULES is fail-fast validated at startup.
 */
export const ENABLE_PRODUCT_RULES_ENGINE = process.env.ENABLE_PRODUCT_RULES === 'true';
