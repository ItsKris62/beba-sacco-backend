-- Phase 3 Hardening: Enforce strict immutability on audit_logs at the database layer.
-- Doing nothing effectively prevents the operation while causing Prisma to throw a 
-- RecordNotFound exception (since 0 rows are affected), satisfying the integration test constraints.
CREATE RULE no_update_audit_log AS ON UPDATE TO "AuditLog" DO INSTEAD NOTHING;
CREATE RULE no_delete_audit_log AS ON DELETE TO "AuditLog" DO INSTEAD NOTHING;