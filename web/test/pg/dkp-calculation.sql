-- Disposable checks for account DKP. Literals are the expected totals.
-- Assumes docs/supabase-schema-full.sql is already loaded, including the authorization seed
-- (raid-upgrade / acct-upgrade, one tic of 1 and one loot cost of 1, dated 2026-01-01).

CREATE OR REPLACE FUNCTION pg_temp.t3_expect(p_label text, p_got numeric, p_want numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: got %, want %', p_label, p_got, p_want;
  END IF;
END;
$$;

DO $$
DECLARE
  v_day date := current_date;
  v_d30 text := to_char(v_day - 30, 'YYYY-MM-DD');
  v_d31 text := to_char(v_day - 31, 'YYYY-MM-DD');
  v_d61 text := to_char(v_day - 61, 'YYYY-MM-DD');
  v_today text := to_char(v_day, 'YYYY-MM-DD');
  v_seed30 numeric;
  v_seed60 numeric;
  v_earned numeric;
  v_spent numeric;
  v_e30 integer;
  v_e60 integer;
  v_cache numeric;
BEGIN
  INSERT INTO accounts (account_id, display_name) VALUES
    ('t3-a', 'Alpha'),
    ('t3-b', 'Beta'),
    ('t3-alts', 'Alts'),
    ('t3-amb', 'Ambiguous'),
    ('t3-amb2', 'Ambiguous Two'),
    ('t3-win', 'Windows'),
    ('t3-bad', 'Bad Event'),
    ('t3-loot', 'Loot Buyer'),
    ('t3-loot-other', 'Loot Other'),
    ('t3-link', 'Link Later'),
    ('t3-restore', 'Restore');

  INSERT INTO characters (char_id, name) VALUES
    ('t3-c-a', 'SameName'),
    ('t3-c-b', 'SameName'),
    ('t3-alt-1', 'Alt One'),
    ('t3-alt-2', 'Alt Two'),
    ('t3-c-amb', 'Shared'),
    ('t3-c-amb2', 'Shared'),
    ('t3-c-win', 'Window'),
    ('t3-c-bad', 'BadEvent'),
    ('t3-c-loot', 'Buyer'),
    ('t3-c-loot-other', 'Assignee'),
    ('t3-c-link', 'LinkMe'),
    ('t3-c-restore', 'Restored');

  -- Same historical name, different char ids and accounts. Credit follows char id.
  INSERT INTO character_account (char_id, account_id) VALUES
    ('t3-c-a', 't3-a'),
    ('t3-c-b', 't3-b'),
    ('t3-alt-1', 't3-alts'),
    ('t3-alt-2', 't3-alts'),
    ('t3-c-amb', 't3-amb'),
    ('t3-c-amb2', 't3-amb2'),
    ('t3-c-win', 't3-win'),
    ('t3-c-bad', 't3-bad'),
    ('t3-c-loot', 't3-loot'),
    ('t3-c-loot-other', 't3-loot-other');

  INSERT INTO raids (raid_id, raid_name, date_iso) VALUES
    ('t3-names', 'Names', v_today),
    ('t3-alts-raid', 'Alts', v_today),
    ('t3-amb-raid', 'Ambiguous', v_today),
    ('t3-win-30', 'In 30', v_d30),
    ('t3-win-31', 'Out 30', v_d31),
    ('t3-win-61', 'Out 60', v_d61),
    ('t3-bad-raid', 'Bad', v_today),
    ('t3-loot-raid', 'Loot', v_today),
    ('t3-link-raid', 'Link', v_today),
    ('t3-edit-raid', 'Edit', v_today);

  INSERT INTO raid_events (raid_id, event_id, event_order, event_name, dkp_value) VALUES
    ('t3-names', 'e1', 1, 'DKP tic', '4'),
    ('t3-alts-raid', 'e1', 1, 'DKP tic', '4'),
    ('t3-amb-raid', 'e1', 1, 'DKP tic', '9'),
    ('t3-win-30', 'e1', 1, 'DKP tic', '2'),
    ('t3-win-31', 'e1', 1, 'DKP tic', '3'),
    ('t3-win-61', 'e1', 1, 'DKP tic', '7'),
    ('t3-loot-raid', 'e1', 1, 'DKP tic', '1'),
    ('t3-link-raid', 'e1', 1, 'DKP tic', '6'),
    ('t3-edit-raid', 'e1', 1, 'DKP tic', '1');

  INSERT INTO raid_event_attendance (raid_id, event_id, char_id, character_name, account_id) VALUES
    ('t3-names', 'e1', 't3-c-a', 'SameName', NULL),
    ('t3-alts-raid', 'e1', 't3-alt-1', 'Alt One', 't3-alts'),
    ('t3-alts-raid', 'e1', 't3-alt-2', 'Alt Two', 't3-alts'),
    ('t3-amb-raid', 'e1', NULL, 'Shared', NULL),
    ('t3-win-30', 'e1', 't3-c-win', 'Window', 't3-win'),
    ('t3-win-31', 'e1', 't3-c-win', 'Window', 't3-win'),
    ('t3-win-61', 'e1', 't3-c-win', 'Window', 't3-win'),
    ('t3-bad-raid', 'e1', 't3-c-bad', 'BadEvent', 't3-bad'),
    ('t3-link-raid', 'e1', 't3-c-link', 'LinkMe', NULL),
    ('t3-edit-raid', 'e1', 't3-c-a', 'SameName', 't3-a');

  SELECT earned, earned_30d, earned_60d INTO v_earned, v_e30, v_e60
  FROM account_dkp_summary WHERE account_id = 't3-a';
  PERFORM pg_temp.t3_expect('char id beats shared name', v_earned, 5);
  PERFORM pg_temp.t3_expect('shared name does not credit the other account',
    COALESCE((SELECT earned FROM account_dkp_summary WHERE account_id = 't3-b'), 0), 0);

  PERFORM pg_temp.t3_expect('two alts one tic',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-alts'), 4);

  PERFORM pg_temp.t3_expect('ambiguous name-only attendance',
    COALESCE((SELECT earned FROM account_dkp_summary WHERE account_id = 't3-amb'), 0), 0);
  PERFORM pg_temp.t3_expect('ambiguous name-only other account',
    COALESCE((SELECT earned FROM account_dkp_summary WHERE account_id = 't3-amb2'), 0), 0);

  SELECT earned, earned_30d, earned_60d INTO v_earned, v_e30, v_e60
  FROM account_dkp_summary WHERE account_id = 't3-win';
  PERFORM pg_temp.t3_expect('window lifetime', v_earned, 12);
  PERFORM pg_temp.t3_expect('window 30d includes the boundary day', v_e30, 2);
  PERFORM pg_temp.t3_expect('window 60d includes day 31 and day 30', v_e60, 5);

  -- On-time plus DKP under one event id, then a duplicate order/name that must not count.
  INSERT INTO raid_events (raid_id, event_id, event_order, event_name, dkp_value)
  VALUES ('t3-edit-raid', 'e1', 0, 'On-time', '1');
  PERFORM pg_temp.t3_expect('on-time plus dkp',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-a'), 6);

  INSERT INTO raid_events (raid_id, event_id, event_order, event_name, dkp_value)
  VALUES ('t3-edit-raid', 'e1', 1, 'DKP tic', '99');
  PERFORM pg_temp.t3_expect('duplicate order and name counts once',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-a'), 6);

  UPDATE raid_events
  SET dkp_value = '4'
  WHERE raid_id = 't3-edit-raid' AND event_id = 'e1' AND event_name = 'DKP tic' AND dkp_value = '1';
  PERFORM pg_temp.t3_expect('edited tic dkp',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-a'), 9);

  DELETE FROM raid_event_attendance WHERE raid_id = 't3-alts-raid' AND char_id = 't3-alt-2';
  PERFORM pg_temp.t3_expect('one alt removed, account still credited',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-alts'), 4);
  DELETE FROM raid_event_attendance WHERE raid_id = 't3-alts-raid' AND char_id = 't3-alt-1';
  PERFORM pg_temp.t3_expect('last alt removed',
    COALESCE((SELECT earned FROM account_dkp_summary WHERE account_id = 't3-alts'), 0), 0);

  DELETE FROM raid_event_attendance WHERE raid_id = 't3-edit-raid';
  DELETE FROM raid_events WHERE raid_id = 't3-edit-raid';
  PERFORM pg_temp.t3_expect('deleted tic',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-a'), 4);

  INSERT INTO raid_loot (raid_id, event_id, item_name, char_id, character_name, cost)
  VALUES ('t3-loot-raid', 'e1', 'Sword', 't3-c-loot', 'Buyer', '10');
  INSERT INTO loot_assignment (loot_id, assigned_char_id, assigned_character_name)
  SELECT id, 't3-c-loot-other', 'Assignee'
  FROM raid_loot WHERE raid_id = 't3-loot-raid' AND item_name = 'Sword';
  PERFORM pg_temp.t3_expect('loot buyer spent',
    (SELECT spent FROM account_dkp_summary WHERE account_id = 't3-loot'), 10);
  PERFORM pg_temp.t3_expect('assignment does not spend',
    COALESCE((SELECT spent FROM account_dkp_summary WHERE account_id = 't3-loot-other'), 0), 0);

  UPDATE raid_loot SET cost = '12' WHERE raid_id = 't3-loot-raid' AND item_name = 'Sword';
  PERFORM pg_temp.t3_expect('edited loot cost',
    (SELECT spent FROM account_dkp_summary WHERE account_id = 't3-loot'), 12);
  DELETE FROM raid_loot WHERE raid_id = 't3-loot-raid' AND item_name = 'Sword';
  PERFORM pg_temp.t3_expect('deleted loot',
    COALESCE((SELECT spent FROM account_dkp_summary WHERE account_id = 't3-loot'), 0), 0);

  -- Historical attendance with a null account_id credits the account when the character is linked.
  INSERT INTO character_account (char_id, account_id) VALUES ('t3-c-link', 't3-link');
  PERFORM pg_temp.t3_expect('link credits existing attendance',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-link'), 6);

  -- Bulk load with triggers off, then one rebuild. Must not double-count.
  PERFORM public.begin_restore_load();
  INSERT INTO character_account (char_id, account_id) VALUES ('t3-c-restore', 't3-restore');
  INSERT INTO raids (raid_id, raid_name, date_iso) VALUES ('t3-restore-raid', 'Restore', v_today);
  INSERT INTO raid_events (raid_id, event_id, event_order, event_name, dkp_value)
  VALUES ('t3-restore-raid', 'e1', 1, 'DKP tic', '8');
  INSERT INTO raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
  VALUES ('t3-restore-raid', 'e1', 't3-c-restore', 'Restored', 't3-restore');
  INSERT INTO raid_loot (raid_id, event_id, item_name, char_id, character_name, cost)
  VALUES ('t3-restore-raid', 'e1', 'Helm', 't3-c-restore', 'Restored', '3');
  PERFORM pg_temp.t3_expect('restore does not credit before end',
    COALESCE((SELECT earned FROM account_dkp_summary WHERE account_id = 't3-restore'), 0), 0);
  PERFORM public.end_restore_load();
  SELECT earned, spent INTO v_earned, v_spent
  FROM account_dkp_summary WHERE account_id = 't3-restore';
  PERFORM pg_temp.t3_expect('restore earned once', v_earned, 8);
  PERFORM pg_temp.t3_expect('restore spent once', v_spent, 3);
  PERFORM pg_temp.t3_expect('restore leaves earlier account',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-a'), 4);

  -- Stale per-raid cache must not become the summary.
  UPDATE raid_attendance_dkp_by_account
  SET dkp_earned = 999999
  WHERE raid_id = 't3-names' AND account_id = 't3-a';
  PERFORM public.refresh_account_dkp_summary_internal();
  PERFORM pg_temp.t3_expect('corrupt cache does not set earned',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 't3-a'), 4);
  PERFORM pg_temp.t3_expect('internal refresh leaves the corrupt cache',
    (SELECT dkp_earned FROM raid_attendance_dkp_by_account WHERE raid_id = 't3-names' AND account_id = 't3-a'),
    999999);
  PERFORM pg_temp.t3_expect('windows survive full summary rebuild',
    (SELECT earned_30d FROM account_dkp_summary WHERE account_id = 't3-win'), 2);
  PERFORM pg_temp.t3_expect('windows 60d survive full summary rebuild',
    (SELECT earned_60d FROM account_dkp_summary WHERE account_id = 't3-win'), 5);
  PERFORM pg_temp.t3_expect('bad event id earns 0',
    COALESCE((SELECT earned FROM account_dkp_summary WHERE account_id = 't3-bad'), 0), 0);

  INSERT INTO raid_attendance_dkp_by_account (raid_id, account_id, dkp_earned)
  VALUES ('t3-bad-raid', 't3-bad', 50)
  ON CONFLICT (raid_id, account_id) DO UPDATE SET dkp_earned = 50;
  PERFORM public.refresh_all_raid_attendance_totals();
  PERFORM pg_temp.t3_expect('cache rebuild clears a mismatched event id',
    COALESCE((SELECT dkp_earned FROM raid_attendance_dkp_by_account WHERE raid_id = 't3-bad-raid' AND account_id = 't3-bad'), 0),
    0);
  PERFORM pg_temp.t3_expect('cache rebuild matches names tic',
    (SELECT dkp_earned FROM raid_attendance_dkp_by_account WHERE raid_id = 't3-names' AND account_id = 't3-a'),
    4);

  v_seed30 := CASE
    WHEN public.raid_date_parsed('2026-01-01') >= (current_date - 30) THEN 1 ELSE 0
  END;
  v_seed60 := CASE
    WHEN public.raid_date_parsed('2026-01-01') >= (current_date - 60) THEN 1 ELSE 0
  END;
  -- Distinct tics: names 4, alts 4, amb 9, loot 1, link 6, restore 8, win-30 2.
  -- win-31 (3) is inside 60d only. win-61 (7) is outside both. The deleted edit raid is gone.
  -- The seed raid contributes its single tic of 1 only while 2026-01-01 is still inside the window.
  PERFORM pg_temp.t3_expect('30d pool',
    (SELECT total_dkp FROM dkp_period_totals WHERE period = '30d'),
    4 + 4 + 9 + 1 + 6 + 8 + 2 + v_seed30);
  PERFORM pg_temp.t3_expect('60d pool',
    (SELECT total_dkp FROM dkp_period_totals WHERE period = '60d'),
    4 + 4 + 9 + 1 + 6 + 8 + 2 + 3 + v_seed60);

  PERFORM pg_temp.t3_expect('seed account still earned',
    (SELECT earned FROM account_dkp_summary WHERE account_id = 'acct-upgrade'), 1);
  PERFORM pg_temp.t3_expect('seed account still spent',
    (SELECT spent FROM account_dkp_summary WHERE account_id = 'acct-upgrade'), 1);
END;
$$;
