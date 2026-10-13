-- Officer correction of accounts.display_name.
-- Run once in the Supabase SQL editor. Do not deploy from the app.
-- Sets the label to a character already linked to that account.
-- Does not change ownership, auth users, balances, attendance, or loot.

CREATE OR REPLACE FUNCTION public.accounts_display_name_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.display_name IS NOT DISTINCT FROM OLD.display_name THEN
    RETURN NEW;
  END IF;
  IF current_setting('nagddkp.allow_display_name_change', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Display name can only be changed by selecting a linked character';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM character_account ca
    JOIN characters c ON c.char_id = ca.char_id
    WHERE ca.account_id = NEW.account_id
      AND trim(c.name) = trim(NEW.display_name)
  ) THEN
    RAISE EXCEPTION 'Display name must match a character linked to this account';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS accounts_display_name_guard ON public.accounts;
CREATE TRIGGER accounts_display_name_guard
  BEFORE UPDATE OF display_name ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.accounts_display_name_guard();

GRANT EXECUTE ON FUNCTION public.accounts_display_name_guard() TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounts_display_name_guard() TO service_role;

CREATE OR REPLACE FUNCTION public.officer_set_account_display_name(
  p_account_id text,
  p_char_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_account_id text;
  v_char_id text;
  v_old text;
  v_new text;
  v_email text;
  v_actor_name text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can change account display names';
  END IF;

  v_account_id := trim(coalesce(p_account_id, ''));
  v_char_id := trim(coalesce(p_char_id, ''));
  IF v_account_id = '' THEN
    RAISE EXCEPTION 'Account is required';
  END IF;
  IF v_char_id = '' THEN
    RAISE EXCEPTION 'Character is required';
  END IF;

  SELECT a.display_name
  INTO v_old
  FROM public.accounts a
  WHERE a.account_id = v_account_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  SELECT trim(c.name)
  INTO v_new
  FROM public.characters c
  JOIN public.character_account ca ON ca.char_id = c.char_id
  WHERE ca.account_id = v_account_id
    AND ca.char_id = v_char_id;
  IF NOT FOUND OR v_new IS NULL OR v_new = '' THEN
    RAISE EXCEPTION 'Character is not linked to this account';
  END IF;

  IF trim(coalesce(v_old, '')) = v_new THEN
    RETURN v_new;
  END IF;

  PERFORM set_config('nagddkp.allow_display_name_change', '1', true);

  UPDATE public.accounts
  SET display_name = v_new
  WHERE account_id = v_account_id;

  UPDATE public.account_dkp_summary
  SET display_name = v_new
  WHERE account_id = v_account_id;

  SELECT NULLIF(trim(p.email), '')
  INTO v_email
  FROM public.profiles p
  WHERE p.id = v_actor;

  SELECT NULLIF(trim(a.display_name), '')
  INTO v_actor_name
  FROM public.profiles p
  JOIN public.accounts a ON a.account_id = p.account_id
  WHERE p.id = v_actor;

  INSERT INTO public.officer_audit_log (
    actor_id,
    actor_email,
    actor_display_name,
    action,
    target_type,
    target_id,
    delta
  )
  VALUES (
    v_actor,
    v_email,
    v_actor_name,
    'set_account_display_name',
    'account',
    v_account_id,
    jsonb_build_object(
      'previous_display_name', v_old,
      'new_display_name', v_new,
      'char_id', v_char_id
    )
  );

  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.officer_set_account_display_name(text, text) IS
  'Officer-only: set accounts.display_name to a character linked to that account. Also updates the summary label. Writes officer_audit_log.';

REVOKE ALL ON FUNCTION public.officer_set_account_display_name(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_set_account_display_name(text, text) TO authenticated;

COMMENT ON TABLE public.officer_audit_log IS
  'Audit trail for officer actions: add_raid, add_tic, delete_event, raid_deleted, rename_raid, add_loot, add_loot_from_log, delete_loot, add_attendee_to_tic, add_attendees_to_tic, remove_attendee_from_tic, edit_event_dkp, edit_event_time, edit_loot_cost, set_account_display_name. Delta is minimal (short keys) to limit storage and egress.';
