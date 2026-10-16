# Full database recovery certification

Certified at 2026-10-16 08:30:08 Central Daylight Time on a disposable local Supabase CLI 2.121.0 stack.
PostgreSQL server version: `17.11`. Client `pg_dump` and `psql` are PostgreSQL 17.11 from the extracted Windows binaries used only on `PATH` for this run. The database image is `public.ecr.aws/supabase/postgres:17.11.0.004`.

## Verdicts

- Overall: **CONDITIONAL PASS**
- PostgreSQL logical recovery of classified live data and `public` definitions, including the extra user schema: **PASS**
- Full Supabase project recovery: **FAIL**

The artifact restores the initialized database's classified SQL: `public` definitions, live rows for `public`, `auth`, and `storage` metadata, sequence positions, and postgres-owned default privileges. It does not restore the pgsodium root key, storage object bytes, JWT signing keys, API keys, or dashboard auth-provider settings. A new `supabase start` can log the restored users in because GoTrue checks the restored password hashes, and it signs new tokens with the new project's JWT secret.

## Environment

- Worktree: `C:\TAKP\dkp-full-db-recovery`, branch `full-db-recovery-design`.
- Artifact format: `full-db-1`, file name `full-db-backup-<UTC>.tar.gz.age`, encryption `age` 1.3.2.
- Disposable projects used `supabase start --workdir` with a unique `project_id` beginning `full-db-cert-` and ports outside 54320-54324, 54327, and 54329.
- The long-lived `supabase_db_dkp-full-db-recovery` container was still running after every destructive step. No hosted database was contacted.

## Tests

| Check | Result |
| --- | --- |
| missing archive member | fail closed |
| manifest checksum mismatch | fail closed |
| wrong age identity | fail closed |
| corrupted encrypted artifact | fail closed |
| incorrect destination marker | fail closed |
| privilege mismatch | fail closed |
| missing required extension | fail closed |
| missing required role | fail closed |
| missing schema/table | rolled back |
| restore failure halfway through | rolled back, success not reported |
| unsupported PostgreSQL version | refused before write |
| clean restore after failed attempts | committed |

Two destructive cycles used different fixtures. Cycle A has raids, attendance, loot, an adjustment, a cached DKP refresh, and a nontrivial `raid_events` sequence. Cycle B leaves the raid tables empty, uses a quoted Unicode character name, and advances `raid_loot`'s sequence. Both create two Auth users through GoTrue, log them in before backup, and include an extra `certification_extra.notes` table, a `certification_reader` role, one vault secret, storage metadata, and an inert hook.

| Cycle | Backup seconds | Restore seconds | Tables hashed | Catalog entries |
| --- | --- | --- | --- | --- |
| a | 2.6 | 2.1 | 64 | 402 |
| b | 2.6 | 2.0 | 64 | 402 |

## Inventory and hashes

Row hashes are `md5` of `row_to_json` text, ordered by that text. The restored hash matched the baseline for every compared table. `public.restore_in_progress` is the intentional exception: the source row was `true` and the restored row is `false`.

| Cycle | Table | Baseline hash | Restored hash |
| --- | --- | --- | --- |
| a | auth.audit_log_entries | edb84ea7bf9e6144f9f8c580022ed905 | edb84ea7bf9e6144f9f8c580022ed905 |
| a | auth.custom_oauth_providers | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.flow_state | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.identities | 7c23523730e3e69732ccb6515e41cbb2 | 7c23523730e3e69732ccb6515e41cbb2 |
| a | auth.instances | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.mfa_amr_claims | 664d3cc875140c3b4497fb864aa28911 | 664d3cc875140c3b4497fb864aa28911 |
| a | auth.mfa_challenges | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.mfa_factors | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.mfa_recovery_code_sets | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.mfa_recovery_codes | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.oauth_authorizations | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.oauth_client_states | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.oauth_clients | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.oauth_consents | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.one_time_tokens | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.refresh_tokens | 23a6fa43b2396832a24904b5f39d2d42 | 23a6fa43b2396832a24904b5f39d2d42 |
| a | auth.saml_providers | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.saml_relay_states | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.schema_migrations | 33cac503c99c09d6a74d508809afa2d3 | 33cac503c99c09d6a74d508809afa2d3 |
| a | auth.scim_tokens | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.scim_users | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.sessions | 18da94097884f9d24ee74195df652fd2 | 18da94097884f9d24ee74195df652fd2 |
| a | auth.sso_domains | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.sso_providers | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.users | fab7efcfeab6a65eab8c5f37dd93403f | fab7efcfeab6a65eab8c5f37dd93403f |
| a | auth.webauthn_challenges | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | auth.webauthn_credentials | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | certification_extra.notes | f2bdc233b1ba9619c1b34fd31c45118c | f2bdc233b1ba9619c1b34fd31c45118c |
| a | public.account_class_coverage | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | public.account_dkp_summary | 1d24a6bc25b9eea2b902ffd94e11adfe | 1d24a6bc25b9eea2b902ffd94e11adfe |
| a | public.accounts | 6e920feec6ef8f2b1dd02741f86d0776 | 6e920feec6ef8f2b1dd02741f86d0776 |
| a | public.active_accounts | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | public.active_raiders | 5239cd4dfdd866920135e15928db81b1 | 5239cd4dfdd866920135e15928db81b1 |
| a | public.bid_portfolio_auction_fact | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | public.character_account | ef60466fe5cd06967546a09dfb55fad9 | ef60466fe5cd06967546a09dfb55fad9 |
| a | public.character_dkp_spent | 994e69554966e5d8a9d3ebc2ab59f6d7 | 994e69554966e5d8a9d3ebc2ab59f6d7 |
| a | public.character_loot_assignment_counts | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | public.characters | d765df7e5efb510ff998e04c8de9fd37 | d765df7e5efb510ff998e04c8de9fd37 |
| a | public.dkp_adjustments | 95186257478b21c98edba0d7e39ea084 | 95186257478b21c98edba0d7e39ea084 |
| a | public.dkp_period_totals | 63c0c871f5585a2f726dac35ce81a346 | 63c0c871f5585a2f726dac35ce81a346 |
| a | public.dkp_summary | 460d29fb388463f783ea5915380448e3 | 460d29fb388463f783ea5915380448e3 |
| a | public.loot_assignment | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | public.officer_audit_log | 6e3193a315768487f5cea626be5e752d | 6e3193a315768487f5cea626be5e752d |
| a | public.profiles | d0dfd12b5dfc302e07600830df16556c | d0dfd12b5dfc302e07600830df16556c |
| a | public.raid_attendance | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | public.raid_attendance_dkp | e0d03cf6e4fa75dc8840513a491445c4 | e0d03cf6e4fa75dc8840513a491445c4 |
| a | public.raid_attendance_dkp_by_account | 739f26460bf85fb885b29f479b1c51cb | 739f26460bf85fb885b29f479b1c51cb |
| a | public.raid_classifications | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | public.raid_dkp_totals | a2509b97590731feaaef2f01180fb961 | a2509b97590731feaaef2f01180fb961 |
| a | public.raid_event_attendance | 5343d183a6c15ce0e5369b5bc3ac984b | 5343d183a6c15ce0e5369b5bc3ac984b |
| a | public.raid_events | bdf273e29388b6eed62eebd50efb63f3 | bdf273e29388b6eed62eebd50efb63f3 |
| a | public.raid_loot | 83e3abbabed9dde1c2dc16b6e0b9791a | 83e3abbabed9dde1c2dc16b6e0b9791a |
| a | public.raids | 86c347e1a0855e4cfa90296bc99d8a8c | 86c347e1a0855e4cfa90296bc99d8a8c |
| a | public.restore_in_progress | 5d246b9f1c99f1b9311dde0fa7a56b6f | 4188631e8b2fc1a90b55cee5d5253bbe |
| a | storage.buckets | d6a0eb94e64a6c706b22d6af67a447df | d6a0eb94e64a6c706b22d6af67a447df |
| a | storage.buckets_analytics | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | storage.buckets_vectors | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | storage.iceberg_namespaces | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | storage.iceberg_tables | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | storage.migrations | 8485b30199969469e0149161d5cb8b43 | 8485b30199969469e0149161d5cb8b43 |
| a | storage.objects | d089dd4a8dbfd4c81c3ea13f14799871 | d089dd4a8dbfd4c81c3ea13f14799871 |
| a | storage.s3_multipart_uploads | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | storage.s3_multipart_uploads_parts | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| a | storage.vector_indexes | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.audit_log_entries | 9df2ae8495d0b77a79a436e7bdb77d2b | 9df2ae8495d0b77a79a436e7bdb77d2b |
| b | auth.custom_oauth_providers | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.flow_state | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.identities | 37fd641d631e99b3461f3acf71b6f4f2 | 37fd641d631e99b3461f3acf71b6f4f2 |
| b | auth.instances | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.mfa_amr_claims | 7ef7118b89ba144d306d6f558e519f55 | 7ef7118b89ba144d306d6f558e519f55 |
| b | auth.mfa_challenges | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.mfa_factors | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.mfa_recovery_code_sets | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.mfa_recovery_codes | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.oauth_authorizations | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.oauth_client_states | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.oauth_clients | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.oauth_consents | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.one_time_tokens | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.refresh_tokens | 2d1aafd4a81087010749752c2fed6516 | 2d1aafd4a81087010749752c2fed6516 |
| b | auth.saml_providers | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.saml_relay_states | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.schema_migrations | 33cac503c99c09d6a74d508809afa2d3 | 33cac503c99c09d6a74d508809afa2d3 |
| b | auth.scim_tokens | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.scim_users | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.sessions | b8773e10d77a8838eab14f0bb84ab21d | b8773e10d77a8838eab14f0bb84ab21d |
| b | auth.sso_domains | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.sso_providers | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.users | a67a0546380d1f1e04774cad5b24f1b9 | a67a0546380d1f1e04774cad5b24f1b9 |
| b | auth.webauthn_challenges | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | auth.webauthn_credentials | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | certification_extra.notes | 09ce38e237e4b8718cef69ed0282729c | 09ce38e237e4b8718cef69ed0282729c |
| b | public.account_class_coverage | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.account_dkp_summary | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.accounts | d55251b2e55fa56c2ca3f2bed8a4e6b4 | d55251b2e55fa56c2ca3f2bed8a4e6b4 |
| b | public.active_accounts | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.active_raiders | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.bid_portfolio_auction_fact | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.character_account | b6f6bb3242bd879d669f96306cd63cc7 | b6f6bb3242bd879d669f96306cd63cc7 |
| b | public.character_dkp_spent | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.character_loot_assignment_counts | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.characters | 8d6fdba94833df27f00e3e60dac27a7d | 8d6fdba94833df27f00e3e60dac27a7d |
| b | public.dkp_adjustments | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.dkp_period_totals | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.dkp_summary | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.loot_assignment | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.officer_audit_log | f76d6a428faaf52890c9004668c000e2 | f76d6a428faaf52890c9004668c000e2 |
| b | public.profiles | 0e7da883250a064cba96264abefd91c5 | 0e7da883250a064cba96264abefd91c5 |
| b | public.raid_attendance | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raid_attendance_dkp | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raid_attendance_dkp_by_account | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raid_classifications | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raid_dkp_totals | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raid_event_attendance | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raid_events | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raid_loot | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.raids | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | public.restore_in_progress | 5d246b9f1c99f1b9311dde0fa7a56b6f | 4188631e8b2fc1a90b55cee5d5253bbe |
| b | storage.buckets | 735e019a25c4c9110bf49a152a9c3c21 | 735e019a25c4c9110bf49a152a9c3c21 |
| b | storage.buckets_analytics | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | storage.buckets_vectors | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | storage.iceberg_namespaces | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | storage.iceberg_tables | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | storage.migrations | 87bb58cb45a07c23925e92316948e371 | 87bb58cb45a07c23925e92316948e371 |
| b | storage.objects | 099e6fa012ab1f05bd03eb667d63cdd1 | 099e6fa012ab1f05bd03eb667d63cdd1 |
| b | storage.s3_multipart_uploads | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | storage.s3_multipart_uploads_parts | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |
| b | storage.vector_indexes | d41d8cd98f00b204e9800998ecf8427e | d41d8cd98f00b204e9800998ecf8427e |

| Cycle | Table | Baseline count | Restored count |
| --- | --- | --- | --- |
| a | auth.users | 3 | 3 |
| a | public.characters | 1 | 1 |
| a | public.officer_audit_log | 1 | 1 |
| a | certification_extra.notes | 1 | 1 |
| a | storage.objects | 2 | 2 |
| b | auth.users | 3 | 3 |
| b | public.characters | 1 | 1 |
| b | public.officer_audit_log | 1 | 1 |
| b | certification_extra.notes | 1 | 1 |
| b | storage.objects | 2 | 2 |

Definition text for columns, constraints, indexes, views, functions, triggers, and policies on `public` and `certification_extra` matched. CHECK expressions are compared after flattening associative `AND` and `OR` groups, because replaying `pg_dump` drops redundant parentheses. Grant comparison uses grantee and privilege bits and ignores `supabase_admin` entries: that role owned the source tables and is superuser, and `--no-owner` restores ownership to `postgres`. The restore suspends postgres-owned table default privileges before `CREATE TABLE`, then applies the dumped defaults afterward, so a source `REVOKE` such as the narrower `public.profiles` ACL is not widened by the Supabase defaults. Destination event triggers were disabled for the schema replay and enabled again after the transaction, including when that transaction rolls back. Extension name and version lists matched. Sequence `last_value` and `is_called` matched, and one `nextval` on each sequence returned the baseline's next value.

## Encryption

Each cycle used a new age identity in a temporary directory. The artifact starts with `age-encryption.org/`. Decrypt with the matching identity succeeds. Decrypt with a different identity, a flipped ciphertext byte, a missing `data.sql` member, and a manifest checksum mismatch all fail. The backup command output contained no age secret, database URL, fixture password, or vault plaintext. Those strings are also absent from `data.sql`.

## Auth, Vault, and Storage

Auth: signup and password login succeeded before backup and again after restore on the recreated stack. Officer `is_officer()` is true and the officer can read `officer_audit_log`. The player reads zero audit rows. A user created after restore gets `profiles.role = player` from `on_auth_user_created`.

Vault: `vault.create_secret` decrypted on the source, so the source root key worked. After restore, `vault.secrets` and `vault.decrypted_secrets` are empty. The ciphertext in `full_db_captured.vault__secrets` matches the source ciphertext. Inserting that ciphertext back into `vault.secrets` is rejected. This is captured ciphertext, not a decrypted secret. The pgsodium root key is outside the artifact and was destroyed with the disposable volume.

Storage: bucket and object metadata rows are inside the row hashes above. Object bytes are not in `data.sql`. Cycle a storage upload status was 200 and the post-restore GET status was 500. Cycle b storage upload status was 200 and the post-restore GET status was 500. A successful upload lives on the storage volume. That volume was destroyed with the disposable project, so the recreated project did not return those bytes.

Operational hooks: `supabase_functions.hooks` is empty after restore. The hook name is in `full_db_captured`. `cron.job`, `net.http_request_queue`, and `pgmq.meta` are absent. No cron job, HTTP request, or queue message is armed.

## Default privileges

The source added `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO certification_reader`, owned by `postgres`. That statement is kept. A table created after restore receives `certification_reader:SELECT`.

Default privileges owned by other roles, including `supabase_admin`, are still omitted. An initialized Supabase project already installs those platform defaults, and this run's new-table grants matched across that set because both projects were created by the same CLI. The backup does not restate another role's defaults, and the restore does not try to.

Source and destination default ACL owners were the same string on each cycle: `postgres:public:S,postgres:public:f,postgres:public:r,postgres:storage:S,postgres:storage:f,postgres:storage:r,supabase_admin:extensions:S,supabase_admin:extensions:f,supabase_admin:extensions:r,supabase_admin:graphql:S,supabase_admin:graphql:f,supabase_admin:graphql:r,supabase_admin:graphql_public:S,supabase_admin:graphql_public:f,supabase_admin:graphql_public:r,supabase_admin:public:S,supabase_admin:public:f,supabase_admin:public:r,supabase_admin:realtime:S,supabase_admin:realtime:f,supabase_admin:realtime:r,supabase_admin:supabase_functions:S,supabase_admin:supabase_functions:f,supabase_admin:supabase_functions:r,supabase_auth_admin:auth:S,supabase_auth_admin:auth:f,supabase_auth_admin:auth:r`.

## Restore failures

The SQL load, truncate, publication changes, and foreign-key scan run in one `psql --single-transaction` with `ON_ERROR_STOP=1`. A missing table and a statement raised halfway through left the pre-restore sentinel in place and did not create the backup's extra schema. The process exited non-zero and did not print `restore: committed`. PostgreSQL 16 is refused before any restore SQL. The long-lived port, a remote host, a mismatched marker, a role that cannot set `session_replication_role`, and a catalogued missing extension or role are refused before the load.

## Commands

```powershell
$env:PATH = "C:\TAKP\pg17\pgsql\bin;<WinGet age directory>;$env:PATH"
npx --yes supabase@2.121.0 --version
python scripts/test_full_db.py
python scripts/test_sql_backup.py
python scripts/test_sql_backup_fetch.py
python scripts/test_sql_restore_checkpoint.py
python scripts/test_sql_restore.py
python scripts/test_full_db_certification.py
```

The certification command creates its own temporary projects. It does not read `SQL_BACKUP_AGE_*` and does not write a long-lived `FULL_DB_BACKUP_AGE_*` key.

## Limitations

- Vault plaintext is not recoverable from this artifact on a new project.
- Storage object bytes require a separate backup. This run did not produce one.
- JWT secrets, anon and service-role keys, OAuth provider settings, SMTP, and Edge Function source are project configuration, not catalog rows.
- Custom login role passwords are not stored. `certification_reader` is `NOLOGIN`.
- `ALTER DEFAULT PRIVILEGES` for roles other than `postgres` are not replayed.
- Hosted Postgres was not inventoried and was not a restore target.

Next gate: run the read-only statements in `docs/full-db-hosted-inventory.sql` against an authorized hosted database. Do not add a hosted destructive restore until that inventory is reviewed.
