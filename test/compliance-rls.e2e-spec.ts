import { readFileSync } from 'fs';
import { join } from 'path';
import { KycStatus } from '@prisma/client';
import { resolveKycStatus, toBusinessStatus } from '../src/modules/members/member.types';

const backendRoot = join(__dirname, '..');

describe('Compliance, RLS, and Business Status Alias Contracts', () => {
  it('maps business KYC aliases to internal Prisma enum values', () => {
    expect(resolveKycStatus('DRAFT')).toBe(KycStatus.PENDING_UPLOAD);
    expect(resolveKycStatus('SUBMITTED')).toBe(KycStatus.PENDING_REVIEW);
    expect(resolveKycStatus('UNDER_REVIEW')).toBe(KycStatus.PENDING_REVIEW);
    expect(resolveKycStatus('VERIFIED')).toBe(KycStatus.APPROVED);
    expect(resolveKycStatus('APPROVED')).toBe(KycStatus.APPROVED);
  });

  it('returns business-facing KYC status names for API/UI responses', () => {
    expect(toBusinessStatus(KycStatus.PENDING_UPLOAD)).toBe('DRAFT');
    expect(toBusinessStatus(KycStatus.PENDING_REVIEW)).toBe('UNDER_REVIEW');
    expect(toBusinessStatus(KycStatus.APPROVED)).toBe('VERIFIED');
    expect(toBusinessStatus(KycStatus.REJECTED)).toBe('REJECTED');
  });

  it('ships forward-only ODPC document metadata migration', () => {
    const sql = readMigration('20260520231000_add_odpc_compliance_fields/migration.sql');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "consent_timestamp"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "retention_until"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "data_classification"');
    expect(sql).toContain('"Document_retention_cleanup_idx"');
  });

  it('ships feature-flag-aware RLS policies for tenant-scoped tables', () => {
    const sql = readMigration('20260520232000_add_rls_and_audit_immutability/migration.sql');

    for (const table of ['Document', 'Member', 'Account']) {
      expect(sql).toContain(`ALTER TABLE "public"."${table}" ENABLE ROW LEVEL SECURITY`);
    }

    expect(sql).toContain("current_setting('app.rls_enabled', true)");
    expect(sql).toContain("current_setting('app.current_tenant_id', true)");
    expect(sql).toContain('WITH CHECK');
  });

  it('ships database-level AuditLog immutability trigger', () => {
    const sql = readMigration('20260520232000_add_rls_and_audit_immutability/migration.sql');

    expect(sql).toContain('prevent_auditlog_modification');
    expect(sql).toContain('AUDIT_IMMUTABLE');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "public"."AuditLog"');
    expect(sql).toContain('REVOKE UPDATE, DELETE ON "public"."AuditLog"');
  });
});

function readMigration(relativePath: string): string {
  return readFileSync(join(backendRoot, 'src/prisma/migrations', relativePath), 'utf8');
}
