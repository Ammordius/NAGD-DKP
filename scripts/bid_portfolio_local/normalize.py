"""Mirror web/src/lib/itemNameNormalize.js and public.raid_date_parsed (supabase-schema-full.sql)."""

from __future__ import annotations

import re
from datetime import date
from typing import Optional


def normalize_item_name_for_lookup(name: Optional[str]) -> str:
    if not name or not isinstance(name, str):
        return ""
    s = name.strip()
    for c in ("'", "'", "`", "\u2019", "\u2018"):
        s = s.replace(c, "")
    s = s.replace("-", " ")
    s = s.lower()
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^[,.;:!?]+|[,.;:!?]+$", "", s)
    return s


def raid_date_parsed(iso_text: Optional[str]) -> Optional[date]:
    if iso_text is None:
        return None
    t = iso_text.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}", t):
        try:
            y, m, d = int(t[0:4]), int(t[5:7]), int(t[8:10])
            return date(y, m, d)
        except ValueError:
            return None
    return None
