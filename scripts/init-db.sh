#!/bin/bash
# Runs once when the Postgres container is first initialized.
# Creates extensions required by Prisma and the application.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- UUID generation (used by Prisma @default(uuid()))
  CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

  -- Case-insensitive text (used by Prisma insensitive mode indexes)
  CREATE EXTENSION IF NOT EXISTS "citext";

  -- pg_trgm for faster LIKE/ILIKE queries on member search
  CREATE EXTENSION IF NOT EXISTS "pg_trgm";
EOSQL

echo "Database extensions installed."
