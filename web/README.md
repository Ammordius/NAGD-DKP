# DKP Web App

Minimal React app with Supabase auth and two roles: **officer** and **player**.

**Architecture, routes, data sources, and UI state persistence:** see **[`../docs/WEBSITE_STACK_AND_STATE.md`](../docs/WEBSITE_STACK_AND_STATE.md)** (canonical reference for this SPA).

## Setup

1. **Supabase**  
   Create a project at [supabase.com](https://supabase.com). In the SQL Editor, run `../docs/supabase-schema-full.sql` once (see [../docs/SCHEMA_DEPLOYMENT.md](../docs/SCHEMA_DEPLOYMENT.md)). Then import data (see `../docs/supabase-import.md`). The walkthrough is [../docs/SETUP-WALKTHROUGH.md](../docs/SETUP-WALKTHROUGH.md). Do not also run the older loot, raider-activity, or class-coverage SQL files; they are already in the full schema. There is no `docs/supabase-schema.sql`.

2. **Env**  
   Copy `.env.example` to `.env.local` and set:
   - `VITE_SUPABASE_URL` – from Supabase → Settings → API → Project URL  
   - `VITE_SUPABASE_ANON_KEY` – from same page, anon public key  

3. **Install and run**
   ```bash
   npm install
   npm run dev
   ```
   Open http://localhost:5173. Sign up, then set your user to officer in Supabase:
   ```sql
   UPDATE profiles SET role = 'officer' WHERE id = 'your-user-uuid';
   ```

## Deploy (Vercel, free)

1. Push the repo to GitHub (include `web/` and set root to `web` in Vercel, or deploy from `web` folder).
2. In [vercel.com](https://vercel.com): New Project → Import repo → **Root Directory** set to `web`.
3. Add Environment Variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Deploy. Your site will be at `https://your-project.vercel.app`.

## Roles

- **Player**: Can sign in, view Raids list and detail, view DKP leaderboard.
- **Officer**: Same as player; nav shows an “Officer” label. Future: edit raids, manage users, etc.

New sign-ups get `role = 'player'` by default (see `handle_new_user` in `docs/supabase-schema-full.sql`).
