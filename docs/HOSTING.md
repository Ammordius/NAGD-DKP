# Free hosting: Supabase + Vercel

**Recommended stack** for a simple DKP site with login and two roles (officer / player).

## Why this stack

| Need | Solution |
|------|----------|
| **Free hosting** | [Vercel](https://vercel.com) – free for hobby (frontend). [Supabase](https://supabase.com) – free tier: 2 projects, PostgreSQL + Auth. |
| **Login** | Supabase Auth (email/password or magic link). No custom auth code. |
| **Officer vs player** | One `profiles` table with `role: 'officer' \| 'player'`. Frontend shows/hides UI by role; Supabase Row Level Security (RLS) can restrict writes to officers. |
| **Simplicity** | One frontend repo, one Supabase project. No server to run; deploy frontend with `vercel deploy`. |

## Cost

- **Vercel**: Free (hobby). Custom domain optional.
- **Supabase**: Free tier (2 projects, 500MB DB, 1GB file storage, 50K monthly active users). Enough for a guild site.

## Steps (high level)

1. **Supabase**
   - Create a project at [supabase.com](https://supabase.com).
   - Run the schema SQL (creates tables + RLS + `profiles` with `role`).
   - Import your data from `data/*.csv` (Supabase Table Editor → Import, or use the SQL in `docs/supabase-import.md`).
   - In Authentication → Users, create your first user, then set their `profiles.role` to `officer` in SQL or Table Editor.

2. **Frontend (this repo)**
   - In `web/` add `.env.local` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from Supabase → Settings → API.
   - `npm install` then `npm run build` in `web/`.
   - Connect the repo to Vercel and deploy (or run `npx vercel`). Set the same env vars in Vercel.

3. **Roles**
   - New users get `role = 'player'` by default (trigger or app logic).
   - Promote to officer: run `UPDATE profiles SET role = 'officer' WHERE id = '<user-uuid>';` in Supabase SQL (or build a small “admin” UI later).

## Alternatives (if you want to avoid Supabase)

- **Firebase**: Similar (Auth + Firestore). You’d need to adapt the schema to Firestore and handle imports differently.
- **Static + Netlify**: Same idea as Vercel; use Netlify for the frontend and Supabase (or another BaaS) for DB + Auth.
- **Self‑hosted**: e.g. a VPS with a small backend + SQLite/Postgres. Not free and more ops; only if you explicitly want full control.

Sticking with **Supabase + Vercel** keeps everything free and simple while giving you real login and two permission sets (officer, player).
