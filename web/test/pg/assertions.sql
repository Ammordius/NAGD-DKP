\set ON_ERROR_STOP on

-- Fixed identities. handle_new_user creates each profile as a player.
INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'player@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'officer@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'officer2@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'admin1@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'admin2@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'player2@example.com');

UPDATE public.profiles SET role = 'officer' WHERE id = '22222222-2222-4222-8222-222222222222';
UPDATE public.profiles SET role = 'officer' WHERE id = '66666666-6666-4666-8666-666666666666';
UPDATE public.profiles SET role = 'siteadmin' WHERE id = '33333333-3333-4333-8333-333333333333';
UPDATE public.profiles SET role = 'siteadmin' WHERE id = '44444444-4444-4444-8444-444444444444';

INSERT INTO public.accounts (account_id, display_name) VALUES ('acct-keep', 'Kept');
INSERT INTO public.characters (char_id, name) VALUES ('char-keep', 'Kept');
INSERT INTO public.character_account (char_id, account_id) VALUES ('char-keep', 'acct-keep');
UPDATE public.profiles
SET account_id = 'acct-keep'
WHERE id = '55555555-5555-4555-8555-555555555555';

INSERT INTO public.officer_audit_log (actor_id, action, target_type, target_id, delta)
VALUES ('55555555-5555-4555-8555-555555555555', 'note', 'profile', 'kept', '{}'::jsonb);

CREATE OR REPLACE FUNCTION public._expect_error(p_sql text, p_like text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'expected error matching %, but statement succeeded: %', p_like, p_sql;
EXCEPTION
  WHEN OTHERS THEN
    IF SQLSTATE = 'P0001' AND SQLERRM LIKE 'expected error matching %' THEN
      RAISE;
    END IF;
    IF SQLERRM ILIKE p_like OR SQLSTATE = p_like THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'expected %, got % (%): %', p_like, SQLSTATE, SQLERRM, p_sql;
END;
$$;

DO $$
DECLARE
  fn text;
  browser_denied text[] := ARRAY[
    'public.truncate_dkp_for_restore()',
    'public.begin_restore_load()',
    'public.end_restore_load()',
    'public.fix_serial_sequences_for_restore()',
    'public.delete_raid_for_reupload(text)',
    'public.insert_raid_event_attendance_for_upload(text,jsonb)',
    'public.refresh_all_raid_attendance_totals()',
    'public.refresh_dkp_summary_internal()',
    'public.refresh_account_dkp_summary_internal()',
    'public.refresh_raid_attendance_totals(text)',
    'public.apply_earned_deltas(jsonb)',
    'public.apply_spent_deltas(jsonb,text,date[])',
    'public.refresh_character_dkp_spent()',
    'public.update_raid_loot_assignments(jsonb)',
    'public.update_raid_event_times(jsonb)',
    'public.refresh_after_bulk_loot_assignment()',
    'public.profiles_role_guard()'
  ];
  service_kept text[] := ARRAY[
    'public.truncate_dkp_for_restore()',
    'public.begin_restore_load()',
    'public.end_restore_load()',
    'public.fix_serial_sequences_for_restore()',
    'public.delete_raid_for_reupload(text)',
    'public.insert_raid_event_attendance_for_upload(text,jsonb)',
    'public.update_raid_event_times(jsonb)',
    'public.refresh_all_raid_attendance_totals()',
    'public.update_raid_loot_assignments(jsonb)',
    'public.refresh_after_bulk_loot_assignment()',
    'public.refresh_dkp_summary()'
  ];
BEGIN
  IF has_function_privilege('public', 'public.truncate_dkp_for_restore()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC can execute truncate_dkp_for_restore';
  END IF;
  FOREACH fn IN ARRAY browser_denied LOOP
    IF has_function_privilege('anon', fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', fn;
    END IF;
    IF has_function_privilege('authenticated', fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can execute %', fn;
    END IF;
  END LOOP;
  FOREACH fn IN ARRAY service_kept LOOP
    IF NOT has_function_privilege('service_role', fn::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.refresh_dkp_summary()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute refresh_dkp_summary';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.refresh_dkp_summary()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute refresh_dkp_summary';
  END IF;
  IF has_function_privilege('service_role', 'public.apply_earned_deltas(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role can execute apply_earned_deltas';
  END IF;
  IF has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     OR has_table_privilege('anon', 'public.profiles', 'UPDATE')
     OR has_table_privilege('service_role', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION 'a browser or service role still has UPDATE on profiles';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated cannot select profiles';
  END IF;
  IF has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated can update profiles.role';
  END IF;
END $$;

SET SESSION AUTHORIZATION anon;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT public._expect_error('SELECT public.truncate_dkp_for_restore()', '42501');
SELECT public._expect_error('SELECT public.begin_restore_load()', '42501');
SELECT public._expect_error('SELECT public.refresh_dkp_summary()', '42501');
SELECT public._expect_error('SELECT public.account_claim_labels()', '42501');

RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public._expect_error('SELECT public.truncate_dkp_for_restore()', '42501');
SELECT public._expect_error('SELECT public.begin_restore_load()', '42501');
SELECT public._expect_error('SELECT public.end_restore_load()', '42501');
SELECT public._expect_error('SELECT public.delete_raid_for_reupload(''raid-1'')', '42501');
SELECT public._expect_error('SELECT public.insert_raid_event_attendance_for_upload(''raid-1'', ''[]''::jsonb)', '42501');
SELECT public._expect_error('SELECT public.update_raid_loot_assignments(''[]''::jsonb)', '42501');
SELECT public._expect_error('SELECT public.apply_earned_deltas(''[]''::jsonb)', '42501');
SELECT public._expect_error('SELECT public.refresh_dkp_summary()', '%Only officers can refresh DKP summary%');
SELECT public._expect_error(
  'SELECT public.siteadmin_set_role(''22222222-2222-4222-8222-222222222222''::uuid, ''siteadmin'')',
  '%Only site admins can change roles%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_claim_profile(''22222222-2222-4222-8222-222222222222''::uuid, ''acct-keep'')',
  '%Only site admins can claim an account for a profile%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_delete_user(''55555555-5555-4555-8555-555555555555''::uuid)',
  '%Only officers and site admins%'
);
SELECT public._expect_error('SELECT public.delete_raid(''missing'')', '%Only officers can delete raids%');

RESET SESSION AUTHORIZATION;
GRANT UPDATE ON TABLE public.profiles TO authenticated;
SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public._expect_error(
  'UPDATE public.profiles SET role = ''siteadmin'' WHERE id = ''11111111-1111-4111-8111-111111111111''',
  '%dedicated function%'
);
SELECT public._expect_error(
  'UPDATE public.profiles SET account_id = ''acct-keep'' WHERE id = ''11111111-1111-4111-8111-111111111111''',
  '%dedicated function%'
);
SELECT public._expect_error(
  'UPDATE public.profiles SET email = ''stolen@example.com'' WHERE id = ''11111111-1111-4111-8111-111111111111''',
  '%dedicated function%'
);
SELECT public._expect_error(
  'UPDATE public.profiles SET unclaim_count = 7 WHERE id = ''11111111-1111-4111-8111-111111111111''',
  '%dedicated function%'
);
SELECT public._expect_error(
  'UPDATE public.profiles SET unclaim_cooldown_until = ''2000-01-01''::timestamptz WHERE id = ''11111111-1111-4111-8111-111111111111''',
  '%dedicated function%'
);
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
SELECT public._expect_error(
  'UPDATE public.profiles SET account_id = ''acct-keep'' WHERE id = ''11111111-1111-4111-8111-111111111111''',
  '%dedicated function%'
);
SELECT public._expect_error(
  'UPDATE public.profiles SET role = ''siteadmin'' WHERE id = ''11111111-1111-4111-8111-111111111111''',
  '%dedicated function%'
);

RESET SESSION AUTHORIZATION;
REVOKE UPDATE ON TABLE public.profiles FROM authenticated;

-- Officer cannot demote, delete an officer, or delete a site admin.
SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
DO $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'officer is not recognized by is_officer()';
  END IF;
END $$;
SELECT public._expect_error(
  'SELECT public.siteadmin_set_role(''11111111-1111-4111-8111-111111111111''::uuid, ''officer'')',
  '%Only site admins can change roles%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_claim_profile(''11111111-1111-4111-8111-111111111111''::uuid, ''acct-keep'')',
  '%Only site admins can claim an account for a profile%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_delete_user(''66666666-6666-4666-8666-666666666666''::uuid)',
  '%Officers cannot remove other officers%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_delete_user(''33333333-3333-4333-8333-333333333333''::uuid)',
  '%Site admins cannot be removed%'
);
SELECT public.is_officer();

-- Site admin cannot change their own role or delete a site admin.
SELECT set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
DO $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'site admin is not treated as an officer';
  END IF;
END $$;
SELECT public._expect_error(
  'SELECT public.siteadmin_set_role(''33333333-3333-4333-8333-333333333333''::uuid, ''officer'')',
  '%cannot change your own role%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_delete_user(''44444444-4444-4444-8444-444444444444''::uuid)',
  '%Site admins cannot be removed%'
);

-- Demote the officer and require the next check to see it.
SELECT public.siteadmin_set_role('22222222-2222-4222-8222-222222222222'::uuid, 'player');
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
DO $$
BEGIN
  IF public.is_officer() THEN
    RAISE EXCEPTION 'demoted officer is still an officer';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
SELECT public.siteadmin_set_role('22222222-2222-4222-8222-222222222222'::uuid, 'officer');

-- After one site admin demotes the other, the demoted admin cannot remove the last one.
SELECT public.siteadmin_set_role('44444444-4444-4444-8444-444444444444'::uuid, 'officer');
SELECT set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', false);
SELECT public._expect_error(
  'SELECT public.siteadmin_set_role(''33333333-3333-4333-8333-333333333333''::uuid, ''player'')',
  '%Only site admins can change roles%'
);
SELECT set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
SELECT public.siteadmin_set_role('44444444-4444-4444-8444-444444444444'::uuid, 'siteadmin');

-- Player claim still works through the RPC, including the column guard.
RESET SESSION AUTHORIZATION;
INSERT INTO public.accounts (account_id, display_name) VALUES ('acct-claim', 'Claim');
SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.claim_account('acct-claim');
DO $$
BEGIN
  IF (SELECT account_id FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111')
     IS DISTINCT FROM 'acct-claim' THEN
    RAISE EXCEPTION 'claim_account did not set account_id';
  END IF;
END $$;
SELECT public.unclaim_account();
DO $$
BEGIN
  IF (SELECT account_id FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111')
     IS NOT NULL THEN
    RAISE EXCEPTION 'unclaim_account left account_id set';
  END IF;
  IF COALESCE((SELECT unclaim_count FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111'), 0) < 1 THEN
    RAISE EXCEPTION 'unclaim_account did not record unclaim_count';
  END IF;
END $$;

-- Site admin claims an unclaimed account for a player who is still on cooldown.
SELECT set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);
SELECT public.siteadmin_claim_profile('11111111-1111-4111-8111-111111111111'::uuid, 'acct-claim');
DO $$
BEGIN
  IF (SELECT account_id FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111')
     IS DISTINCT FROM 'acct-claim' THEN
    RAISE EXCEPTION 'siteadmin_claim_profile did not set account_id';
  END IF;
  IF (SELECT unclaim_cooldown_until FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111') IS NULL THEN
    RAISE EXCEPTION 'siteadmin_claim_profile cleared the unclaim cooldown';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.officer_audit_log
    WHERE action = 'siteadmin_claim_profile'
      AND target_id = '11111111-1111-4111-8111-111111111111'
      AND actor_id = '33333333-3333-4333-8333-333333333333'
      AND delta->>'account_id' = 'acct-claim'
  ) THEN
    RAISE EXCEPTION 'siteadmin_claim_profile did not write an audit row';
  END IF;
END $$;
SELECT public._expect_error(
  'SELECT public.siteadmin_claim_profile(''22222222-2222-4222-8222-222222222222''::uuid, ''acct-claim'')',
  '%already claimed%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_claim_profile(''22222222-2222-4222-8222-222222222222''::uuid, ''missing-acct'')',
  '%Account not found%'
);
SELECT public._expect_error(
  'SELECT public.siteadmin_claim_profile(''55555555-5555-4555-8555-555555555555''::uuid, ''acct-keep'')',
  '%already has a claimed account%'
);

-- Authorize deletion without removing the profile, then cascade from auth.users.
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
SELECT public.siteadmin_delete_user('55555555-5555-4555-8555-555555555555'::uuid);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = '55555555-5555-4555-8555-555555555555'
  ) THEN
    RAISE EXCEPTION 'siteadmin_delete_user removed the profile before Auth deletion';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.officer_audit_log
    WHERE action = 'siteadmin_delete_user'
      AND target_id = '55555555-5555-4555-8555-555555555555'
      AND actor_id = '22222222-2222-4222-8222-222222222222'
      AND delta->>'auth_delete' = 'pending'
  ) THEN
    RAISE EXCEPTION 'pending deletion audit was not written';
  END IF;
END $$;

RESET SESSION AUTHORIZATION;
DELETE FROM auth.users WHERE id = '55555555-5555-4555-8555-555555555555';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = '55555555-5555-4555-8555-555555555555') THEN
    RAISE EXCEPTION 'deleting auth.users did not cascade the profile';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE account_id = 'acct-keep') THEN
    RAISE EXCEPTION 'auth deletion removed the game account';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.character_account WHERE char_id = 'char-keep' AND account_id = 'acct-keep'
  ) THEN
    RAISE EXCEPTION 'auth deletion removed the character link';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.officer_audit_log
    WHERE action = 'note' AND target_id = 'kept' AND actor_id IS NULL
  ) THEN
    RAISE EXCEPTION 'audit row was deleted with the auth user';
  END IF;
END $$;

SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.siteadmin_confirm_auth_deleted('55555555-5555-4555-8555-555555555555'::uuid);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.officer_audit_log
    WHERE action = 'siteadmin_delete_user'
      AND target_id = '55555555-5555-4555-8555-555555555555'
      AND delta->>'auth_delete' = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'deletion audit was not marked succeeded';
  END IF;
END $$;

RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION service_role;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'service_role', false);
BEGIN;
SELECT public.begin_restore_load();
SELECT public.truncate_dkp_for_restore();
ROLLBACK;
RESET SESSION AUTHORIZATION;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.restore_in_progress WHERE id = 1 AND in_progress) THEN
    RAISE EXCEPTION 'rolled-back begin_restore_load left the restore flag set';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE account_id = 'acct-keep') THEN
    RAISE EXCEPTION 'rolled-back truncate removed a game account';
  END IF;
END $$;

-- Website settings belong to the signed-in user and do not change role or grants.
DO $$
BEGIN
  IF (SELECT ui_preferences FROM public.profiles WHERE id = '66666666-6666-4666-8666-666666666666')
     IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'a profile that has not saved settings should store {}';
  END IF;
END $$;

SET SESSION AUTHORIZATION anon;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT set_config('request.jwt.claim.role', 'anon', false);
SELECT public._expect_error(
  'SELECT public.set_my_ui_preferences(''{}''::jsonb)',
  '42501'
);

RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.set_my_ui_preferences('{"showTicCharacterPicker": false}'::jsonb);
SELECT public.set_my_ui_preferences('{"raidNameOnly": false}'::jsonb);
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
SELECT public.set_my_ui_preferences('{"useCharacterAdminSelectors": false}'::jsonb);
SELECT public._expect_error(
  'SELECT public.set_my_ui_preferences(''{"role": "siteadmin"}''::jsonb)',
  '%Unknown preference%'
);
SELECT public._expect_error(
  'SELECT public.set_my_ui_preferences(''{"showTicCharacterPicker": "yes"}''::jsonb)',
  '%must be true or false%'
);
SELECT public._expect_error(
  'UPDATE public.profiles SET ui_preferences = ''{"showTicCharacterPicker": false}''::jsonb WHERE id = ''22222222-2222-4222-8222-222222222222''',
  '42501'
);
SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SELECT public._expect_error(
  'SELECT public.delete_raid(''missing'')',
  '%Only officers can delete raids%'
);

RESET SESSION AUTHORIZATION;
DO $$
BEGIN
  IF (SELECT role FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111') <> 'player' THEN
    RAISE EXCEPTION 'saving website settings changed the player role';
  END IF;
  IF (SELECT role FROM public.profiles WHERE id = '22222222-2222-4222-8222-222222222222') <> 'officer' THEN
    RAISE EXCEPTION 'saving website settings changed the officer role';
  END IF;
  IF (SELECT ui_preferences FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111')
     IS DISTINCT FROM '{"showTicCharacterPicker": false, "raidNameOnly": false}'::jsonb THEN
    RAISE EXCEPTION 'player preferences were not merged';
  END IF;
  IF (SELECT ui_preferences FROM public.profiles WHERE id = '22222222-2222-4222-8222-222222222222')
     IS DISTINCT FROM '{"useCharacterAdminSelectors": false}'::jsonb THEN
    RAISE EXCEPTION 'officer preferences leaked or were overwritten';
  END IF;
  IF has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     OR has_table_privilege('anon', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION 'website settings reopened UPDATE on profiles';
  END IF;
END $$;

RESET SESSION AUTHORIZATION;
UPDATE public.profiles
SET ui_preferences = '{"useCharacterAdminSelectors": false, "timeZone": "Pacific/Auckland"}'::jsonb
WHERE id = '22222222-2222-4222-8222-222222222222';

SET SESSION AUTHORIZATION authenticated;
SELECT set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', false);
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public._expect_error(
  'SELECT public.set_my_ui_preferences(''{"timeZone": "Pacific/Auckland"}''::jsonb)',
  '%Unknown preference%'
);
SELECT public.set_my_ui_preferences('{"showTicCharacterPicker": false}'::jsonb);

RESET SESSION AUTHORIZATION;
DO $$
BEGIN
  IF (SELECT ui_preferences FROM public.profiles WHERE id = '22222222-2222-4222-8222-222222222222')
     IS DISTINCT FROM '{"showTicCharacterPicker": false, "useCharacterAdminSelectors": false}'::jsonb THEN
    RAISE EXCEPTION 'a saved timezone was kept with raid settings';
  END IF;
  IF (SELECT ui_preferences FROM public.profiles WHERE id = '11111111-1111-4111-8111-111111111111') ? 'timeZone' THEN
    RAISE EXCEPTION 'dropping an officer timezone changed the player profile';
  END IF;
END $$;

RESET SESSION AUTHORIZATION;

-- Test helper for the concurrent demotion. Lives only in the disposable database.
CREATE OR REPLACE FUNCTION public._demote_holding_lock(p_actor uuid, p_target uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM id FROM public.profiles WHERE role = 'siteadmin' ORDER BY id FOR UPDATE;
  PERFORM pg_sleep(8);
  PERFORM public.siteadmin_set_role(p_target, 'officer');
END;
$$;
