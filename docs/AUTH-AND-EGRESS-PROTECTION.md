# Auth and egress protection

The site requires **sign-in to access data**. This reduces the risk of bots or scrapers exhausting Supabase egress.

## Roles

- **anon** – Used by the Vercel/frontend handshake only (Supabase client init, `getSession()`, sign-in). Anon **cannot** read any DKP tables; RLS allows only `authenticated` for data.
- **user** – Any signed-in user with a profile (default role `player`). Can read all DKP data and use account/character features.
- **officer** – Manually assigned in the database. Same as user plus officer-only actions (add raids, edit DKP, audit log, etc.).

## Requiring sign-in (already in place)

1. **Schema** – Data tables have no `TO anon` SELECT policies. Only `TO authenticated` can read. Run `docs/supabase-require-auth-remove-anon-read.sql` on an existing project that previously had anon read.
2. **Frontend** – All data routes redirect to `/login` when there is no session. Only the login page is public.

## Protecting against bot sign-ups and egress

Requiring sign-in for data already stops anonymous bots from reading tables. To further limit who can create new accounts:

1. **Disable public sign-ups (optional)**  
   In Supabase: **Authentication** → **Providers** → **Email** → turn **off** “Enable email signups”.  
   **Existing users are unaffected** — they can still sign in. Only *new* sign-ups are blocked. New users can then only be added by invite or manually in the Auth dashboard.

2. **Optional: hide sign-up in the UI**  
   Set `VITE_ALLOW_SIGNUP=false` in your build env (e.g. Vercel). The login page will hide “Need an account? Sign up”.

3. **Officers**  
   Assign in SQL after the user exists in Auth:  
   `INSERT INTO profiles (id, email, role) VALUES ('auth-users-uuid', 'officer@example.com', 'officer') ON CONFLICT (id) DO UPDATE SET role = 'officer';`

4. **Rate limiting**  
   Supabase applies rate limits to Auth endpoints. On Pro you can tune them under Project Settings.

## Summary

| Goal                    | Action |
|-------------------------|--------|
| Data requires login    | Schema: no anon read; app: redirect to login for data routes. |
| Anon = handshake only   | Keep using anon key for client init and auth; no anon RLS on data. |
| Limit new users (optional) | Supabase: disable email signups (existing users can still sign in); optionally set `VITE_ALLOW_SIGNUP=false`. |
| Officers                | Manually set `profiles.role = 'officer'` in SQL. |
