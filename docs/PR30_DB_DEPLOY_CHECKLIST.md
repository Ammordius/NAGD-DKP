# PR #30 database deploy checklist (do not run against staging/production from this integration)

Ordered, reversible steps for a **future** hosted deploy. This document is a checklist only.

## Prerequisites

- Disposable validation already passed: `DKP_PG_TEST=1 node web/test/pg/run-authorization-tests.js`
- Canonical schema file: `docs/supabase-schema-full.sql`
- Backup the target database (Supabase PITR / dump) before applying

## Apply (future)

1. Take a named backup / note PITR timestamp.
2. Apply the delta for these objects from `docs/supabase-schema-full.sql` (or full schema on a fresh restore target):
   - `recent_item_sale_costs(integer)` — includes deterministic `ORDER BY`
   - `account_character_spent()` — includes deterministic `ORDER BY`
   - `log_officer_audit(...)`
   - `siteadmin_claim_cooldowns()`
   - Related grants/revokes and `claim_account` hardening from PR #30
3. Confirm `officer_audit_log` direct INSERT is revoked for authenticated; writes go through `log_officer_audit`.
4. Deploy the web build that pages the two spent/sale RPCs **after** the SQL is live.

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

## Rollback

1. Restore from the pre-deploy backup / PITR.
2. Redeploy the previous web build that does not call the new RPCs (or that matches the restored schema).

## Explicitly out of scope here

- Do not run this checklist against hosted staging or production from the local integration branch.
- Do not migrate data, rotate secrets, or change Vercel env as part of this local work.
