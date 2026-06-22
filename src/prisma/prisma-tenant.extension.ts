import { Prisma } from '@prisma/client';
import { tenantAsyncStorage } from '../common/services/tenant-context.service';

export const TENANT_SCOPED_MODELS = [
  'TenantCounter',
  'User',
  'AuditLog',
  'Member',
  'Document',
  'Account',
  'LoanProduct',
  'Loan',
  'LoanGuarantor',
  'Transaction',
  'MpesaTransaction',
  'LoanApprovalChain',
  'LoginSession',
  'WebhookSubscription',
  'IntegrationOutbox',
  'CrbReport',
  'AmlScreening',
  'ProvisioningEntry',
  'DsarRequest',
  'SasraRatioSnapshot',
  'CbkReturn',
  'ApiClient',
  'NotificationLog',
  'ComplianceAlert',
  'RiskScore',
  'FeatureSnapshot',
  'TenantRegionConfig',
  'FailedLoginAttempt',
  'BlockedIP',
  'DataAccessLog',
  'ConsentRegistry',
  'ErasureRequest',
  'Partner',
  'SlaIncident',
  'ExecutiveReport',
  'ReportJob',
  'MemberApplication',
  'Stage',
  'LoanRepayment',
  'SavingsRecord',
  'GroupWelfare',
  'GroupWelfareCollection',
  'DataImportLog',
  'KYCRequirement',
  'Incident',
  'InAppNotification',
] as const;

export const TENANT_EXEMPT_MODELS = [
  'Tenant',
  'WebhookDelivery',
  'FeatureFlag',
  'CanaryDeployment',
  'PartnerUsageSnapshot',
  'County',
  'Constituency',
  'Ward',
  'StageAssignment',
  'MemberStage',
  'RefreshSession',
  'DataConsent',
] as const;

type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];
type PrismaArgs = {
  where?: Record<string, unknown>;
  data?: unknown;
  create?: Record<string, unknown>;
};

const TENANT_SCOPED_MODEL_SET = new Set<string>(TENANT_SCOPED_MODELS);
const TENANT_EXEMPT_MODEL_SET = new Set<string>(TENANT_EXEMPT_MODELS);
const READ_ACTIONS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const CREATE_ACTIONS = new Set<string>(['create', 'createMany']);
const UPDATE_ACTIONS = new Set<string>(['update', 'updateMany']);
const DELETE_ACTIONS = new Set<string>(['delete', 'deleteMany']);

function isTenantScopedModel(model: string | undefined): model is TenantScopedModel {
  return typeof model === 'string' && TENANT_SCOPED_MODEL_SET.has(model);
}

function assertKnownModel(model: string | undefined): void {
  if (!model || TENANT_SCOPED_MODEL_SET.has(model) || TENANT_EXEMPT_MODEL_SET.has(model)) {
    return;
  }

  throw new Error(
    `Prisma tenant extension model allowlist is incomplete: ${model} is not classified`,
  );
}

function getArgs(params: Prisma.MiddlewareParams): PrismaArgs {
  const current = params.args;
  if (current && typeof current === 'object') {
    return current as PrismaArgs;
  }

  params.args = {};
  return params.args as PrismaArgs;
}

function addTenantToWhere(args: PrismaArgs, tenantId: string): void {
  args.where = {
    ...(args.where ?? {}),
    tenantId,
  };
}

function addTenantToData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) {
    return data.map((entry) => addTenantToData(entry, tenantId));
  }

  if (data && typeof data === 'object') {
    return {
      ...(data as Record<string, unknown>),
      tenantId,
    };
  }

  return { tenantId };
}

function enforceAuditLogAppendOnly(params: Prisma.MiddlewareParams): void {
  if (params.model !== 'AuditLog') {
    return;
  }

  if (UPDATE_ACTIONS.has(params.action) || DELETE_ACTIONS.has(params.action)) {
    throw new Error('AuditLog is append-only: updates and deletes are forbidden');
  }
}

function applyTenantScope(params: Prisma.MiddlewareParams): void {
  assertKnownModel(params.model);
  enforceAuditLogAppendOnly(params);

  if (!isTenantScopedModel(params.model)) {
    return;
  }

  const tenantId = tenantAsyncStorage.getStore()?.tenantId;
  if (!tenantId) {
    return;
  }

  const args = getArgs(params);

  if (READ_ACTIONS.has(params.action)) {
    addTenantToWhere(args, tenantId);
    return;
  }

  if (CREATE_ACTIONS.has(params.action)) {
    args.data = addTenantToData(args.data, tenantId);
    return;
  }

  if (UPDATE_ACTIONS.has(params.action) || DELETE_ACTIONS.has(params.action)) {
    addTenantToWhere(args, tenantId);
    return;
  }

  if (params.action === 'upsert') {
    addTenantToWhere(args, tenantId);
    args.create = {
      ...(args.create ?? {}),
      tenantId,
    };
  }
}

export const prismaTenantExtension = Prisma.defineExtension((client) => {
  return client.$extends({
    name: 'prisma-tenant-extension',
  });
});

export function applyPrismaTenantExtension(client: PrismaClientLike): void {
  client.$use(async (params, next) => {
    applyTenantScope(params);
    return next(params);
  });
  client.$extends(prismaTenantExtension);
}

interface PrismaClientLike {
  $use: (middleware: Prisma.Middleware) => void;
  $extends: (extension: typeof prismaTenantExtension) => unknown;
}
