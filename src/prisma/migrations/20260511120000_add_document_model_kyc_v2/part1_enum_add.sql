-- Part 1: Add new KycStatus value. Must commit before Part 2 can reference it.
ALTER TYPE "public"."KycStatus" ADD VALUE IF NOT EXISTS 'PENDING_UPLOAD';
