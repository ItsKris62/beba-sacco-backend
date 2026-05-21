import { NotImplementedException } from '@nestjs/common';
import { FeatureFlagName, FeatureFlags } from '../../config/feature-flags';

type FallbackFunction = (...args: unknown[]) => unknown;

const findTenantId = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;

  const maybeRecord = value as Record<string, unknown>;
  const headers = maybeRecord.headers as Record<string, unknown> | undefined;
  const tenantHeader = headers?.['x-tenant-id'] ?? headers?.['X-Tenant-ID'];
  if (typeof tenantHeader === 'string') return tenantHeader;

  const tenant = maybeRecord.tenant as Record<string, unknown> | undefined;
  if (typeof tenant?.id === 'string') return tenant.id;

  if (typeof maybeRecord.tenantId === 'string') return maybeRecord.tenantId;
  return undefined;
};

/**
 * Guard method execution behind an environment-driven feature flag.
 *
 * @example
 *   @RequireFeature('SECURE_UPLOAD_V2')
 *   async secureUpload() { ... }
 */
export const RequireFeature = (
  flagName: FeatureFlagName,
  fallback?: FallbackFunction,
): MethodDecorator => {
  return (_target: object, _propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;

    descriptor.value = async function (...args: unknown[]) {
      const tenantId = args.map(findTenantId).find(Boolean);

      if (!FeatureFlags.isEnabled(flagName, tenantId)) {
        if (typeof fallback === 'function') {
          return fallback.apply(this, args);
        }
        throw new NotImplementedException(`Feature ${flagName} is not enabled`);
      }

      return original.apply(this, args);
    };

    return descriptor;
  };
};
