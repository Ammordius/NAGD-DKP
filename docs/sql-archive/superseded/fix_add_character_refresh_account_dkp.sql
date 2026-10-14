-- Migration: refresh account DKP after linking a character so historical
-- raid_event_attendance credits the account without re-upload.
-- Also appends the character name to accounts.toon_names (and char_ids / toon_count).
-- Deployed via apply_migration; mirrored in docs/supabase-schema-full.sql.
-- Existing databases: run this file in the Supabase SQL editor.

CREATE OR REPLACE FUNCTION public.add_character_to_my_account(p_character_name text, p_char_id_override text DEFAULT NULL, p_account_id text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_account_id text;
  v_my_account_id text;
  v_char_id text;
  v_name_trim text;
  v_char_id_use text;
  v_linked_name text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT account_id INTO v_my_account_id FROM public.profiles WHERE id = auth.uid();

  IF p_account_id IS NOT NULL AND trim(p_account_id) <> '' THEN
    IF NOT public.is_officer() AND (v_my_account_id IS NULL OR v_my_account_id <> trim(p_account_id)) THEN
      RAISE EXCEPTION 'You can only add characters to your own claimed account';
    END IF;
    v_account_id := trim(p_account_id);
  ELSE
    v_account_id := v_my_account_id;
  END IF;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account claimed. Claim an account first.';
  END IF;

  v_name_trim := trim(coalesce(p_character_name, ''));
  IF v_name_trim = '' THEN
    RAISE EXCEPTION 'Character name is required';
  END IF;

  -- Resolve character: by char_id override if given, else by name
  v_char_id := NULL;
  IF p_char_id_override IS NOT NULL AND trim(p_char_id_override) <> '' THEN
    SELECT c.char_id INTO v_char_id FROM characters c WHERE c.char_id = trim(p_char_id_override) LIMIT 1;
  END IF;

  IF v_char_id IS NULL THEN
    -- Look up by name (exact match preferred, then ilike)
    SELECT c.char_id INTO v_char_id
    FROM characters c
    WHERE trim(coalesce(c.name, '')) = v_name_trim
    LIMIT 1;
    IF v_char_id IS NULL THEN
      SELECT c.char_id INTO v_char_id
      FROM characters c
      WHERE c.name ILIKE v_name_trim
      LIMIT 1;
    END IF;
  END IF;

  IF v_char_id IS NOT NULL THEN
    INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
    ON CONFLICT (char_id, account_id) DO NOTHING;
  ELSE
    -- Multiple matches by ilike: require exact name or char_id
    IF (SELECT count(*) FROM characters c WHERE c.name ILIKE v_name_trim) > 1 THEN
      RAISE EXCEPTION 'Multiple characters match; use exact name or char_id';
    END IF;

    -- Not found: create new character and link. char_id defaults to the character name.
    v_char_id_use := coalesce(nullif(trim(p_char_id_override), ''), v_name_trim);
    BEGIN
      INSERT INTO characters (char_id, name) VALUES (v_char_id_use, v_name_trim);
      v_char_id := v_char_id_use;
    EXCEPTION
      WHEN unique_violation THEN
        -- character already exists (e.g. char_id_use taken); try to link it
        SELECT char_id INTO v_char_id FROM characters WHERE char_id = v_char_id_use LIMIT 1;
        IF v_char_id IS NULL THEN
          RAISE EXCEPTION 'Character with this ID already exists; use a different name or char_id';
        END IF;
    END;
    INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
    ON CONFLICT (char_id, account_id) DO NOTHING;
  END IF;

  SELECT COALESCE(NULLIF(trim(c.name), ''), v_name_trim)
  INTO v_linked_name
  FROM characters c
  WHERE c.char_id = v_char_id;
  IF v_linked_name IS NULL OR trim(v_linked_name) = '' THEN
    v_linked_name := v_name_trim;
  END IF;

  -- Keep the denormalized account character list in sync with character_account.
  UPDATE public.accounts a
  SET
    toon_names = CASE
      WHEN a.toon_names IS NULL OR btrim(a.toon_names) = '' THEN v_linked_name
      WHEN EXISTS (
        SELECT 1
        FROM unnest(string_to_array(a.toon_names, ',')) AS t(n)
        WHERE lower(btrim(n)) = lower(v_linked_name)
      ) THEN a.toon_names
      ELSE rtrim(a.toon_names, ', ') || ', ' || v_linked_name
    END,
    char_ids = CASE
      WHEN a.char_ids IS NULL OR btrim(a.char_ids) = '' THEN v_char_id
      WHEN EXISTS (
        SELECT 1
        FROM unnest(string_to_array(a.char_ids, ',')) AS t(n)
        WHERE btrim(n) = v_char_id
      ) THEN a.char_ids
      ELSE rtrim(a.char_ids, ',') || ',' || v_char_id
    END,
    toon_count = (
      SELECT COUNT(DISTINCT ca.char_id)::integer
      FROM public.character_account ca
      WHERE ca.account_id = a.account_id
    )
  WHERE a.account_id = v_account_id;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
    SET LOCAL statement_timeout = '120s';
    PERFORM refresh_account_dkp_summary_internal();
  END IF;
  RETURN;
END;
$$;
