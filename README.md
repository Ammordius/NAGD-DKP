# DKP

Guild DKP site: roster + raid data, Supabase backend, React frontend. Deploy to Vercel.

See **[docs/SETUP-WALKTHROUGH.md](docs/SETUP-WALKTHROUGH.md)** for full setup (Supabase, import, run locally, deploy).

## Push to GitHub and deploy (Vercel)

1. **Create a new repo on GitHub**  
   Go to [github.com/new](https://github.com/new). Name it e.g. `dkp`. Do **not** add a README or .gitignore (this repo already has them).

2. **Add remote and push** (replace `YOUR_USERNAME` and `YOUR_REPO` with your GitHub username and repo name):

   ```bash
   cd c:\TAKP\dkp
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git branch -M main
   git push -u origin main
   ```

3. **Deploy on Vercel**  
   [Part 7 in the walkthrough](docs/SETUP-WALKTHROUGH.md): import the GitHub repo, set **Root Directory** to `web`, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables, then deploy.
