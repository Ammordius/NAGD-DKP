-- Existing projects: run this in the Supabase SQL Editor.
-- Replaces siteadmin_delete_user with the same function as docs/supabase-schema-full.sql.
-- Fresh projects get it from the full schema. Do not run this instead of the full schema.
--
-- The website then calls auth.admin.deleteUser from web/api/delete-site-user.js
-- (server-only SUPABASE_SERVICE_ROLE_KEY). Game accounts and characters are not deleted.

CREATE OR REPLACE FUNCTION public.siteadmin_delete_user(p_profile_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_name text;
  v_account text;
  v_actor_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers and site admins can remove a user';
  END IF;
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION 'Profile is required';
  END IF;
  IF p_profile_id = auth.uid() THEN
    RAISE EXCEPTION 'You cannot remove yourself';
  END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = auth.uid();

  SELECT role, display_name, account_id
  INTO v_role, v_name, v_account
  FROM public.profiles
  WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profile not found';
  END IF;

  -- Officers may remove players only. Site admins may remove players and officers.
  -- Nobody may remove a site admin or themselves.
  IF v_role = 'siteadmin' THEN
    RAISE EXCEPTION 'Site admins cannot be removed';
  END IF;
  IF COALESCE(v_actor_role, '') <> 'siteadmin' THEN
    IF v_actor_role = 'officer' AND v_role IS DISTINCT FROM 'player' THEN
      RAISE EXCEPTION 'Officers cannot remove other officers';
    ELSIF v_actor_role IS DISTINCT FROM 'officer' THEN
      RAISE EXCEPTION 'Only officers and site admins can remove a user';
    END IF;
  END IF;

  PERFORM public.write_site_admin_audit(
    'siteadmin_delete_user',
    'profile',
    p_profile_id::text,
    jsonb_build_object(
      'display_name', v_name,
      'role', v_role,
      'account_id', v_account
    )
  );

  -- auth.users is removed by the server (auth.admin.deleteUser) after this returns.
  -- Game accounts and characters stay. profiles.id cascades when the auth user is deleted.
  DELETE FROM public.profiles WHERE id = p_profile_id;
END;
$$;

COMMENT ON FUNCTION public.siteadmin_delete_user(uuid) IS
  'Officer or siteadmin: delete public.profiles for a user they may remove. Officers may remove players only. Site admins may remove players and officers. Nobody may remove a site admin or themselves. Does not delete auth.users (web/api/delete-site-user.js calls auth.admin.deleteUser), game accounts, or characters.';

REVOKE ALL ON FUNCTION public.siteadmin_delete_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.siteadmin_delete_user(uuid) TO authenticated;
