# NAGD-DKP: Enable Discord Sign-In

**Stack:** Discord OAuth2 → Supabase Auth → NAGD-DKP on Vercel  
**Updated:** October 12, 2026

This is an operational setup guide for the existing **Sign in with Discord** button. It assumes the button has already been implemented in the website. **You do not need to be an administrator of the guild's Discord server.** A Discord *developer application* is independent of server administration.

> **Ownership:** For the final guild production deployment, the officer operating production should own or have dependable administrative access to the Discord developer application and the production Supabase project. Use separate development/test credentials where practical. Never commit a Discord client secret to GitHub or expose it in client-side JavaScript.

## 1. Copy the Supabase callback URL

1. Open [Supabase Dashboard](https://supabase.com/dashboard), and select the Supabase project used by the target website (development, staging, or production).
2. Go to **Authentication → Sign In / Providers → Discord** (the menu wording may vary slightly).
3. Copy the **Callback URL** shown there. It will look like:

   ```text
   https://YOUR-SUPABASE-PROJECT-REF.supabase.co/auth/v1/callback
   ```

   This URL points to **Supabase**, not to Vercel. Do not substitute `https://nagd-dkp.vercel.app` here.

## 2. Create the Discord OAuth application

1. Visit [Discord Developer Portal → Applications](https://discord.com/developers/applications) using your normal Discord account.
2. Choose **New Application**. Name it something like `NAGD DKP` and create it.
3. Open **OAuth2** in the application's settings.
4. Under **Redirects**, choose **Add Redirect** and paste the **exact Supabase callback URL** from step 1. Save changes.
5. In **OAuth2 → Client Information**, copy the **Client ID** and **Client Secret**.

**Important:** The Client ID is a long numeric Discord application ID (a *snowflake*), **not** the app name `DKP`. Keep the Client Secret private. Basic Discord OAuth login does **not** require adding a bot to the guild server.

## 3. Enable Discord in Supabase

1. Return to the same Supabase project.
2. Open **Authentication → Sign In / Providers → Discord**.
3. Set **Discord Enabled** to **On**.
4. Paste the numeric **Client ID** and the **Client Secret** from Discord.
5. Save.

Repeat the provider setup for each **separate Supabase project** used by staging or production. You may register more than one callback URL in a Discord OAuth application, but separate Discord apps for test and production make ownership and troubleshooting clearer.

**A frontend redeployment is usually unnecessary** for these provider-only settings if the button already calls Supabase correctly.

## 4. Configure where users return after signing in

In Supabase, open **Authentication → URL Configuration**.

- Set the **Site URL** to the canonical address for this Supabase project's application, e.g. `https://nagd-dkp.vercel.app` when configuring that deployment.
- Add any additional allowed **Redirect URLs** that the site actually uses, for example:

  ```text
  https://nagd-dkp.vercel.app/**
  https://nagd-dkp-staging.vercel.app/**
  http://localhost:3000/**
  ```

  Only allow the hosts your project needs. For production, prefer exact callback paths if known, rather than broad wildcard patterns.

**There are two different redirect configurations:**

| Configured in | Value | Purpose |
|---|---|---|
| **Discord OAuth2 → Redirects** | `https://PROJECT-REF.supabase.co/auth/v1/callback` | Discord sends the OAuth result to Supabase. |
| **Supabase Auth → URL Configuration** | Your actual Vercel origin or callback route | Supabase returns the signed-in user to the website. |

If the frontend calls `signInWithOAuth({ provider: 'discord', options: { redirectTo: '...' } })`, the exact `redirectTo` URL must be in Supabase's allow list. If the app uses a server-side PKCE callback, the application must also implement the code-to-session exchange; do not invent a callback route without checking the code.

## 5. Confirm the frontend is wired up

The existing button should ultimately call Supabase Auth with the Discord provider, conceptually:

```js
const { data, error } = await supabase.auth.signInWithOAuth({
  provider: 'discord',
});
```

The app may supply an `options.redirectTo` parameter or use a more elaborate callback flow; preserve whatever matches its actual auth implementation. There is **no need to build a Discord bot** just to authenticate users.

Verify that the site's Supabase URL and public key point to the **same Supabase project** in which Discord was enabled. A working production provider configuration does not enable Discord in a separate staging project.

## 6. Acceptance test before announcing the feature

- [ ] Open the target site in a private/incognito browser window.
- [ ] Click **Sign in with Discord**.
- [ ] Confirm the Discord authorization screen shows the intended application name.
- [ ] Accept, and confirm you return to the **correct** site and remain signed in after refreshing.
- [ ] Check **Supabase → Authentication → Users** for the expected authenticated user.
- [ ] Confirm the user has the expected NAGD-DKP account, linked characters, and permissions.
- [ ] Test sign-out and sign-in again.
- [ ] Test with one **existing email/password DKP user** before rolling this out broadly.
- [ ] Test staging and production separately if they use separate Supabase projects.

**Existing accounts:** Supabase can automatically link OAuth identities when the verified email matches an existing user's email. If a user's Discord email differs, a separate Supabase user may be created. NAGD-DKP must verify what that does to character associations, app profiles, and officer privileges before encouraging existing members to switch login methods. Do not assume automatic linking will preserve every account.

## Troubleshooting

| Symptom | Likely issue | Check |
|---|---|---|
| `Unsupported provider: provider is not enabled` | Discord disabled in the Supabase project the frontend actually uses | Enable Discord in that project's Auth provider settings; check frontend Supabase URL. |
| `Value "DKP" is not snowflake` | Entered the application **name** instead of numeric **Client ID** | Copy the numeric Client ID under Discord OAuth2. |
| `redirect_uri` mismatch / invalid redirect | Discord callback URL absent or wrong | Discord OAuth2 Redirects must include the exact Supabase `/auth/v1/callback` URL. |
| Authentication works, then redirects to localhost or wrong site | Supabase Site URL or redirect allow list incorrect | Review Supabase Authentication → URL Configuration and frontend `redirectTo`. |
| Login creates a new DKP profile / characters appear missing | Discord identity did not link to an existing app user | Compare verified email, Supabase user UUID, and application profile/character associations. Avoid granting elevated roles until resolved. |
| Staging works but production fails (or vice versa) | Different Supabase projects or different OAuth app configuration | Validate each project and its callback URL independently. |

## Production handoff checklist

- [ ] Production owner has access to the Discord developer application and can rotate its client secret.
- [ ] Production owner has Supabase administrator access and has enabled the provider.
- [ ] Production Vercel environment points to the correct Supabase project.
- [ ] Authorized redirect URLs are limited to appropriate application hosts.
- [ ] Test sign-in with a non-officer user and an existing-user account.
- [ ] Document who manages OAuth secrets and who responds when Discord login breaks.
- [ ] Do **not** share the Discord Client Secret in PRs, screenshots, chat logs, or public documentation.

## Official references

- [Supabase: Sign in with Discord](https://supabase.com/docs/guides/auth/social-login/auth-discord)
- [Supabase: Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase: Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord: OAuth2](https://discord.com/developers/docs/topics/oauth2)

