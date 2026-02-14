# DKP Web App

Minimal React app with Supabase auth and two roles: **officer** and **player**.

## Setup

1. **Supabase**  
   Create a project at [supabase.com](https://supabase.com). Run `../docs/supabase-schema.sql` in the SQL Editor, then import data (see `../docs/supabase-import.md`).

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

New sign-ups get `role = 'player'` by default (see trigger in `supabase-schema.sql`).
