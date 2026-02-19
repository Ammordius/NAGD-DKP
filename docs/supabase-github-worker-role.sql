-- GitHub worker role: scoped access for CI (DB backup + loot-to-character). No direct write to raid_loot;
-- assignments go through update_raid_loot_assignments (writes loot_assignment only).
-- Run after supabase-schema.sql and supabase-loot-assignment-table.sql (so update_raid_loot_assignments exists).
--
-- Use via JWT: generate a JWT with payload {"role": "github_worker", "iss": "supabase", "iat": <unix_ts>}
-- signed with your project JWT Secret (Dashboard -> Project Settings -> API). Use that token as
-- SUPABASE_SERVICE_ROLE_KEY in GitHub Actions so CI runs with least privilege. See docs/MIRROR-SETUP-FULL-STACK.md.

-- 1. Create the role (NOLOGIN: Supabase API assumes this role when the JWT has role=github_worker)
CREATE ROLE github_worker NOLOGIN BYPASSRLS;

-- 2. Schema access
GRANT USAGE ON SCHEMA public TO github_worker;

-- 3. Read-only on all current tables and views (for backup export and fetch_raid_loot)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO github_worker;

-- 4. Run character assigner: only this RPC (writes loot_assignment via SECURITY DEFINER)
GRANT EXECUTE ON FUNCTION public.update_raid_loot_assignments(jsonb) TO github_worker;
GRANT EXECUTE ON FUNCTION public.refresh_after_bulk_loot_assignment() TO github_worker;

-- 5. Loot-to-character CI: replace character_loot_assignment_counts (delete + insert)
GRANT INSERT, DELETE ON public.character_loot_assignment_counts TO github_worker;

-- 6. Loot-to-character CI: update character level/class from Magelo (update_character_levels_from_magelo.py)
GRANT UPDATE ON public.characters TO github_worker;

-- 7. Future tables/views created by postgres get SELECT automatically
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO github_worker;

COMMENT ON ROLE github_worker IS 'For GitHub Actions (JWT role=github_worker): SELECT all tables, EXECUTE update_raid_loot_assignments/refresh_after_bulk_loot_assignment, INSERT/DELETE character_loot_assignment_counts, UPDATE characters. No direct write to raid_loot.';
