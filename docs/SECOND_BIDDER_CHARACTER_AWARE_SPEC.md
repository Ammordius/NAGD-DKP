# Second bidder — character-aware MVP spec

## Core concept

We estimate **relative** plausibility that an **account** was the second serious bidder. The score must combine:

1. **Affordability / pool posture** — reconstructed DKP, eligibility at auction time (observable proxies only).
2. **Aggregated character bid plausibility** — **candidate identity is the attending account**; character **lanes** come from the union of (a) any attendance-linked `char_id`s for that raid scope and (b) every character that already has **prior** revealed spend or win history on that account in `KnowledgeState` (known purchases before this event, leak-free). Each lane is scored for **active investment** and **item fit** from that same prior knowledge.

**Combination (configurable):** After per-event normalization of feature groups among candidates,

`raw_player = w_affordability * afford_dot + w_propensity * prop_dot + w_competitiveness * comp_dot + w_character * char_dot`

Optional **hard suppression:** if no **item-eligible** character lane clears **active-lane** thresholds, the **raw** aggregated character score is crushed toward `inactive_player_char_floor` before normalization (near-zero plausibility).

We do **not** claim calibrated P(second bidder) or hidden historical gear.

## Character unit of inference

For each candidate **account** and each `char_id` in **union**(attendance-linked chars, chars with prior `account_char_spent` or `char_win_history` for that account):

`character_bid_plausibility ≈ elig_gate × active_toon_strength × item_relevance_proxy × spend_willingness_proxy`

All factors use **KnowledgeState strictly before** the current sale (sequential pipeline) + current event metadata (`norm_name`, `item_name`, `loot_id`).

### Eligibility gates

- **Account-level (existing):** If `eligible_account_ids` is set, account must be in the set (else excluded in `build_candidate_pool`).
- **Character-level (optional):** If `eligible_chars_by_loot_id[loot_id]` is set, only pairs `(account_id, char_id)` in that set get `elig_gate = 1`; others get `elig_gate = 0` (excluded from aggregation).
- **Fallback:** If character-level map is absent, `elig_gate = 1` for all attending characters once the account passed the account filter.

### Active toon strength (revealed investment)

Proxies (no gear inference):

- Lifetime DKP spent on that character (`account_char_spent`).
- **Share of account spend:** `char_spent / max(account_total_spent, ε)`.
- Prior win count on that character.
- Recency-weighted “any item” wins on that character (decay by event index).

**Dormant lane:** If `char_spent < min_active_char_lifetime_spend` **or** `share < min_char_share_of_account_spend`, apply `dormant_char_multiplier` (strong downweight). Sibling context: negligible spend (e.g. 7 vs 700–1300) fails thresholds and is downweighted.

### Item–character fit

- Recency-weighted prior wins on **same `norm_name`** for **that character** (from `char_win_history`).
- Optional: same `item_name` prior wins on that character (sparse).

### Spend willingness proxy

Combines share and `log1p(char_spend)` (smooth, monotone). Not a claim about marginal utility.

## Player-level aggregation

Given positive per-character plausibilities (after gates; zeros drop out of logsumexp in practice):

| Method | Rule |
|--------|------|
| `max` | `max_c plausibility(c)` |
| `top_k_sum` | Sum of top `aggregation_top_k` values |
| `logsumexp` | `temperature * log(Σ exp(plausibility(c) / temperature))` |

Configurable via `character_aggregation`, `aggregation_top_k`, `logsumexp_temperature`.

## No known character lanes before the event

If the union is **empty** (no attendance `char_id`s and no prior per-character purchases recorded in state for that account), we apply `empty_attendee_chars_multiplier` to the aggregated character score (soft penalty). Hard exclusion is optional via `exclude_accounts_with_no_attendee_chars` (default false), which still keys off attendance-only char resolution for pool quality checks.

## Competitiveness (player-level)

Besides mean win cost, paid-to-ref, and win count, the scorer uses two **hoarding / dry-powder** proxies after per-candidate normalization:

- **`hoarding_char_lane`:** `pool / (1 + max prior per-character spend)` — sensitive to multi-toon “main” lanes.
- **`hoarding_account_total`:** `pool / (1 + prior account total spent)` — matches the original MVP spec and downweights lifetime whales with huge banks relative to their burn history.

## Config summary

See `SecondBidderConfig` in `scripts/second_bidder_model/config.py` for defaults and tuning:

- Lane thresholds: `min_active_char_lifetime_spend`, `min_char_share_of_account_spend`
- `dormant_char_multiplier`, `inactive_player_char_floor`, `empty_attendee_chars_multiplier`
- Aggregation: `character_aggregation`, `aggregation_top_k`, `logsumexp_temperature`
- Capability caps: `capability_pool_cap`, `capability_dkp_ratio_cap` (soften extreme wallets before min–max)
- Weights: `w_character`, `w_affordability` (with legacy `w_capability`, `w_propensity`, `w_competitiveness` for backward compatibility)

## Debug output

Per candidate account, emit per-character rows: eligibility, spends, share, active score, item fit, willingness, product, then aggregated character score, affordability components, penalties / notes.

## Leakage

`char_win_history` and all spend tallies are updated in `update_knowledge_state` **only after** scoring the current event.
