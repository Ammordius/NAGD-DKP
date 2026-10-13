-- Rollback test for officer_set_account_display_name.
-- Run this entire script in the Supabase SQL editor after
-- docs/sql-archive/superseded/supabase-officer-set-account-display-name.sql.
-- It inserts fixtures, asserts, and rolls everything back.
-- If an assertion fails, run ROLLBACK before doing anything else.

BEGIN;

DO $test$
DECLARE
  v_officer uuid := '11111111-1111-4111-8111-111111111111';
  v_player uuid := '22222222-2222-4222-8222-222222222222';
  v_target text := 'dn-test-target';
  v_other text := 'dn-test-other';
  v_officer_account text := 'dn-test-officer';
  v_char text := 'dn-test-char';
  v_other_char text := 'dn-test-other-char';
  v_summary_updated timestamptz := '2026-02-01 00:00:00+00';
  v_other_summary_updated timestamptz := '2026-03-01 00:00:00+00';
  v_loot_id bigint;
  v_attendance_id bigint;
  v_event_attendance_id bigint;
  v_earned numeric;
  v_spent numeric;
  v_earned_30d integer;
  v_earned_60d integer;
  v_last_activity date;
  v_summary_updated_at timestamptz;
  v_other_earned numeric;
  v_other_spent numeric;
  v_other_name text;
  v_links text;
  v_loot_cost text;
  v_loot_char text;
  v_loot_name text;
  v_att_char text;
  v_att_name text;
  v_event_account text;
  v_event_name text;
  v_officer_role text;
  v_officer_account_id text;
  v_player_role text;
  v_player_account_id text;
  v_toon_names text;
  v_toon_count integer;
  v_char_ids text;
  v_audit_count integer;
  v_raised boolean;
  v_name text;
BEGIN
  INSERT INTO public.accounts (account_id, display_name, toon_names, toon_count, char_ids, inactive)
  VALUES
    (v_officer_account, 'Officer Label', 'Officer', 1, NULL, false),
    (v_target, 'Old Name', 'Keep Toons', 2, 'keep-ids', false),
    (v_other, 'Other Account', 'Other', 1, NULL, false);

  INSERT INTO public.characters (char_id, name) VALUES
    (v_char, 'New Name'),
    (v_other_char, 'Other Name');

  INSERT INTO public.character_account (char_id, account_id) VALUES
    (v_char, v_target),
    (v_other_char, v_other);

  INSERT INTO public.account_dkp_summary (
    account_id, display_name, earned, spent, earned_30d, earned_60d, last_activity_date, updated_at
  ) VALUES
    (v_target, 'Old Name', 123, 45, 10, 20, '2026-01-15', v_summary_updated),
    (v_other, 'Other Account', 7, 3, 1, 2, '2026-01-01', v_other_summary_updated);

  INSERT INTO public.raids (raid_id, raid_name) VALUES ('dn-test-raid', 'Display name test');

  INSERT INTO public.raid_attendance (raid_id, char_id, character_name)
  VALUES ('dn-test-raid', v_char, 'New Name')
  RETURNING id INTO v_attendance_id;

  INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
  VALUES ('dn-test-raid', 'dn-test-event', v_char, 'New Name', v_target)
  RETURNING id INTO v_event_attendance_id;

  INSERT INTO public.raid_loot (raid_id, event_id, item_name, char_id, character_name, cost)
  VALUES ('dn-test-raid', 'dn-test-event', 'Test Item', v_char, 'New Name', '50')
  RETURNING id INTO v_loot_id;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, confirmation_token, recovery_token,
    email_change_token_new, email_change, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    is_sso_user, is_anonymous
  ) VALUES
    (
      '00000000-0000-0000-0000-000000000000', v_officer, 'authenticated', 'authenticated',
      'dn-test-officer@example.invalid', '', now(),
      '', '', '', '', '', '', '', '',
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), false, false
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_player, 'authenticated', 'authenticated',
      'dn-test-player@example.invalid', '', now(),
      '', '', '', '', '', '', '', '',
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), false, false
    );

  INSERT INTO public.profiles (id, email, role, account_id)
  VALUES
    (v_officer, 'dn-test-officer@example.invalid', 'officer', v_officer_account),
    (v_player, 'dn-test-player@example.invalid', 'player', v_other)
  ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email,
      role = EXCLUDED.role,
      account_id = EXCLUDED.account_id;

  SELECT s.earned, s.spent, s.earned_30d, s.earned_60d, s.last_activity_date, s.updated_at
  INTO v_earned, v_spent, v_earned_30d, v_earned_60d, v_last_activity, v_summary_updated_at
  FROM public.account_dkp_summary s
  WHERE s.account_id = v_target;

  SELECT s.earned, s.spent, s.display_name
  INTO v_other_earned, v_other_spent, v_other_name
  FROM public.account_dkp_summary s
  WHERE s.account_id = v_other;

  SELECT string_agg(ca.char_id || ':' || ca.account_id, ',' ORDER BY ca.char_id, ca.account_id)
  INTO v_links
  FROM public.character_account ca
  WHERE ca.account_id IN (v_target, v_other, v_officer_account);

  SELECT cost, char_id, character_name
  INTO v_loot_cost, v_loot_char, v_loot_name
  FROM public.raid_loot WHERE id = v_loot_id;

  SELECT char_id, character_name
  INTO v_att_char, v_att_name
  FROM public.raid_attendance WHERE id = v_attendance_id;

  SELECT account_id, character_name
  INTO v_event_account, v_event_name
  FROM public.raid_event_attendance WHERE id = v_event_attendance_id;

  PERFORM set_config('request.jwt.claim.sub', v_officer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_officer, 'role', 'authenticated')::text,
    true
  );

  v_raised := false;
  BEGIN
    PERFORM public.officer_set_account_display_name(v_target, 'dn-test-missing');
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%Character is not linked to this account%' THEN
        RAISE;
      END IF;
      v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'unknown character id was accepted';
  END IF;

  v_raised := false;
  BEGIN
    PERFORM public.officer_set_account_display_name(v_target, v_other_char);
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%Character is not linked to this account%' THEN
        RAISE;
      END IF;
      v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'cross-account character was accepted';
  END IF;

  SELECT display_name INTO v_name FROM public.accounts WHERE account_id = v_target;
  IF v_name IS DISTINCT FROM 'Old Name' THEN
    RAISE EXCEPTION 'failed selection changed display_name to %', v_name;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', v_player::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_player, 'role', 'authenticated')::text,
    true
  );
  v_raised := false;
  BEGIN
    PERFORM public.officer_set_account_display_name(v_target, v_char);
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%Only officers can change account display names%' THEN
        RAISE;
      END IF;
      v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'player write was accepted';
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);
  v_raised := false;
  BEGIN
    UPDATE public.accounts SET display_name = 'Arbitrary' WHERE account_id = v_target;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM NOT ILIKE '%Display name can only be changed by selecting a linked character%' THEN
        RAISE;
      END IF;
      v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'direct display_name update was accepted';
  END IF;

  UPDATE public.accounts SET inactive = true WHERE account_id = v_target;
  UPDATE public.accounts SET inactive = false WHERE account_id = v_target;

  PERFORM set_config('request.jwt.claim.sub', v_officer::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', v_officer, 'role', 'authenticated')::text,
    true
  );

  PERFORM public.officer_set_account_display_name(v_target, v_char);

  SELECT display_name, toon_names, toon_count, char_ids
  INTO v_name, v_toon_names, v_toon_count, v_char_ids
  FROM public.accounts WHERE account_id = v_target;
  IF v_name IS DISTINCT FROM 'New Name' THEN
    RAISE EXCEPTION 'display_name is %', v_name;
  END IF;
  IF v_toon_names IS DISTINCT FROM 'Keep Toons' OR v_toon_count IS DISTINCT FROM 2 OR v_char_ids IS DISTINCT FROM 'keep-ids' THEN
    RAISE EXCEPTION 'account ownership fields changed';
  END IF;

  IF (SELECT display_name FROM public.account_dkp_summary WHERE account_id = v_target) IS DISTINCT FROM 'New Name' THEN
    RAISE EXCEPTION 'summary label was not updated';
  END IF;

  IF (
    SELECT earned IS DISTINCT FROM v_earned
      OR spent IS DISTINCT FROM v_spent
      OR earned_30d IS DISTINCT FROM v_earned_30d
      OR earned_60d IS DISTINCT FROM v_earned_60d
      OR last_activity_date IS DISTINCT FROM v_last_activity
      OR updated_at IS DISTINCT FROM v_summary_updated_at
    FROM public.account_dkp_summary
    WHERE account_id = v_target
  ) THEN
    RAISE EXCEPTION 'DKP summary totals changed';
  END IF;

  IF (
    SELECT earned IS DISTINCT FROM v_other_earned
      OR spent IS DISTINCT FROM v_other_spent
      OR display_name IS DISTINCT FROM v_other_name
    FROM public.account_dkp_summary
    WHERE account_id = v_other
  ) THEN
    RAISE EXCEPTION 'another account summary changed';
  END IF;

  IF (
    SELECT string_agg(ca.char_id || ':' || ca.account_id, ',' ORDER BY ca.char_id, ca.account_id)
    FROM public.character_account ca
    WHERE ca.account_id IN (v_target, v_other, v_officer_account)
  ) IS DISTINCT FROM v_links THEN
    RAISE EXCEPTION 'character links changed';
  END IF;

  IF (
    SELECT cost IS DISTINCT FROM v_loot_cost
      OR char_id IS DISTINCT FROM v_loot_char
      OR character_name IS DISTINCT FROM v_loot_name
    FROM public.raid_loot WHERE id = v_loot_id
  ) THEN
    RAISE EXCEPTION 'loot row changed';
  END IF;

  IF (
    SELECT char_id IS DISTINCT FROM v_att_char OR character_name IS DISTINCT FROM v_att_name
    FROM public.raid_attendance WHERE id = v_attendance_id
  ) THEN
    RAISE EXCEPTION 'raid attendance changed';
  END IF;

  IF (
    SELECT account_id IS DISTINCT FROM v_event_account OR character_name IS DISTINCT FROM v_event_name
    FROM public.raid_event_attendance WHERE id = v_event_attendance_id
  ) THEN
    RAISE EXCEPTION 'event attendance changed';
  END IF;

  SELECT role, account_id INTO v_officer_role, v_officer_account_id
  FROM public.profiles WHERE id = v_officer;
  SELECT role, account_id INTO v_player_role, v_player_account_id
  FROM public.profiles WHERE id = v_player;
  IF v_officer_role IS DISTINCT FROM 'officer' OR v_officer_account_id IS DISTINCT FROM v_officer_account THEN
    RAISE EXCEPTION 'officer profile changed';
  END IF;
  IF v_player_role IS DISTINCT FROM 'player' OR v_player_account_id IS DISTINCT FROM v_other THEN
    RAISE EXCEPTION 'player profile changed';
  END IF;

  SELECT count(*) INTO v_audit_count
  FROM public.officer_audit_log
  WHERE action = 'set_account_display_name'
    AND target_type = 'account'
    AND target_id = v_target
    AND actor_id = v_officer
    AND actor_email = 'dn-test-officer@example.invalid'
    AND actor_display_name = 'Officer Label'
    AND delta->>'previous_display_name' = 'Old Name'
    AND delta->>'new_display_name' = 'New Name'
    AND delta->>'char_id' = v_char
    AND created_at IS NOT NULL
    AND created_at > now() - interval '5 minutes';
  IF v_audit_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'expected one audit row, found %', v_audit_count;
  END IF;
END
$test$;

ROLLBACK;
