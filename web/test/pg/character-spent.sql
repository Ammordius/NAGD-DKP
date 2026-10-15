-- Incremental character_dkp_spent versus refresh_character_dkp_spent.
-- A zero total stays. Deleting it would drop a character who still has zero-cost loot,
-- and the full rebuild inserts that row.

CREATE OR REPLACE FUNCTION pg_temp.expect_spent(p_label text, p_key text, p_want numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_got numeric;
BEGIN
  SELECT total_spent INTO v_got
  FROM character_dkp_spent
  WHERE character_key = p_key;
  IF p_want IS NULL THEN
    IF v_got IS NOT NULL THEN
      RAISE EXCEPTION '%: % exists with %, want no row', p_label, p_key, v_got;
    END IF;
  ELSIF v_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '%: % got %, want %', p_label, p_key, v_got, p_want;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_matches_refresh(p_label text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_mismatch text;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS spent_incremental (
    character_key text PRIMARY KEY,
    total_spent numeric
  );
  TRUNCATE spent_incremental;
  INSERT INTO spent_incremental (character_key, total_spent)
  SELECT character_key, total_spent FROM character_dkp_spent;

  PERFORM refresh_character_dkp_spent();

  SELECT string_agg(
    format(
      '%s incremental=%s refresh=%s',
      COALESCE(i.character_key, r.character_key),
      i.total_spent,
      r.total_spent
    ),
    '; '
  )
  INTO v_mismatch
  FROM spent_incremental i
  FULL OUTER JOIN character_dkp_spent r ON r.character_key = i.character_key
  WHERE i.total_spent IS DISTINCT FROM r.total_spent;

  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION '%: %', p_label, v_mismatch;
  END IF;
END;
$$;

INSERT INTO raid_loot (raid_id, event_id, item_name, char_id, character_name, cost) VALUES
  ('spent-raid', 'spent-tic', 'spent-zero', 'spent-a', 'Alpha', '0'),
  ('spent-raid', 'spent-tic', 'spent-ten', 'spent-buyer', 'Buyer', '10'),
  ('spent-raid', 'spent-tic', 'spent-six', 'spent-buyer', 'Buyer', '6'),
  ('spent-raid', 'spent-tic', 'spent-hold', 'spent-buyer', 'Buyer', '2'),
  ('spent-raid', 'spent-tic', 'spent-five', 'spent-b', 'Bee', '5');

SELECT pg_temp.expect_spent('after loot insert', 'spent-a', 0);
SELECT pg_temp.expect_spent('after loot insert', 'spent-buyer', 18);
SELECT pg_temp.expect_spent('after loot insert', 'spent-b', 5);
SELECT pg_temp.assert_matches_refresh('after loot insert');

INSERT INTO loot_assignment (loot_id, assigned_char_id, assigned_character_name)
SELECT id, 'spent-a', 'Alpha' FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-ten';

SELECT pg_temp.expect_spent('assign ten', 'spent-a', 10);
SELECT pg_temp.expect_spent('assign ten', 'spent-buyer', 8);
SELECT pg_temp.assert_matches_refresh('assign ten');

DO $$
DECLARE
  v_before numeric;
  v_loot bigint;
BEGIN
  SELECT total_spent INTO v_before FROM character_dkp_spent WHERE character_key = 'spent-a';
  SELECT id INTO v_loot FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-ten';
  BEGIN
    UPDATE loot_assignment
    SET assigned_char_id = 'spent-b', assigned_character_name = 'Bee'
    WHERE loot_id = v_loot;
    RAISE EXCEPTION 'force rollback';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'force rollback' THEN
        RAISE;
      END IF;
  END;
  IF (SELECT total_spent FROM character_dkp_spent WHERE character_key = 'spent-a') IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'rollback did not restore spent-a';
  END IF;
  IF (SELECT assigned_char_id FROM loot_assignment WHERE loot_id = v_loot) IS DISTINCT FROM 'spent-a' THEN
    RAISE EXCEPTION 'rollback did not restore the assignment';
  END IF;
END;
$$;

INSERT INTO loot_assignment (loot_id, assigned_char_id, assigned_character_name)
SELECT id, 'spent-a', 'Alpha' FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-six';

SELECT pg_temp.expect_spent('two rows on one character', 'spent-a', 16);
SELECT pg_temp.expect_spent('two rows on one character', 'spent-buyer', 2);
SELECT pg_temp.assert_matches_refresh('two rows on one character');

UPDATE loot_assignment
SET assigned_char_id = 'spent-b', assigned_character_name = 'Bee'
WHERE loot_id = (SELECT id FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-six');

SELECT pg_temp.expect_spent('reassign six', 'spent-a', 10);
SELECT pg_temp.expect_spent('reassign six', 'spent-b', 11);
SELECT pg_temp.assert_matches_refresh('reassign six');

UPDATE loot_assignment
SET assigned_char_id = 'spent-a', assigned_character_name = 'Alpha'
WHERE loot_id = (SELECT id FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-six');

SELECT pg_temp.expect_spent('assign six back', 'spent-a', 16);
SELECT pg_temp.expect_spent('assign six back', 'spent-b', 5);
SELECT pg_temp.assert_matches_refresh('assign six back');

DO $$
DECLARE
  v_loot bigint;
  v_i integer;
BEGIN
  SELECT id INTO v_loot FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-six';
  FOR v_i IN 1..3 LOOP
    UPDATE loot_assignment
    SET assigned_char_id = 'spent-b', assigned_character_name = 'Bee'
    WHERE loot_id = v_loot;
    UPDATE loot_assignment
    SET assigned_char_id = 'spent-a', assigned_character_name = 'Alpha'
    WHERE loot_id = v_loot;
  END LOOP;
END;
$$;

SELECT pg_temp.expect_spent('repeated reassignment', 'spent-a', 16);
SELECT pg_temp.expect_spent('repeated reassignment', 'spent-b', 5);
SELECT pg_temp.assert_matches_refresh('repeated reassignment');

DELETE FROM loot_assignment
WHERE loot_id = (SELECT id FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-six');

SELECT pg_temp.expect_spent('unassign six', 'spent-a', 10);
SELECT pg_temp.expect_spent('unassign six', 'spent-buyer', 8);
SELECT pg_temp.assert_matches_refresh('unassign six');

UPDATE loot_assignment
SET assigned_char_id = 'spent-b', assigned_character_name = 'Bee'
WHERE loot_id = (SELECT id FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-ten');

SELECT pg_temp.expect_spent('zero-cost loot remains', 'spent-a', 0);
SELECT pg_temp.expect_spent('zero-cost loot remains', 'spent-b', 15);
SELECT pg_temp.assert_matches_refresh('zero-cost loot remains');

UPDATE loot_assignment
SET assigned_char_id = 'spent-a', assigned_character_name = 'Alpha'
WHERE loot_id = (SELECT id FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-ten');

INSERT INTO loot_assignment (loot_id, assigned_char_id, assigned_character_name)
SELECT id, 'spent-a', 'Alpha' FROM raid_loot WHERE raid_id = 'spent-raid' AND item_name = 'spent-five';

SELECT pg_temp.expect_spent('before omitting empty character', 'spent-b', 0);
SELECT pg_temp.expect_spent('before omitting empty character', 'spent-a', 15);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM character_dkp_spent WHERE character_key = 'spent-b' AND total_spent = 0
  ) THEN
    RAISE EXCEPTION 'incremental spent removed the zero row before a full rebuild';
  END IF;
END;
$$;

SELECT refresh_character_dkp_spent();
SELECT pg_temp.expect_spent('full rebuild omits a character with no loot', 'spent-b', NULL);
SELECT pg_temp.expect_spent('full rebuild keeps zero-cost character', 'spent-a', 15);
