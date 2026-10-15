#!/usr/bin/env python3
"""Disposable checks for the transactional SQL restore.

Policy checks run without Docker. The two-database test needs Docker, psql,
pg_dump, and age. Set DKP_PG_TEST=1 to fail when those tools are missing.
This test never reads a production database URL.
"""

from __future__ import annotations

import io
import json
import os
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

import sql_backup
import sql_backup_fetch
import sql_restore
from test_sql_backup_fetch import ROOT_NUMERIC, FakeGitHub

ROOT = Path(__file__).resolve().parents[1]
BACKUP_SCRIPT = ROOT / "scripts" / "sql_backup.py"
RESTORE_SCRIPT = ROOT / "scripts" / "sql_restore.py"
REQUIRED = os.environ.get("DKP_PG_TEST") == "1"
PASSWORD = "restore-test-password"
ADMIN_EMAIL = "dest-admin@example.test"
OFFICER_EMAIL = "dest-officer@example.test"
SOURCE_EMAIL = "source-player@example.test"
ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OFFICER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
SOURCE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
AS_OF = date(2026, 10, 14)
SOURCE_REPO = "Ammordius/NAGD-DKP"
CURRENT_REPO = "example/dkp"
FETCH_TOKEN = "github_pat_e2e_not_a_real_token"
WORKFLOW_RUN_ID = 123456789
SQL_ARTIFACT_ID = 9091
CSV_ARTIFACT_ID = 9092

SOURCE_SQL = """
INSERT INTO auth.users (id, email) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'source-player@example.test');

INSERT INTO public.characters (char_id, name, class_name) VALUES
  ('char-linked', 'LinkedToon', 'Warrior'),
  ('char-explicit', 'ExplicitToon', 'Shadow Knight'),
  ('char-name', 'UniqueName', 'Cleric'),
  ('char-a', 'SharedA', 'Rogue'),
  ('char-b', 'SharedB', 'Mage'),
  ('char-old', 'OldToon', 'Warrior');
INSERT INTO public.accounts (account_id, display_name, toon_count) VALUES
  ('acct-linked', 'Linked', 1),
  ('acct-name', 'NameOnly', 1),
  ('acct-shared', 'Shared', 2),
  ('acct-old', 'OldRaid', 1);
INSERT INTO public.character_account (char_id, account_id) VALUES
  ('char-linked', 'acct-linked'),
  ('char-explicit', 'acct-linked'),
  ('char-name', 'acct-name'),
  ('char-a', 'acct-shared'),
  ('char-b', 'acct-shared'),
  ('char-old', 'acct-old');
INSERT INTO public.raids (raid_id, raid_name, date_iso) VALUES
  ('raid-recent', 'Recent', to_char(current_date - 1, 'YYYY-MM-DD')),
  ('raid-old', 'Old', to_char(current_date - 90, 'YYYY-MM-DD'));
INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value) VALUES
  ('raid-recent', '1', 1, 'Boss', '10'),
  ('raid-recent', 'corr', 2, 'Add', '15'),
  ('raid-old', '1', 1, 'Ancient', '4');
UPDATE public.raid_events SET dkp_value = '0' WHERE raid_id = 'raid-recent' AND event_id = 'corr';
INSERT INTO public.raid_attendance (raid_id, char_id, character_name) VALUES
  ('raid-recent', 'char-linked', 'LinkedToon');
INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id) VALUES
  ('raid-recent', '1', 'char-linked', 'LinkedToon', NULL),
  ('raid-recent', '1', 'char-explicit', 'ExplicitToon', 'acct-linked'),
  ('raid-recent', '1', NULL, 'UniqueName', NULL),
  ('raid-recent', '1', 'char-a', 'SharedA', 'acct-shared'),
  ('raid-recent', '1', 'char-b', 'SharedB', 'acct-shared'),
  ('raid-old', '1', 'char-old', 'OldToon', 'acct-old'),
  ('raid-old', '1', NULL, 'ForgottenName', NULL);
INSERT INTO public.raid_loot (raid_id, event_id, item_name, char_id, character_name, cost) VALUES
  ('raid-recent', '1', 'SourceBlade', 'char-linked', 'LinkedToon', '3');
INSERT INTO public.loot_assignment (loot_id, assigned_char_id, assigned_character_name)
SELECT id, 'char-linked', 'LinkedToon' FROM public.raid_loot WHERE item_name = 'SourceBlade';
INSERT INTO public.dkp_adjustments (character_name, earned_delta, spent_delta, account_id) VALUES
  ('LinkedToon', 100, 7, 'acct-linked'),
  ('ExplicitToon', 5, 0, 'acct-linked');
UPDATE public.profiles
SET display_name = 'Source Player',
    ui_preferences = '{"theme":"source"}'::jsonb
WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
INSERT INTO public.raid_classifications (raid_id, mob, zone) VALUES
  ('raid-recent', 'Boss', 'Test Zone');
INSERT INTO public.active_raiders (character_key) VALUES ('char-linked');
INSERT INTO public.active_accounts (account_id) VALUES ('acct-linked');
"""

DEST_SQL = f"""
INSERT INTO public.accounts (account_id, display_name, toon_count) VALUES
  ('acct-linked', 'DEST LINKED', 9),
  ('acct-local-only', 'Local Anchor', 1),
  ('acct-drop', 'Drop Me', 1);
INSERT INTO auth.users (id, email) VALUES
  ('{ADMIN_ID}', '{ADMIN_EMAIL}'),
  ('{OFFICER_ID}', '{OFFICER_EMAIL}');
UPDATE public.profiles
SET role = 'siteadmin',
    display_name = 'Dest Admin',
    account_id = 'acct-linked',
    ui_preferences = '{{"raidNameOnly": false}}'::jsonb
WHERE id = '{ADMIN_ID}';
UPDATE public.profiles
SET role = 'officer',
    display_name = 'Dest Officer',
    account_id = 'acct-local-only',
    ui_preferences = '{{"showTicCharacterPicker": false}}'::jsonb
WHERE id = '{OFFICER_ID}';
INSERT INTO auth.identities (user_id, provider, identity_data) VALUES
  ('{ADMIN_ID}', 'email', '{{"provider":"email"}}'),
  ('{OFFICER_ID}', 'discord', '{{"provider":"discord"}}');
INSERT INTO public.characters (char_id, name) VALUES ('dest-char', 'DestToon');
INSERT INTO public.character_account (char_id, account_id) VALUES ('dest-char', 'acct-drop');
INSERT INTO public.raids (raid_id, raid_name, date_iso) VALUES ('dest-raid', 'Dest', '2020-01-01');
INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value)
VALUES ('dest-raid', '1', 1, 'DestBoss', '99');
INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
VALUES ('dest-raid', '1', 'dest-char', 'DestToon', 'acct-drop');
INSERT INTO public.raid_loot (raid_id, event_id, item_name, char_id, character_name, cost)
VALUES ('dest-raid', '1', 'DestItem', 'dest-char', 'DestToon', '1');
INSERT INTO public.bid_portfolio_auction_fact (loot_id, item_name)
SELECT id, 'DestItem' FROM public.raid_loot WHERE item_name = 'DestItem';
INSERT INTO public.account_class_coverage (account_id, classes) VALUES
  ('acct-local-only', '[]'::jsonb),
  ('acct-drop', '[]'::jsonb);
INSERT INTO public.officer_audit_log (actor_id, actor_email, action, target_type, target_id)
VALUES ('{ADMIN_ID}', '{ADMIN_EMAIL}', 'siteadmin_set_role', 'profile', '{ADMIN_ID}');
"""

SNAPSHOT_SQL = """
SELECT json_build_object(
  'users', (SELECT count(*) FROM auth.users),
  'identities', (SELECT count(*) FROM auth.identities),
  'profiles', (
    SELECT COALESCE(json_agg(json_build_object(
      'id', id, 'role', role, 'account_id', account_id, 'prefs', ui_preferences, 'email', email
    ) ORDER BY id), '[]'::json)
    FROM public.profiles
  ),
  'raids', (SELECT COALESCE(json_agg(raid_id ORDER BY raid_id), '[]'::json) FROM public.raids),
  'audit', (SELECT count(*) FROM public.officer_audit_log),
  'flag', (SELECT in_progress FROM public.restore_in_progress WHERE id = 1),
  'summary', (
    SELECT COALESCE(json_agg(json_build_object('id', account_id, 'earned', earned) ORDER BY account_id), '[]'::json)
    FROM public.account_dkp_summary
  ),
  'coverage', (SELECT count(*) FROM public.account_class_coverage),
  'bids', (SELECT count(*) FROM public.bid_portfolio_auction_fact),
  'accounts', (SELECT COALESCE(json_agg(account_id ORDER BY account_id), '[]'::json) FROM public.accounts),
  'display_guard', (SELECT tgenabled FROM pg_trigger WHERE tgname = 'accounts_display_name_guard')
)::text;
"""


def fail(message: str) -> None:
    raise SystemExit(message)


def check(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def block(columns: list[str], rows: list[tuple]) -> dict:
    return {"columns": columns, "rows": [list(row) for row in rows]}


def sample_blocks() -> dict[str, dict]:
    tables = {
        "characters": block(
            ["char_id", "name"],
            [
                ("char-linked", "LinkedToon"),
                ("char-explicit", "ExplicitToon"),
                ("char-name", "UniqueName"),
                ("char-a", "SharedA"),
                ("char-b", "SharedB"),
                ("char-old", "OldToon"),
            ],
        ),
        "accounts": block(
            ["account_id", "display_name"],
            [
                ("acct-linked", "Linked"),
                ("acct-name", "NameOnly"),
                ("acct-shared", "Shared"),
                ("acct-old", "OldRaid"),
            ],
        ),
        "character_account": block(
            ["char_id", "account_id"],
            [
                ("char-linked", "acct-linked"),
                ("char-explicit", "acct-linked"),
                ("char-name", "acct-name"),
                ("char-a", "acct-shared"),
                ("char-b", "acct-shared"),
                ("char-old", "acct-old"),
            ],
        ),
        "raids": block(
            ["raid_id", "date_iso"],
            [("raid-recent", "2026-10-13"), ("raid-old", "2026-07-16")],
        ),
        "raid_events": block(
            ["id", "raid_id", "event_id", "event_order", "event_name", "dkp_value"],
            [
                ("1", "raid-recent", "1", "1", "Boss", "10"),
                ("3", "raid-recent", "corr", "2", "Add", "0"),
                ("2", "raid-old", "1", "1", "Ancient", "4"),
            ],
        ),
        "raid_attendance": block(
            ["id", "raid_id", "char_id", "character_name"],
            [("1", "raid-recent", "char-linked", "LinkedToon")],
        ),
        "raid_event_attendance": block(
            ["id", "raid_id", "event_id", "char_id", "character_name", "account_id"],
            [
                ("1", "raid-recent", "1", "char-linked", "LinkedToon", None),
                ("6", "raid-recent", "1", "char-explicit", "ExplicitToon", "acct-linked"),
                ("2", "raid-recent", "1", None, "UniqueName", None),
                ("3", "raid-recent", "1", "char-a", "SharedA", "acct-shared"),
                ("4", "raid-recent", "1", "char-b", "SharedB", "acct-shared"),
                ("5", "raid-old", "1", "char-old", "OldToon", "acct-old"),
                ("7", "raid-old", "1", None, "ForgottenName", None),
            ],
        ),
        "raid_loot": block(
            ["id", "raid_id", "char_id", "character_name", "cost"],
            [("1", "raid-recent", "char-linked", "LinkedToon", "3")],
        ),
        "loot_assignment": block(["loot_id"], [("1",)]),
        "dkp_adjustments": block(
            ["character_name", "earned_delta", "account_id"],
            [("LinkedToon", "100", "acct-linked"), ("ExplicitToon", "5", "acct-linked")],
        ),
        "raid_classifications": block(["raid_id", "mob"], [("raid-recent", "Boss")]),
        "active_raiders": block(["character_key"], [("char-linked",)]),
        "active_accounts": block(["account_id"], [("acct-linked",)]),
    }
    check(set(tables) == set(sql_backup.INCLUDED_TABLES), "Sample blocks drifted from the allowlist")
    return tables


LIVE_PROJECT_REF = "ynvwtvphqsevhpytcugj"
POOLER_HOST = "aws-0-us-west-2.pooler.supabase.com"
DESTINATION_NAME = "nagd-dkp"


def hosted_identity_env(**overrides: str) -> dict[str, str]:
    env = {
        "SQL_RESTORE_DESTINATION_NAME": DESTINATION_NAME,
        "SQL_RESTORE_DESTINATION_HOST": POOLER_HOST,
        "SQL_RESTORE_DATABASE_NAME": "postgres",
        "SQL_RESTORE_PROJECT_REF": LIVE_PROJECT_REF,
    }
    env.update(overrides)
    return env


def assert_refused(message: str, call) -> None:
    try:
        call()
    except sql_restore.RestoreError as exc:
        check(message in str(exc), str(exc))
        return
    fail(f"expected refusal containing {message}")


def test_destination_authorization() -> None:
    pooler_user = f"postgres.{LIVE_PROJECT_REF}"
    with patch.dict(os.environ, hosted_identity_env(), clear=False):
        os.environ.pop("GITHUB_ACTIONS", None)
        os.environ.pop("SQL_RESTORE_ALLOW_PRODUCTION", None)
        sql_restore.assert_destination_identity(
            DESTINATION_NAME,
            POOLER_HOST,
            "postgres",
            pooler_user,
            port=5432,
            sslmode="require",
        )
        os.environ["SQL_RESTORE_DESTINATION_HOST"] = f"db.{LIVE_PROJECT_REF}.supabase.co"
        sql_restore.assert_destination_identity(
            DESTINATION_NAME,
            f"db.{LIVE_PROJECT_REF}.supabase.co",
            "postgres",
            "postgres",
            port=5432,
            sslmode="require",
        )
        os.environ["SQL_RESTORE_DESTINATION_HOST"] = POOLER_HOST
    with patch.dict(os.environ, {**hosted_identity_env(), "GITHUB_ACTIONS": "true"}, clear=False):
        sql_restore.assert_destination_identity(
            DESTINATION_NAME,
            POOLER_HOST,
            "postgres",
            pooler_user,
            port=5432,
            sslmode="require",
        )
        assert_refused(
            "approved",
            lambda: sql_restore.assert_destination_identity("disposable-destination", "127.0.0.1", "postgres"),
        )
    with patch.dict(os.environ, hosted_identity_env(), clear=False):
        os.environ.pop("GITHUB_ACTIONS", None)
        sql_restore.assert_destination_identity("disposable-destination", "127.0.0.1", "postgres")
        assert_refused(
            "SQL_RESTORE_PROJECT_REF",
            lambda: sql_restore.assert_destination_identity(
                DESTINATION_NAME,
                POOLER_HOST,
                "postgres",
                "postgres.otherprojectref0001",
                port=5432,
                sslmode="require",
            ),
        )
        os.environ["SQL_RESTORE_PROJECT_REF"] = "otherprojectref0001"
        assert_refused(
            "SQL_RESTORE_PROJECT_REF",
            lambda: sql_restore.assert_destination_identity(
                DESTINATION_NAME,
                POOLER_HOST,
                "postgres",
                pooler_user,
                port=5432,
                sslmode="require",
            ),
        )
        os.environ["SQL_RESTORE_PROJECT_REF"] = LIVE_PROJECT_REF
        assert_refused(
            "SQL_RESTORE_DESTINATION_HOST",
            lambda: sql_restore.assert_destination_identity(
                DESTINATION_NAME,
                "aws-1-us-east-1.pooler.supabase.com",
                "postgres",
                pooler_user,
                port=5432,
                sslmode="require",
            ),
        )
        assert_refused(
            "SQL_RESTORE_DATABASE_NAME",
            lambda: sql_restore.assert_destination_identity(
                DESTINATION_NAME,
                POOLER_HOST,
                "template1",
                pooler_user,
                port=5432,
                sslmode="require",
            ),
        )
        os.environ.pop("SQL_RESTORE_PROJECT_REF", None)
        assert_refused(
            "SQL_RESTORE_PROJECT_REF",
            lambda: sql_restore.assert_destination_identity(
                DESTINATION_NAME,
                POOLER_HOST,
                "postgres",
                pooler_user,
                port=5432,
                sslmode="require",
            ),
        )
        os.environ["SQL_RESTORE_PROJECT_REF"] = LIVE_PROJECT_REF
        assert_refused(
            "project reference",
            lambda: sql_restore.assert_destination_identity(
                DESTINATION_NAME,
                POOLER_HOST,
                "postgres",
                "postgres",
                port=5432,
                sslmode="require",
            ),
        )
        os.environ["SQL_RESTORE_ALLOW_PRODUCTION"] = "true"
        os.environ["SQL_RESTORE_DESTINATION_HOST"] = "evil.example.com"
        assert_refused(
            "approved",
            lambda: sql_restore.assert_destination_identity(
                DESTINATION_NAME,
                "evil.example.com",
                "postgres",
                pooler_user,
                port=5432,
                sslmode="require",
            ),
        )
        check(sql_restore.assert_destination_name(DESTINATION_NAME) == DESTINATION_NAME, "destination label was not read")
        check(sql_restore.assert_destination_name("") == DESTINATION_NAME, "an empty typed name was not replaced by the environment")
        assert_refused(
            "SQL_RESTORE_DESTINATION_NAME",
            lambda: sql_restore.assert_destination_name("other-destination"),
        )
        protected = {
            "protection_rules": [
                {"type": "required_reviewers", "reviewers": [{"type": "User"}]},
            ],
            "deployment_branch_policy": {"protected_branches": False, "custom_branch_policies": True},
        }
        sql_restore.assert_environment_protection(protected, [{"name": "main"}])
        assert_refused(
            "required reviewers",
            lambda: sql_restore.assert_environment_protection(
                {"protection_rules": [], "deployment_branch_policy": None},
                [],
            ),
        )
        assert_refused(
            "only main",
            lambda: sql_restore.assert_environment_protection(protected, [{"name": "main"}, {"name": "develop"}]),
        )
    try:
        sql_restore.assert_host_not_denied(POOLER_HOST, {POOLER_HOST})
        fail("denylist host was allowed")
    except sql_restore.RestoreError as exc:
        check("refused" in str(exc), str(exc))


def test_policy_and_totals() -> None:
    incompatible = {
        "live_schema_status": "incompatible",
        "live_schema_fingerprint": "sha256:" + ("ab" * 32),
        "live_schema_compared_to_repository_file": False,
    }
    try:
        sql_restore.require_restorable_live_schema(incompatible)
        fail("incompatible live schema was restorable")
    except sql_restore.RestoreError as exc:
        check("incompatible" in str(exc), str(exc))
        check("does not apply schema" in str(exc), str(exc))
    unevaluated = sql_restore.require_restorable_live_schema({})
    check(unevaluated["status"] == "not_assessed", "a missing live assessment was treated as compatible")
    secret_name = "BACKUP_ARTIFACT_READ_TOKEN_STAGING"
    previous_token = os.environ.get(secret_name)
    os.environ[secret_name] = "github_pat_test_token_value_not_real"
    try:
        child = sql_restore._psql_env(
            {"host": "127.0.0.1", "port": 5432, "user": "postgres", "password": "secret", "database": "postgres", "sslmode": "disable"},
            read_only=True,
        )
        check(secret_name not in child, "artifact token name was passed to psql")
        check("github_pat_test_token_value_not_real" not in "\n".join(child.values()), "artifact token was passed to psql")
    finally:
        if previous_token is None:
            os.environ.pop(secret_name, None)
        else:
            os.environ[secret_name] = previous_token
    totals = sql_restore.expected_account_totals(sample_blocks(), AS_OF)
    check(
        totals
        == {
            "acct-linked": {"earned": "10", "spent": "3", "balance": "7", "earned_30d": "10", "earned_60d": "10"},
            "acct-name": {"earned": "10", "spent": "0", "balance": "10", "earned_30d": "10", "earned_60d": "10"},
            "acct-old": {"earned": "4", "spent": "0", "balance": "4", "earned_30d": "0", "earned_60d": "0"},
            "acct-shared": {"earned": "10", "spent": "0", "balance": "10", "earned_30d": "10", "earned_60d": "10"},
        },
        f"Independent DKP totals were wrong: {totals}",
    )
    duplicated = sample_blocks()
    duplicated["accounts"]["rows"].append(["acct-linked", "Again"])
    try:
        sql_restore.expected_account_totals(duplicated, AS_OF)
        fail("duplicate account primary key was accepted")
    except sql_restore.RestoreError:
        pass


def restore_env(port: int) -> dict[str, str]:
    env = os.environ.copy()
    for key in (
        "SUPABASE_DB_URL",
        "SQL_RESTORE_DB_URL",
        "SQL_BACKUP_AGE_RECIPIENT",
        "SQL_BACKUP_AGE_IDENTITY",
        "DATABASE_URL",
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGDATABASE",
        "PGSSLMODE",
        "PGOPTIONS",
        "GITHUB_ACTIONS",
        "SQL_RESTORE_ALLOW_PRODUCTION",
        "SQL_RESTORE_PROJECT_REF",
    ):
        env.pop(key, None)
    env["SQL_RESTORE_DB_URL"] = f"postgresql://postgres:{PASSWORD}@127.0.0.1:{port}/postgres?sslmode=disable"
    env["SQL_RESTORE_DESTINATION_NAME"] = "disposable-destination"
    env["SQL_RESTORE_DESTINATION_HOST"] = "127.0.0.1"
    env["SQL_RESTORE_DATABASE_NAME"] = "postgres"
    return env


def test_cli_refuses_unsafe_requests() -> None:
    env = restore_env(6543)
    completed = run_restore(env, ["--bundle-dir", "missing", "--source", "example/dkp", "--destination-name", "disposable-destination"])
    check(completed.returncode != 0, "transaction pooler was accepted")
    check("6543" in completed.stderr or "pooler" in completed.stderr, completed.stderr)
    check(PASSWORD not in completed.stderr, "password was printed")

    env = restore_env(5432)
    env["SQL_RESTORE_DB_URL"] = (
        "postgresql://postgres.otherprojectref0001:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require"
    )
    env["SQL_RESTORE_DESTINATION_HOST"] = "aws-0-us-west-2.pooler.supabase.com"
    env["SQL_RESTORE_DESTINATION_NAME"] = DESTINATION_NAME
    env["SQL_RESTORE_DATABASE_NAME"] = "postgres"
    env["SQL_RESTORE_PROJECT_REF"] = LIVE_PROJECT_REF
    env["SQL_RESTORE_ALLOW_PRODUCTION"] = "true"
    completed = run_restore(
        env,
        ["--bundle-dir", "missing", "--source", "example/dkp", "--destination-name", DESTINATION_NAME],
    )
    check(completed.returncode != 0, "wrong project reference was accepted")
    check("SQL_RESTORE_PROJECT_REF" in completed.stderr, completed.stderr)
    check("secret" not in completed.stderr, "password was printed")

    env = restore_env(5432)
    env["SQL_RESTORE_DB_URL"] = (
        f"postgresql://postgres.{LIVE_PROJECT_REF}:secret@aws-1-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
    )
    env["SQL_RESTORE_DESTINATION_HOST"] = POOLER_HOST
    env["SQL_RESTORE_DESTINATION_NAME"] = DESTINATION_NAME
    env["SQL_RESTORE_DATABASE_NAME"] = "postgres"
    env["SQL_RESTORE_PROJECT_REF"] = LIVE_PROJECT_REF
    completed = run_restore(
        env,
        ["--bundle-dir", "missing", "--source", "example/dkp", "--destination-name", DESTINATION_NAME],
    )
    check(completed.returncode != 0, "wrong hostname was accepted")
    check("SQL_RESTORE_DESTINATION_HOST" in completed.stderr, completed.stderr)
    check("secret" not in completed.stderr, "password was printed")

    env = restore_env(5432)
    env["SQL_RESTORE_DB_URL"] = (
        f"postgresql://postgres.{LIVE_PROJECT_REF}:secret@{POOLER_HOST}:5432/template1?sslmode=require"
    )
    env["SQL_RESTORE_DESTINATION_HOST"] = POOLER_HOST
    env["SQL_RESTORE_DESTINATION_NAME"] = DESTINATION_NAME
    env["SQL_RESTORE_DATABASE_NAME"] = "postgres"
    env["SQL_RESTORE_PROJECT_REF"] = LIVE_PROJECT_REF
    completed = run_restore(
        env,
        ["--bundle-dir", "missing", "--source", "example/dkp", "--destination-name", DESTINATION_NAME],
    )
    check(completed.returncode != 0, "wrong database was accepted")
    check("SQL_RESTORE_DATABASE_NAME" in completed.stderr, completed.stderr)
    check("secret" not in completed.stderr, "password was printed")

    env = restore_env(1)
    completed = run_restore(
        env,
        [
            "--bundle-dir",
            "missing",
            "--source",
            "example/dkp",
            "--destination-name",
            "disposable-destination",
            "--fail-before-commit",
        ],
    )
    check(completed.returncode != 0, "injected failure was accepted")
    check("injected" in completed.stderr, completed.stderr)

    env = restore_env(1)
    env["GITHUB_ACTIONS"] = "true"
    env["GITHUB_EVENT_NAME"] = "workflow_dispatch"
    env["GITHUB_REF"] = "refs/heads/main"
    env["GH_TOKEN"] = ""
    env["GITHUB_TOKEN"] = ""
    completed = run_restore(
        env,
        [
            "--execute",
            "--source",
            "example/dkp",
            "--artifact-id",
            "1",
            "--destination-name",
            "disposable-destination",
            "--confirm",
            "RESTORE disposable-destination",
        ],
    )
    check(completed.returncode != 0, "execute without readable protection was accepted")
    check("protection could not be read" in completed.stderr, completed.stderr)

    env = restore_env(1)
    env["GITHUB_ACTIONS"] = "true"
    env["GITHUB_EVENT_NAME"] = "workflow_dispatch"
    env["GITHUB_REF"] = "refs/heads/main"
    env.pop("GH_TOKEN", None)
    env.pop("GITHUB_TOKEN", None)
    completed = run_restore(
        env,
        [
            "--execute",
            "--source",
            "example/dkp",
            "--artifact-id",
            "1",
            "--expect-artifact-name",
            "sql-backup-20261014T150405Z",
            "--expect-workflow-run-id",
            "9",
            "--expect-sha256",
            "a" * 64,
        ],
    )
    check(completed.returncode != 0, "an unprotected Actions restore was accepted")
    check("required reviewers" in completed.stderr or "protection could not be read" in completed.stderr, completed.stderr)
    check("supabase.co" not in completed.stderr, completed.stderr)


def run_restore(env: dict[str, str], args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RESTORE_SCRIPT), *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def command_exists(name: str) -> bool:
    return subprocess.run(
        ["where" if os.name == "nt" else "which", name],
        capture_output=True,
        text=True,
        check=False,
    ).returncode == 0


def docker_ok() -> bool:
    result = subprocess.run(["docker", "info"], capture_output=True, text=True, check=False)
    return result.returncode == 0


def run_docker(args: list[str], stdin: str | None = None, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", *args],
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )


def psql(container: str, sql: str, timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return run_docker(
        ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
        stdin=sql,
        timeout=timeout,
    )


def wait_for_postgres(container: str) -> None:
    for _ in range(60):
        result = run_docker(["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"], timeout=30)
        if result.returncode == 0:
            return
        time.sleep(1)
    fail("Postgres did not become ready")


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_postgres(name: str, image: str = "postgres:16") -> tuple[str, int]:
    port = free_port()
    run_docker(["rm", "-f", name], timeout=60)
    started = run_docker(
        [
            "run",
            "-d",
            "--name",
            name,
            "-e",
            "POSTGRES_HOST_AUTH_METHOD=trust",
            "-e",
            "POSTGRES_PASSWORD=postgres",
            "-p",
            f"127.0.0.1:{port}:5432",
            image,
        ],
        timeout=180,
    )
    if started.returncode != 0:
        fail(started.stderr or started.stdout or "could not start Postgres")
    wait_for_postgres(name)
    return name, port


def apply_schema(container: str) -> None:
    auth_stub = (ROOT / "web" / "test" / "pg" / "auth-stub.sql").read_text(encoding="utf-8")
    schema = (ROOT / "docs" / "supabase-schema-full.sql").read_text(encoding="utf-8")
    applied_auth = psql(container, auth_stub)
    check(applied_auth.returncode == 0, "auth stub failed:\n" + (applied_auth.stderr or applied_auth.stdout)[-2000:])
    applied_schema = psql(container, schema, timeout=300)
    if applied_schema.returncode != 0:
        fail("canonical schema failed:\n" + (applied_schema.stderr or applied_schema.stdout)[-4000:])


def query(container: str, sql: str) -> str:
    result = psql(container, sql)
    if result.returncode != 0:
        fail("query failed:\n" + (result.stderr or result.stdout)[-2000:])
    return (result.stdout or "").strip()


def age_public_key(key_path: Path) -> str:
    for line in key_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("# public key:"):
            return line.split(":", 1)[1].strip()
    fail("age-keygen did not write a public key")
    return ""


def backup_source(port: int, out_dir: Path, recipient: str) -> None:
    env = os.environ.copy()
    for key in ("SUPABASE_DB_URL", "SQL_BACKUP_AGE_RECIPIENT", "DATABASE_URL", "PGPASSWORD"):
        env.pop(key, None)
    env["SUPABASE_DB_URL"] = f"postgresql://postgres:{PASSWORD}@127.0.0.1:{port}/postgres?sslmode=disable"
    env["SQL_BACKUP_AGE_RECIPIENT"] = recipient
    env["GITHUB_REPOSITORY"] = SOURCE_REPO
    env["GITHUB_REPOSITORY_ID"] = str(ROOT_NUMERIC)
    env["GITHUB_RUN_ID"] = str(WORKFLOW_RUN_ID)
    env["GITHUB_SHA"] = "abc123deadbeef"
    completed = subprocess.run(
        [sys.executable, str(BACKUP_SCRIPT), "--out-dir", str(out_dir)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    combined = completed.stdout + completed.stderr
    check(completed.returncode == 0, "source backup failed:\n" + combined[-4000:])
    check(PASSWORD not in combined, "backup printed the password")
    check(SOURCE_EMAIL not in combined and "LinkedToon" not in combined, "backup printed row data")


def extract_bundle(age_file: Path, key_path: Path, directory: Path) -> None:
    tar_path = directory / "backup.tar.gz"
    decrypted = subprocess.run(
        ["age", "--decrypt", "--identity", str(key_path), "--output", str(tar_path), str(age_file)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    check(decrypted.returncode == 0, "age decrypt failed:\n" + (decrypted.stderr or ""))
    bundle = directory / "bundle"
    bundle.mkdir()
    with tarfile.open(tar_path, "r:gz") as archive:
        try:
            archive.extractall(bundle, filter="data")
        except TypeError:
            archive.extractall(bundle)


def artifact_zip(age_file: Path) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(age_file.name, age_file.read_bytes())
    return buffer.getvalue()


def bind_discovery(client: FakeGitHub, repo: str, age_file: Path, payload: bytes) -> None:
    sql_name = age_file.name.removesuffix(".tar.gz.age")
    run = {
        "id": WORKFLOW_RUN_ID,
        "path": ".github/workflows/db-sql-backup.yml",
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
        "head_sha": "abc123deadbeef",
    }
    sql_artifact = {
        "id": SQL_ARTIFACT_ID,
        "name": sql_name,
        "expired": False,
        "expires_at": "2099-01-01T00:00:00Z",
        "size_in_bytes": len(payload),
        "created_at": "2026-10-14T15:04:05Z",
        "workflow_run": {"id": WORKFLOW_RUN_ID, "head_branch": "main", "head_sha": "abc123deadbeef"},
    }
    csv_artifact = {
        "id": CSV_ARTIFACT_ID,
        "name": "supabase-backup-2026-10-14",
        "expired": False,
        "expires_at": "2099-01-01T00:00:00Z",
        "size_in_bytes": 32,
        "created_at": "2026-10-14T15:04:05Z",
        "workflow_run": {"id": WORKFLOW_RUN_ID, "head_branch": "main", "head_sha": "abc123deadbeef"},
    }
    client.add_json(
        f"/repos/{repo}/actions/workflows/db-sql-backup.yml/runs",
        {"workflow_runs": [run]},
    )
    client.add_json(
        f"/repos/{repo}/actions/runs/{WORKFLOW_RUN_ID}/artifacts",
        {"artifacts": [csv_artifact, sql_artifact]},
    )
    client.add_json(f"/repos/{repo}/actions/runs/{WORKFLOW_RUN_ID}", run)
    client.add_json(f"/repos/{repo}/actions/artifacts/{SQL_ARTIFACT_ID}", sql_artifact)
    client.add_json(f"/repos/{repo}/actions/artifacts/{CSV_ARTIFACT_ID}", csv_artifact)
    client.zips[str(SQL_ARTIFACT_ID)] = payload


def discover_verified_backup(repo: str, current: str, age_file: Path, identity: str, out_dir: Path) -> Path:
    payload = artifact_zip(age_file)
    client = FakeGitHub()
    bind_discovery(client, repo, age_file, payload)
    summary = sql_backup_fetch.fetch(
        source=repo,
        current_repository=current,
        token=FETCH_TOKEN,
        client=client,
        out_dir=out_dir,
        identity=identity,
        now=datetime.now(timezone.utc),
    )
    check("inner_verified: true" in summary, "fetch did not verify the archive:\n" + summary)
    check("format_version: 1" in summary, "fetch did not report format_version:\n" + summary)
    for table in sql_backup.INCLUDED_TABLES:
        check(f"  {table}:" in summary, f"fetch summary omitted {table}")
    check("supabase-backup" not in summary, "fetch selected a CSV artifact:\n" + summary)
    check(FETCH_TOKEN not in summary and PASSWORD not in summary, "fetch summary leaked a secret")
    check(SOURCE_EMAIL not in summary and "LinkedToon" not in summary, "fetch summary printed row data")
    downloaded = out_dir / age_file.name
    check(downloaded.is_file(), "fetch did not write the age file")
    check(downloaded.read_bytes() == age_file.read_bytes(), "downloaded artifact bytes differ from the backup")
    check(downloaded.read_bytes().startswith(b"age-encryption.org/"), "downloaded file is not age ciphertext")
    refused = out_dir / "csv-refused"
    try:
        sql_backup_fetch.fetch(
            source=repo,
            current_repository=current,
            token=FETCH_TOKEN,
            client=client,
            out_dir=refused,
            artifact_id=str(CSV_ARTIFACT_ID),
            identity=identity,
            now=datetime.now(timezone.utc),
        )
        fail("CSV artifact was accepted")
    except sql_backup_fetch.FetchError as exc:
        check("legacy CSV" in str(exc), str(exc))
    check(not refused.exists(), "refused CSV artifact was written for restore")
    return downloaded


def assert_clean_output(completed: subprocess.CompletedProcess[str]) -> None:
    combined = completed.stdout + completed.stderr
    for secret in (PASSWORD, ADMIN_EMAIL, OFFICER_EMAIL, SOURCE_EMAIL, "LinkedToon", "DestToon"):
        check(secret not in combined, f"restore output contained {secret}")


def test_two_databases() -> None:
    missing = [
        name
        for name, present in (
            ("docker", docker_ok()),
            ("psql", command_exists("psql")),
            ("pg_dump", command_exists("pg_dump")),
            ("age", command_exists("age")),
            ("age-keygen", command_exists("age-keygen")),
        )
        if not present
    ]
    if missing:
        message = "Restore database test was not run (missing: " + ", ".join(missing) + ")."
        if REQUIRED:
            fail(message)
        print(message)
        return

    source_name = f"nagddkp-sqlrestore-src-{os.getpid()}"
    dest_name = f"nagddkp-sqlrestore-dst-{os.getpid()}"
    source = dest = None
    try:
        source, source_port = start_postgres(source_name)
        dest, dest_port = start_postgres(dest_name)
        apply_schema(source)
        apply_schema(dest)
        loaded = psql(source, SOURCE_SQL)
        check(loaded.returncode == 0, "source fixture failed:\n" + (loaded.stderr or loaded.stdout)[-4000:])
        loaded = psql(dest, DEST_SQL)
        check(loaded.returncode == 0, "destination fixture failed:\n" + (loaded.stderr or loaded.stdout)[-4000:])
        before = query(dest, SNAPSHOT_SQL)
        check("dest-raid" in before, "destination fixture did not keep its own raid")
        check("false" in before, "destination restore flag did not start clear")

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            key_path = tmp_path / "age-key.txt"
            generated = subprocess.run(
                ["age-keygen", "-o", str(key_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            check(generated.returncode == 0, "age-keygen failed")
            out_dir = tmp_path / "backup"
            out_dir.mkdir()
            backup_source(source_port, out_dir, age_public_key(key_path))
            artifacts = list(out_dir.glob("sql-backup-*.tar.gz.age"))
            check(len(artifacts) == 1, "expected one source backup")
            identity = key_path.read_text(encoding="utf-8")
            same_repo = discover_verified_backup(
                SOURCE_REPO, SOURCE_REPO, artifacts[0], identity, tmp_path / "same-repo"
            )
            cross_repo = discover_verified_backup(
                SOURCE_REPO, CURRENT_REPO, artifacts[0], identity, tmp_path / "cross-repo"
            )
            check(same_repo.read_bytes() == cross_repo.read_bytes(), "cross-repo download differed")
            extract_bundle(same_repo, key_path, tmp_path)
            bundle = tmp_path / "bundle"
            env = restore_env(dest_port)

            dry = run_restore(
                env,
                ["--bundle-dir", str(bundle), "--source", SOURCE_REPO, "--destination-name", "disposable-destination"],
            )
            assert_clean_output(dry)
            check(dry.returncode == 0, "dry-run failed:\n" + (dry.stderr or dry.stdout)[-4000:])
            check("writes: none" in dry.stdout, "dry-run did not report that it was read-only")
            check("schema_compatibility: formatting/comment-only" in dry.stdout, dry.stdout)
            check("live_schema_status: compatible" in dry.stdout, "dry-run omitted the live schema status")
            check("live_schema_compared_to_repository_file: false" in dry.stdout, "dry-run compared the repository file")
            check("restore_compatibility: compatible" in dry.stdout, "dry-run omitted restore compatibility")
            check("schema_apply: false" in dry.stdout, "dry-run applied schema")
            check("acct-linked earned=10 spent=3 balance=7" in dry.stdout, "dry-run DKP report was wrong")
            check("claims_preserved_absent:\n  acct-local-only" in dry.stdout, "dry-run missed the preserved claim")
            check(query(dest, SNAPSHOT_SQL) == before, "dry-run wrote to the destination")

            failed_env = dict(env)
            failed_env["DKP_SQL_RESTORE_TEST_FAIL"] = "1"
            failed = run_restore(
                failed_env,
                [
                    "--execute",
                    "--fail-before-commit",
                    "--bundle-dir",
                    str(bundle),
                    "--source",
                    SOURCE_REPO,
                    "--destination-name",
                    "disposable-destination",
                    "--confirm",
                    "RESTORE disposable-destination",
                ],
            )
            assert_clean_output(failed)
            check(failed.returncode != 0, "intentional failure exited 0")
            check("intentional restore failure" in failed.stderr, failed.stderr[-2000:])
            check(query(dest, SNAPSHOT_SQL) == before, "failed restore did not roll back")
            check(query(dest, "SELECT in_progress::text FROM public.restore_in_progress WHERE id = 1;") == "false", "restore flag stuck")

            restored = run_restore(
                env,
                [
                    "--execute",
                    "--bundle-dir",
                    str(bundle),
                    "--source",
                    SOURCE_REPO,
                    "--destination-name",
                    "disposable-destination",
                    "--confirm",
                    "RESTORE disposable-destination",
                ],
            )
            assert_clean_output(restored)
            check(restored.returncode == 0, "restore failed:\n" + (restored.stderr or restored.stdout)[-4000:])
            check("writes: committed" in restored.stdout, "restore did not report a commit")
            assert_restored_destination(dest)

            sequence_probe = psql(
                dest,
                """
BEGIN;
DO $$
DECLARE
  new_id bigint;
  previous_max bigint;
BEGIN
  SELECT COALESCE(MAX(id), 0) INTO previous_max FROM public.raid_events;
  INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value)
  VALUES ('raid-recent', 'seq', 9, 'Seq', '1')
  RETURNING id INTO new_id;
  IF new_id <> previous_max + 1 THEN
    RAISE EXCEPTION 'sequence probe mismatch';
  END IF;
END $$;
ROLLBACK;
""",
            )
            check(sequence_probe.returncode == 0, "sequence probe failed:\n" + (sequence_probe.stderr or sequence_probe.stdout)[-2000:])
            check(query(dest, "SELECT count(*) FROM public.raid_events WHERE event_id = 'seq';") == "0", "sequence probe row remained")

            trigger_probe = psql(
                dest,
                """
BEGIN;
INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value)
VALUES ('raid-recent', 'probe', 8, 'Probe', '7');
INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
VALUES ('raid-recent', 'probe', 'char-linked', 'LinkedToon', 'acct-linked');
DO $$
BEGIN
  IF (SELECT earned::int FROM public.account_dkp_summary WHERE account_id = 'acct-linked') <> 17 THEN
    RAISE EXCEPTION 'trigger probe mismatch';
  END IF;
END $$;
ROLLBACK;
""",
            )
            check(trigger_probe.returncode == 0, "trigger probe failed:\n" + (trigger_probe.stderr or trigger_probe.stdout)[-2000:])
            check(query(dest, "SELECT earned::int::text FROM public.account_dkp_summary WHERE account_id = 'acct-linked';") == "10", "trigger probe changed committed DKP")
            check(query(dest, "SELECT in_progress::text FROM public.restore_in_progress WHERE id = 1;") == "false", "restore flag stuck after probes")

            summary_before = query(dest, "SELECT earned::int::text || ':' || spent::int::text FROM public.account_dkp_summary ORDER BY account_id;")
            attendance_before = query(dest, "SELECT count(*) FROM public.raid_event_attendance;")
            again = run_restore(
                env,
                [
                    "--execute",
                    "--bundle-dir",
                    str(bundle),
                    "--source",
                    SOURCE_REPO,
                    "--destination-name",
                    "disposable-destination",
                    "--confirm",
                    "RESTORE disposable-destination",
                ],
            )
            assert_clean_output(again)
            check(again.returncode == 0, "second restore failed:\n" + (again.stderr or again.stdout)[-4000:])
            check(query(dest, "SELECT count(*) FROM public.raid_event_attendance;") == attendance_before, "second restore duplicated attendance")
            check(
                query(dest, "SELECT earned::int::text || ':' || spent::int::text FROM public.account_dkp_summary ORDER BY account_id;")
                == summary_before,
                "second restore changed DKP totals",
            )
            assert_restored_destination(dest)
    finally:
        if source:
            run_docker(["rm", "-f", source], timeout=60)
        if dest:
            run_docker(["rm", "-f", dest], timeout=60)


def assert_restored_destination(container: str) -> None:
    totals = query(
        container,
        """
SELECT string_agg(account_id || ':' || earned::int || ':' || spent::int || ':' || earned_30d || ':' || earned_60d, ',' ORDER BY account_id)
FROM public.account_dkp_summary;
""",
    )
    check(
        totals == "acct-linked:10:3:10:10,acct-name:10:0:10:10,acct-old:4:0:0:0,acct-shared:10:0:10:10",
        f"restored DKP totals were wrong: {totals}",
    )
    check(query(container, "SELECT earned_delta::int::text FROM public.dkp_adjustments WHERE character_name = 'LinkedToon';") == "100", "adjustment row was lost")
    check(query(container, "SELECT earned_delta::int::text FROM public.dkp_adjustments WHERE character_name = 'ExplicitToon';") == "5", "tic correction adjustment was lost")
    check(query(container, "SELECT count(*) FROM public.raids;") == "2", "raid count was wrong")
    check(query(container, "SELECT count(*) FROM public.raid_events;") == "3", "tic count was wrong")
    check(query(container, "SELECT dkp_value FROM public.raid_events WHERE event_id = 'corr';") == "0", "corrected tic value was wrong")
    check(query(container, "SELECT count(*) FROM public.raid_event_attendance;") == "7", "attendance count was wrong")
    check(
        query(container, "SELECT count(*) FROM public.raid_event_attendance WHERE character_name = 'ForgottenName' AND char_id IS NULL AND account_id IS NULL;")
        == "1",
        "historical name-only attendance was lost",
    )
    check(query(container, "SELECT count(*) FROM public.raid_loot;") == "1", "loot count was wrong")
    check(query(container, "SELECT cost FROM public.raid_loot;") == "3", "loot cost was wrong")
    check(query(container, "SELECT count(*) FROM public.character_account;") == "6", "character mapping count was wrong")
    check(
        query(container, "SELECT account_id FROM public.raid_event_attendance WHERE char_id = 'char-explicit';") == "acct-linked",
        "explicit account id was lost",
    )
    check(query(container, "SELECT count(*) FROM auth.users;") == "2", "destination auth users changed")
    check(query(container, f"SELECT count(*) FROM auth.users WHERE email = '{SOURCE_EMAIL}';") == "0", "source auth user was copied")
    check(query(container, f"SELECT count(*) FROM public.profiles WHERE email = '{SOURCE_EMAIL}';") == "0", "source profile was copied")
    check(query(container, "SELECT count(*) FROM public.profiles WHERE display_name = 'Source Player';") == "0", "source profile name was copied")
    check(query(container, "SELECT count(*) FROM auth.identities WHERE provider = 'discord';") == "1", "destination sign-in method changed")
    check(
        query(container, f"SELECT role || ':' || account_id FROM public.profiles WHERE id = '{ADMIN_ID}';") == "siteadmin:acct-linked",
        "site admin claim changed",
    )
    check(
        query(container, f"SELECT ui_preferences->>'raidNameOnly' FROM public.profiles WHERE id = '{ADMIN_ID}';") == "false",
        "site admin preference changed",
    )
    check(
        query(container, f"SELECT role || ':' || account_id FROM public.profiles WHERE id = '{OFFICER_ID}';") == "officer:acct-local-only",
        "officer claim changed",
    )
    check(
        query(container, f"SELECT ui_preferences->>'showTicCharacterPicker' FROM public.profiles WHERE id = '{OFFICER_ID}';") == "false",
        "officer preference changed",
    )
    check(query(container, "SELECT display_name FROM public.accounts WHERE account_id = 'acct-linked';") == "Linked", "snapshot account columns were not applied")
    check(query(container, "SELECT count(*) FROM public.accounts WHERE account_id = 'acct-local-only';") == "1", "preserved account was deleted")
    check(query(container, "SELECT count(*) FROM public.accounts WHERE account_id = 'acct-drop';") == "0", "unclaimed destination account remained")
    check(query(container, "SELECT count(*) FROM public.account_class_coverage WHERE account_id = 'acct-local-only';") == "1", "preserved coverage was deleted")
    check(query(container, "SELECT count(*) FROM public.account_class_coverage WHERE account_id = 'acct-drop';") == "0", "dropped coverage remained")
    check(query(container, "SELECT count(*) FROM public.raids WHERE raid_id = 'dest-raid';") == "0", "destination raid remained")
    check(query(container, "SELECT count(*) FROM public.bid_portfolio_auction_fact;") == "0", "bidding facts remained")
    check(query(container, "SELECT count(*) FROM public.officer_audit_log WHERE action = 'siteadmin_set_role';") == "1", "audit log changed")
    check(query(container, "SELECT in_progress::text FROM public.restore_in_progress WHERE id = 1;") == "false", "restore flag was left set")
    check(query(container, "SELECT tgenabled FROM pg_trigger WHERE tgname = 'accounts_display_name_guard';") == "O", "display name guard was left disabled")
    check(query(container, "SELECT count(*) FROM public.loot_assignment;") == "1", "loot assignment count was wrong")


def quoted_copy(table: str, columns: list[str], body: list[str]) -> str:
    column_sql = ", ".join(f'"{column}"' for column in columns)
    header = f'COPY "public"."{table}" ({column_sql}) FROM stdin;'
    if not body:
        return header + "\n\\."
    return header + "\n" + "\n".join(body) + "\n\\."


def empty_copy_fixture() -> dict[str, tuple[list[str], list[str]]]:
    """COPY bodies for the eight regression cases.

    Zero-row tables have an empty body list. A real empty string is a body
    line, including a completely blank line for a single-column table.
    """
    return {
        "characters": (["char_id", "name"], ["char-linked\tLinkedToon", "char-blank\t"]),
        "accounts": (["account_id", "display_name"], ["acct-linked\tLinked"]),
        "character_account": (["char_id", "account_id"], ["char-linked\tacct-linked", "char-blank\tacct-linked"]),
        "raids": (["raid_id", "date_iso", "url"], ["raid-recent\t2026-10-13\t"]),
        "raid_events": (
            ["id", "raid_id", "event_id", "event_order", "event_name", "dkp_value"],
            ["1\traid-recent\t1\t1\tBoss\t10"],
        ),
        "raid_attendance": (
            ["id", "raid_id", "char_id", "character_name"],
            ["1\traid-recent\tchar-linked\tLinkedToon"],
        ),
        "raid_event_attendance": (
            ["id", "raid_id", "event_id", "char_id", "character_name", "account_id"],
            ["1\traid-recent\t1\tchar-linked\tLinkedToon\t\\N", "2\traid-recent\t1\t\\N\t\t\\N"],
        ),
        "raid_loot": (["id", "raid_id", "item_name", "cost"], []),
        "loot_assignment": (["loot_id", "assigned_char_id", "assigned_character_name"], []),
        "dkp_adjustments": (["character_name", "earned_delta", "spent_delta", "account_id"], []),
        "raid_classifications": (["raid_id", "mob", "zone"], []),
        "active_raiders": (["character_key"], [""]),
        "active_accounts": (["account_id"], []),
    }


def empty_copy_sql() -> str:
    fixture = empty_copy_fixture()
    check(set(fixture) == set(sql_backup.INCLUDED_TABLES), "Empty COPY fixture drifted from the allowlist")
    return "\n".join(quoted_copy(table, columns, body) for table, (columns, body) in fixture.items()) + "\n"


def generated_copy(script: str, table: str) -> str:
    marker = f"COPY pg_temp.stage_{table} ("
    start = script.find(marker)
    check(start >= 0, f"restore SQL omitted COPY for {table}")
    end = script.find("\n\\.", start)
    check(end >= 0, f"COPY for {table} has no terminator")
    return script[start : end + 3]


def copy_payload(script: str, table: str) -> str:
    block = generated_copy(script, table)
    marker = "FROM stdin;\n"
    check(marker in block, f"{table} COPY header is malformed")
    return block.split(marker, 1)[1]


def test_empty_copy_serialization() -> None:
    fixture = empty_copy_fixture()
    sql_text = empty_copy_sql()
    blocks = sql_backup.parse_copy_blocks(sql_text)
    sql_backup.require_allowlist(blocks)
    manifest = {"row_counts": {table: len(blocks[table]["rows"]) for table in sql_backup.INCLUDED_TABLES}}
    for table, (_columns, body) in fixture.items():
        check(len(blocks[table]["rows"]) == len(body), f"parser dropped a {table} row")
    script = sql_restore.build_restore_sql(sql_text, blocks, {}, manifest=manifest, fail_before_commit=False)
    bad_counts = dict(manifest["row_counts"])
    bad_counts["active_accounts"] = 1
    try:
        sql_restore.build_restore_sql(
            sql_text,
            blocks,
            {},
            manifest={"row_counts": bad_counts},
            fail_before_commit=False,
        )
        fail("manifest count mismatch was emitted as restore SQL")
    except sql_restore.RestoreError as exc:
        check("active_accounts" in str(exc), str(exc))

    empty_single = copy_payload(script, "active_accounts")
    check(empty_single == "\\.", "empty single-column COPY gained a blank data row: " + repr(empty_single))
    empty_multi = copy_payload(script, "raid_classifications")
    check(empty_multi == "\\.", "empty multi-column COPY gained a blank data row: " + repr(empty_multi))
    for table, (_columns, body) in fixture.items():
        payload = copy_payload(script, table)
        if not body:
            check(payload == "\\.", f"{table} zero-row COPY gained a data row")
            continue
        check(payload == "\n".join(body) + "\n\\.", f"{table} COPY body was rewritten: " + repr(payload))
    characters = copy_payload(script, "characters")
    check("char-linked\tLinkedToon\nchar-blank\t\n\\." == characters, "populated COPY body changed")
    attendance = copy_payload(script, "raid_event_attendance")
    check("\\N" in attendance and attendance.count("\\N") == 3, "NULL fields were rewritten")
    check(copy_payload(script, "active_raiders") == "\n\\.", "empty-string data row was dropped")
    check("char-blank\t\n" in characters, "empty-string field was dropped")
    check("COPY pg_temp.stage_active_accounts " in script and "COPY pg_temp.stage_characters " in script, "mixed COPY script dropped a table")
    count_at = script.find("staged active_accounts count does not match the backup")
    delete_at = script.find("DELETE FROM")
    check(count_at >= 0 and delete_at >= 0 and count_at < delete_at, "stage count check is not before DELETE")


EMPTY_COPY_SOURCE_SQL = """
INSERT INTO public.characters (char_id, name) VALUES
  ('char-linked', 'LinkedToon'),
  ('char-blank', '');
INSERT INTO public.accounts (account_id, display_name) VALUES ('acct-linked', 'Linked');
INSERT INTO public.character_account (char_id, account_id) VALUES
  ('char-linked', 'acct-linked'),
  ('char-blank', 'acct-linked');
INSERT INTO public.raids (raid_id, raid_name, date_iso, url) VALUES
  ('raid-recent', 'Recent', to_char(current_date - 1, 'YYYY-MM-DD'), '');
INSERT INTO public.raid_events (raid_id, event_id, event_order, event_name, dkp_value) VALUES
  ('raid-recent', '1', 1, 'Boss', '10');
INSERT INTO public.raid_attendance (raid_id, char_id, character_name) VALUES
  ('raid-recent', 'char-linked', 'LinkedToon');
INSERT INTO public.raid_event_attendance (raid_id, event_id, char_id, character_name, account_id) VALUES
  ('raid-recent', '1', 'char-linked', 'LinkedToon', NULL),
  ('raid-recent', '1', NULL, '', NULL);
INSERT INTO public.active_raiders (character_key) VALUES ('');
"""

EMPTY_COPY_SEED_SQL = """
INSERT INTO public.accounts (account_id, display_name) VALUES ('acct-seed', 'Seed');
INSERT INTO public.characters (char_id, name) VALUES ('char-seed', 'SeedToon');
INSERT INTO public.raids (raid_id, raid_name, date_iso) VALUES ('raid-seed', 'Seed', '2020-01-01');
"""


def destination_guard(container: str) -> str:
    return query(
        container,
        """
SELECT
  (SELECT count(*) FROM public.raids WHERE raid_id = 'raid-seed')::text || ':' ||
  (SELECT count(*) FROM public.characters WHERE char_id = 'char-seed')::text || ':' ||
  (SELECT count(*) FROM public.accounts WHERE account_id = 'acct-seed')::text || ':' ||
  (SELECT in_progress::text FROM public.restore_in_progress WHERE id = 1) || ':' ||
  (SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'accounts_display_name_guard');
""",
    )


def test_empty_copy_postgres() -> None:
    missing = [
        name
        for name, present in (
            ("docker", docker_ok()),
            ("psql", command_exists("psql")),
            ("pg_dump", command_exists("pg_dump")),
            ("age", command_exists("age")),
            ("age-keygen", command_exists("age-keygen")),
        )
        if not present
    ]
    if missing:
        message = "Empty COPY database test was not run (missing: " + ", ".join(missing) + ")."
        if REQUIRED:
            fail(message)
        print(message)
        return

    source_name = f"nagddkp-emptycopy-src-{os.getpid()}"
    dest_name = f"nagddkp-emptycopy-dst-{os.getpid()}"
    source = dest = None
    try:
        source, source_port = start_postgres(source_name, "postgres:17")
        dest, dest_port = start_postgres(dest_name, "postgres:17")
        apply_schema(source)
        apply_schema(dest)
        loaded = psql(source, EMPTY_COPY_SOURCE_SQL)
        check(loaded.returncode == 0, "empty COPY source fixture failed:\n" + (loaded.stderr or loaded.stdout)[-4000:])
        seeded = psql(dest, EMPTY_COPY_SEED_SQL)
        check(seeded.returncode == 0, "empty COPY destination seed failed:\n" + (seeded.stderr or seeded.stdout)[-2000:])
        before = destination_guard(dest)
        check(before == "1:1:1:false:O", "destination seed was not ready: " + before)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            key_path = tmp_path / "age-key.txt"
            generated = subprocess.run(
                ["age-keygen", "-o", str(key_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            check(generated.returncode == 0, "age-keygen failed")
            out_dir = tmp_path / "backup"
            out_dir.mkdir()
            backup_source(source_port, out_dir, age_public_key(key_path))
            artifacts = list(out_dir.glob("sql-backup-*.tar.gz.age"))
            check(len(artifacts) == 1, "expected one empty COPY backup")
            extract_bundle(artifacts[0], key_path, tmp_path)
            bundle = tmp_path / "bundle"
            manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
            check(manifest["row_counts"]["active_accounts"] == 0, "backup did not record active_accounts as empty")
            check(manifest["row_counts"]["raid_classifications"] == 0, "backup did not record a multi-column table as empty")
            check(manifest["row_counts"]["active_raiders"] == 1, "backup dropped the empty-string raider")
            env = restore_env(dest_port)

            failed_env = dict(env)
            failed_env["DKP_SQL_RESTORE_TEST_FAIL"] = "1"
            failed = run_restore(
                failed_env,
                [
                    "--execute",
                    "--fail-before-commit",
                    "--bundle-dir",
                    str(bundle),
                    "--source",
                    SOURCE_REPO,
                    "--destination-name",
                    "disposable-destination",
                    "--confirm",
                    "RESTORE disposable-destination",
                ],
            )
            check(failed.returncode != 0, "intentional empty COPY failure exited 0")
            check("intentional restore failure" in failed.stderr, failed.stderr[-2000:])
            check(destination_guard(dest) == before, "intentional failure did not roll back")

            sql_text = (bundle / "data.sql").read_text(encoding="utf-8")
            blocks = sql_restore.parsed_blocks(sql_text)
            sql_restore.require_parsed_counts(blocks, manifest)
            as_of = date.fromisoformat(query(dest, "SELECT current_date::text;"))
            totals = sql_restore.expected_account_totals(blocks, as_of)
            script = sql_restore.build_restore_sql(
                sql_text,
                blocks,
                totals,
                manifest=manifest,
                fail_before_commit=False,
            )
            count_at = script.find("staged active_accounts count does not match the backup")
            delete_at = script.find("DELETE FROM")
            check(count_at >= 0 and delete_at >= 0 and count_at < delete_at, "stage count check is not before DELETE")
            tampered = script.replace(
                "IS DISTINCT FROM 0 THEN\n  RAISE EXCEPTION 'staged active_accounts count does not match the backup';",
                "IS DISTINCT FROM 1 THEN\n  RAISE EXCEPTION 'staged active_accounts count does not match the backup';",
                1,
            )
            check(tampered != script, "could not inject a staged count mismatch")
            mismatched = psql(dest, tampered, timeout=300)
            check(mismatched.returncode != 0, "staged count mismatch was accepted")
            check("staged active_accounts count does not match the backup" in (mismatched.stderr or ""), mismatched.stderr[-2000:])
            check(destination_guard(dest) == before, "count mismatch deleted destination rows")

            restored = run_restore(
                env,
                [
                    "--execute",
                    "--bundle-dir",
                    str(bundle),
                    "--source",
                    SOURCE_REPO,
                    "--destination-name",
                    "disposable-destination",
                    "--confirm",
                    "RESTORE disposable-destination",
                ],
            )
            check(restored.returncode == 0, "empty COPY restore failed:\n" + (restored.stderr or restored.stdout)[-4000:])
            for table in sql_backup.INCLUDED_TABLES:
                got = query(dest, f"SELECT count(*) FROM public.{table};")
                check(got == str(manifest["row_counts"][table]), f"{table} loaded {got} rows, manifest has {manifest['row_counts'][table]}")
            check(query(dest, "SELECT count(*) FROM public.raids WHERE url = '';") == "1", "empty-string field was not loaded")
            check(query(dest, "SELECT count(*) FROM public.raids WHERE url IS NULL;") == "0", "empty string was stored as NULL")
            check(
                query(dest, "SELECT count(*) FROM public.raid_event_attendance WHERE account_id IS NULL;") == "2",
                "NULL account_id was not loaded",
            )
            check(query(dest, "SELECT count(*) FROM public.active_raiders WHERE character_key = '';") == "1", "empty-string row was not loaded")
            check(query(dest, "SELECT count(*) FROM public.active_accounts;") == "0", "zero-row active_accounts gained a row")
            check(query(dest, "SELECT count(*) FROM public.raid_classifications;") == "0", "zero-row multi-column table gained a row")
            check(destination_guard(dest).endswith(":false:O"), "restore flag or display-name guard was left wrong")
            check(query(dest, "SELECT count(*) FROM public.raids WHERE raid_id = 'raid-seed';") == "0", "seed raid survived the committed restore")
    finally:
        if source:
            run_docker(["rm", "-f", source], timeout=60)
        if dest:
            run_docker(["rm", "-f", dest], timeout=60)


def main() -> None:
    test_destination_authorization()
    test_policy_and_totals()
    test_cli_refuses_unsafe_requests()
    test_empty_copy_serialization()
    test_empty_copy_postgres()
    test_two_databases()
    print("SQL restore tests passed")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            print(exc.code, file=sys.stderr)
            sys.exit(1)
        raise
