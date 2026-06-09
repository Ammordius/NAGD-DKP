# Privacy

NAGD-DKP is a guild DKP application for tracking raids, attendance, loot, DKP changes,
and related audit history.

## Data handled by the app

Depending on configuration and use, the app may store:

- Login/account identifiers managed through Supabase Auth
- Character names and guild/game identifiers
- Raid attendance records
- Loot assignments
- DKP totals and manual DKP adjustments
- Officer audit-log entries for administrative actions

## Access controls

The app is designed to use Supabase authentication, row-level security, and role-based
access. Some information is restricted to signed-in users or officers, depending on
deployment configuration.

## Public outputs

This project may generate public or semi-public reports, ledgers, backups, or GitHub
Pages artifacts showing database changes or historical records. Before deploying,
review which tables and fields are exported or published.

## Third-party services

Deployments may use services including Supabase, Vercel, GitHub Actions, and GitHub
Pages. These services may process logs, authentication events, deployment metadata,
or access metadata under their own privacy policies.

## Data retention

Data retention depends on the deployed Supabase database, GitHub Actions artifacts,
backup configuration, and any published ledger artifacts. Operators should remove
or rotate data manually if needed.

## Contact

For privacy or data-removal requests, contact the maintainer or guild officers
responsible for the deployed instance.
