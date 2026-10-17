-- Read-only inventory for a later hosted check.
-- Do not run this against staging or production until that phase is authorized.
-- The statements are SELECT only. They do not insert, update, delete, or change roles.
-- Run them with the session-mode postgres role, port 5432, sslmode=require,
-- and default_transaction_read_only=on.
-- Record server_version before trusting a restore. This repository's tools
-- refuse a server whose major version is not 17.

SELECT current_setting('server_version') AS server_version,
       current_setting('server_version_num')::int AS server_version_num;

SELECT n.nspname AS schema_name
FROM pg_namespace n
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
ORDER BY 1;

SELECT n.nspname AS schema_name,
       c.relname AS relation_name,
       CASE
         WHEN c.relkind = 'r' AND c.relispartition THEN 'partition'
         WHEN c.relkind = 'r' THEN 'table'
         WHEN c.relkind = 'p' THEN 'partitioned_table'
         WHEN c.relkind = 'v' THEN 'view'
         WHEN c.relkind = 'm' THEN 'materialized_view'
         WHEN c.relkind = 'S' THEN 'sequence'
         ELSE c.relkind::text
       END AS object_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname <> 'information_schema'
  AND n.nspname NOT LIKE 'pg_%'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
ORDER BY 1, 2;

SELECT extname, extversion
FROM pg_extension
ORDER BY 1;

SELECT pubname, schemaname, tablename
FROM pg_publication_tables
ORDER BY 1, 2, 3;

SELECT rolname, rolcanlogin, rolbypassrls
FROM pg_roles
WHERE rolname !~ '^pg_'
ORDER BY 1;

-- Presence of operational subsystems. Zero rows means the schema is not installed.
SELECT n.nspname
FROM pg_namespace n
WHERE n.nspname IN ('cron', 'net', 'pgmq', 'supabase_functions', 'vault', 'auth', 'storage', 'realtime')
ORDER BY 1;
