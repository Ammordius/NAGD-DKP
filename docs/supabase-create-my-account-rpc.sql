-- Run in Supabase SQL Editor to add create_my_account RPC.
-- Lets authenticated users create exactly one DKP account (theirs) and then add characters.

CREATE OR REPLACE FUNCTION public.create_my_account(p_display_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid;
  v_existing_id text;
  v_new_account_id text;
  v_display text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT account_id INTO v_existing_id FROM public.profiles WHERE id = v_uid;
  IF v_existing_id IS NOT NULL AND trim(v_existing_id) <> '' THEN
    RAISE EXCEPTION 'You already have an account. Unclaim it first if you want to create a different one.';
  END IF;

  v_display := trim(coalesce(p_display_name, ''));
  IF v_display = '' THEN
    v_display := 'My account';
  END IF;

  v_new_account_id := gen_random_uuid()::text;
  INSERT INTO public.accounts (account_id, display_name, toon_count, char_ids, toon_names)
  VALUES (v_new_account_id, v_display, 0, NULL, NULL);

  UPDATE public.profiles SET account_id = v_new_account_id, updated_at = now() WHERE id = v_uid;

  RETURN v_new_account_id;
END;
$$;

-- Officer-only: create a new DKP account (unclaimed). Player then claims it on the account page.
CREATE OR REPLACE FUNCTION public.create_account(p_display_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_account_id text;
  v_display text;
  v_key text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can create new DKP accounts';
  END IF;

  v_display := trim(coalesce(p_display_name, ''));
  IF v_display = '' THEN
    RAISE EXCEPTION 'Enter a display name';
  END IF;

  v_key := lower(v_display);

  IF EXISTS (
    SELECT 1 FROM public.accounts a
    WHERE lower(trim(coalesce(a.display_name, ''))) = v_key
  ) THEN
    RAISE EXCEPTION 'An account named "%" already exists', v_display;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.characters c
    WHERE lower(trim(coalesce(c.name, ''))) = v_key
  ) THEN
    RAISE EXCEPTION 'A character named "%" already exists', v_display;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.accounts a
    CROSS JOIN LATERAL unnest(string_to_array(coalesce(a.toon_names, ''), ',')) AS t(n)
    WHERE lower(trim(n)) = v_key
  ) THEN
    RAISE EXCEPTION 'A character named "%" already exists', v_display;
  END IF;

  v_new_account_id := gen_random_uuid()::text;
  INSERT INTO public.accounts (account_id, display_name, toon_count, char_ids, toon_names)
  VALUES (v_new_account_id, v_display, 0, NULL, NULL);

  RETURN v_new_account_id;
END;
$$;
