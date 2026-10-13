-- Officer Audit Log: who, what, when for sensitive officer actions (add raid, edit DKP totals).
--
-- THIS IS NOW IN THE MAIN SCHEMA (docs/supabase-schema.sql). Reapply the main schema to get
-- a current DB including officer_audit_log. You only need this standalone file if you are
-- adding the audit log to an existing DB that was created from an older schema that didn't
-- include it (run this file once in that case).
--
-- HOW THE VIEW IS OFFICER-ONLY:
-- 1. The audit log UI lives only on the Officer page (/officer). The nav "Officer" link is shown
--    only when profile.role = 'officer', and the route redirects non-officers to /.
-- 2. RLS on this table: SELECT and INSERT allowed only when public.is_officer() is true.
--
-- HOW TO GET THE AUDIT VIEW ACTIVE: Run the main schema (supabase-schema.sql), ensure a user
-- has role = 'officer' in profiles, then sign in and go to /officer.

CREATE TABLE IF NOT EXISTS public.officer_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_display_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  delta JSONB
);
ALTER TABLE public.officer_audit_log ADD COLUMN IF NOT EXISTS actor_display_name TEXT;
COMMENT ON TABLE public.officer_audit_log IS 'Audit trail for officer actions: add_raid, edit_event_dkp, edit_event_time, edit_loot_cost. Delta is minimal (short keys) to limit storage and egress.';

CREATE INDEX IF NOT EXISTS officer_audit_log_created_at_desc ON public.officer_audit_log (created_at DESC);
ALTER TABLE public.officer_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Officer audit log select" ON public.officer_audit_log;
CREATE POLICY "Officer audit log select" ON public.officer_audit_log FOR SELECT USING (public.is_officer());
DROP POLICY IF EXISTS "Officer audit log insert" ON public.officer_audit_log;
CREATE POLICY "Officer audit log insert" ON public.officer_audit_log FOR INSERT WITH CHECK (public.is_officer());
