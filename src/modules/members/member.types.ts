import { KycStatus } from '@prisma/client';

export const KycStatusAlias = {
  DRAFT: KycStatus.PENDING_UPLOAD,
  SUBMITTED: KycStatus.PENDING_REVIEW,
  UNDER_REVIEW: KycStatus.PENDING_REVIEW,
  VERIFIED: KycStatus.APPROVED,
  REJECTED: KycStatus.REJECTED,
} as const;

export type BusinessKycStatus = keyof typeof KycStatusAlias;
export type InternalKycStatus = (typeof KycStatusAlias)[BusinessKycStatus] | KycStatus;

const INTERNAL_TO_BUSINESS_STATUS: Record<KycStatus, BusinessKycStatus> = {
  [KycStatus.PENDING_UPLOAD]: 'DRAFT',
  [KycStatus.PENDING_REVIEW]: 'UNDER_REVIEW',
  [KycStatus.APPROVED]: 'VERIFIED',
  [KycStatus.REJECTED]: 'REJECTED',
};

export const BUSINESS_KYC_STATUS_VALUES = Object.keys(KycStatusAlias) as BusinessKycStatus[];
export const ACCEPTED_KYC_STATUS_VALUES = [
  ...Object.values(KycStatus),
  ...BUSINESS_KYC_STATUS_VALUES,
];

export function resolveKycStatus(status: string): KycStatus {
  if (status in KycStatusAlias) {
    return KycStatusAlias[status as BusinessKycStatus];
  }

  if ((Object.values(KycStatus) as string[]).includes(status)) {
    return status as KycStatus;
  }

  throw new Error(`Unsupported KYC status: ${status}`);
}

export function toBusinessStatus(internalStatus: KycStatus | string): BusinessKycStatus | string {
  if ((Object.values(KycStatus) as string[]).includes(internalStatus)) {
    return INTERNAL_TO_BUSINESS_STATUS[internalStatus as KycStatus] ?? internalStatus;
  }

  return internalStatus;
}
