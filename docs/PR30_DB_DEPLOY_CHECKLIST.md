# PR #30 / #31 database deploy checklist (do not run against staging/production from this integration)

Ordered steps for a **future** hosted deploy. Checklist only — do not execute against hosted environments from the local integration branch.

## Prerequisites

- Disposable validation already passed: `DKP_PG_TEST=1 node web/test/pg/run-authorization-tests.js`
- Canonical schema file: `docs/supabase-schema-full.sql`
- Note a PITR restore point **and** keep a copy of the prior function definitions for reverse migration

## Apply (future)

1. Record a PITR timestamp / named backup (safety net only; prefer reverse SQL for rollback — see below).
2. Apply the delta for these objects from `docs/supabase-schema-full.sql` (or full schema on a fresh restore target):
   - `recent_item_sale_costs(integer)` — resolved `date_iso` then `date` ranking; deterministic `ORDER BY`
   - `account_character_spent()` — case-sensitive name fallback matching prior Accounts JS; deterministic `ORDER BY`
   - `log_officer_audit(...)`
   - `siteadmin_claim_cooldowns()`
   - Related grants/revokes and `claim_account` hardening from PR #30
3. Confirm `officer_audit_log` direct INSERT is revoked for authenticated; writes go through `log_officer_audit`.
4. Deploy the web build that pages the two spent/sale RPCs **after** the SQL is live.
5. On the **actual production Vercel project only**, set `VITE_SITE_ENV=production` explicitly.  
   - `VITE_SITE_TITLE` is display text and must **not** be used to hide development warnings.  
   - Staging and development projects must use `staging` / `development` (or leave unset) — never `production`.

## Validation queries (read-only)

```sql
-- Functions exist and are executable by authenticated only (not anon)
SELECT p.proname, pg_get_function_identity_arguments(p.oid)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'recent_item_sale_costs',
    'account_character_spent',
    'log_officer_audit',
    'siteadmin_claim_cooldowns'
  )
ORDER BY 1;

-- Sale RPC completeness vs guild scale (expect >= 2701 when data matches)
SELECT count(*) AS sale_rows FROM public.recent_item_sale_costs(3);

-- Spent RPC completeness
SELECT count(*) AS spent_rows FROM public.account_character_spent();

-- Ordering spot-check (first page stable)
SELECT * FROM public.recent_item_sale_costs(3) LIMIT 5;
SELECT * FROM public.account_character_spent() LIMIT 5;
```

## Rollback (prefer reverse migration over PITR)

### Safe reverse migration (preferred when only these RPCs/grants changed)

1. Re-apply the **previous** `CREATE OR REPLACE FUNCTION` bodies and grants for the four RPCs (and related claim/audit changes) from the pre-deploy schema text / git tag.
2. Redeploy the previous web build that matches that schema (or does not call the new RPCs).
3. This does **not** discard officer writes, loot edits, or claims that landed after the forward deploy.

### Full database PITR (last resort)

1. Restoring to a pre-deploy PITR point **will discard all database writes after that point** (raids, tics, loot, claims, audit rows, etc.).
2. Use PITR only if reverse SQL cannot restore a consistent state or damage extends beyond these function definitions.
3. After PITR, redeploy the matching web build.

## Explicitly out of scope here

- Do not run this checklist against hosted staging or production from the local integration branch.
- Do not migrate data, rotate secrets, or change Vercel env as part of local integration work (except documenting that production must set `VITE_SITE_ENV=production` before go-live).
