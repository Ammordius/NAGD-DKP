# Second bidder inference — MVP spec (internal)

## A. Problem statement

**Target quantity:** For a historical guild loot sale (positive DKP price, known winner), estimate a **distribution over accounts** for who was most plausibly the **second-highest serious bidder**, written informally as P(second bidder | item, player, context).

**Observable (typical):** attendance (raid / tic scope), winner and price, cumulative purchase history over time, character `class_name` / `level` from `characters.csv`, static item class/level from `item_stats.json` (TAKP AllaClone parse), optional Magelo-style eligibility JSON (intersected with derived pairs when both are present).

**Not observable:** Actual bid logs, historical equipped gear, true willingness-to-pay.

**Nature of model:** A **proxy scorer** with explicit filters and interpretable features. Outputs are **relative probabilities** among a constructed candidate pool, not calibrated real-world probabilities.

---

## B. Candidate pool reconstruction

**Function:** `build_candidate_pool(event, bc, state, config) -> (candidates, exclusion_notes)`

**Hard filters (configurable):**

1. `attended`: `account_id ∈ event.attendee_account_ids`
2. `not_winner`: `account_id ≠ buyer_account_id`
3. `pool_rule`: reconstructed `pool_before >= max(config.min_pool_absolute, config.min_pool_ratio * winning_price)` and, if `require_pool_ge_clearing`, `pool_before >= winning_price - config.clearing_epsilon`
4. `eligible` (optional): if `event.eligible_account_ids` is provided, `account_id ∈ eligible_account_ids`
5. `item_eligible_lane` (optional): if `event.eligible_char_pairs` is provided, the account must have at least one character in the same **plausibility set** used for scoring (attendance-linked `char_id`s ∪ prior revealed spend / win lanes in `KnowledgeState`) whose pair `(account_id, char_id)` lies in `eligible_char_pairs`

**Thresholds (defaults in `SecondBidderConfig`):**

- `min_pool_ratio` — e.g. 0.5 means “at least half the clearing price in reconstructed pool”
- `min_pool_absolute` — floor in DKP
- `require_pool_ge_clearing` — if true, must cover full clearing price (minus epsilon)
- `clearing_epsilon` — small slack for reconstruction noise

**Exclusions:** Every filtered-out attendee gets a short reason string for debugging.

---

## C. Feature groups

All features use **only information available strictly before** the current sale (`KnowledgeState` + current event metadata + reconstructed pool). **No future purchases** enter features for past events.

### 1) Capability (observed at auction time)

| Feature | Description |
|---------|-------------|
| `attended` | 1.0 for pool members |
| `eligible_for_item` | 1.0 if eligibility set missing or account in set; else excluded from pool |
| `dkp_available` | `pool_before` (optionally capped before `log1p` for normalization) |
| `dkp_ratio_to_winning_bid` | `pool_before / max(winning_price, 1)` (optionally capped) |
| `wealth_utilization` | `prior_total_spent / (prior_total_spent + pool_before)` — higher when the wallet has actually circulated DKP |
| `recent_attendance_proxy` | **MVP:** placeholder 1.0 (optional extension: pre-count raids attended before date from attendance tables) |

### 2) Propensity / desire (revealed preference, prior only)

**No future leakage:** these counts include **strictly prior** guild sales only (rolling state updated after each scored event).

| Feature | Description |
|---------|-------------|
| `prior_wins_same_norm_weighted` | Recency-weighted count of prior wins on same `norm_name` (decay by event index) |
| `prior_wins_any_weighted` | Same, any item (activity / spend appetite) |
| `prior_spend_on_attending_toons` | Sum of prior DKP spent on **toons that attended this auction** for this account (from `KnowledgeState`) |
| `win_rate_over_attended_loot_sales` | `prior_win_count / max(1, prior_loot_sales_attended)` — rolling count of guild sales (same chronology) where the account was an attendee |

### 3) Competitiveness (prior bidding posture)

| Feature | Description |
|---------|-------------|
| `prior_win_count` | Number of prior paid wins |
| `prior_mean_win_cost` | Mean cost of prior wins (0 if none) |
| `prior_mean_paid_to_ref` | Mean of `paid_to_ref_ratio` on prior wins when present |
| `hoarding_account_total` | `pool_before / (1 + prior_total_spent)` — dry powder vs **account** burn history |
| `hoarding_char_lane` | `pool_before / (1 + max prior per-character spend)` — lane-level dry powder (character-aware) |

---

## D. Scoring model

**Additive (transparent):**

```
raw_score = w_cap * capability_score
          + w_prop * propensity_score
          + w_comp * competitiveness_score
```

Each group score is a **weighted sum of normalized sub-features** in `[0, 1]` where possible (min–max normalize within the candidate set for that event, or logistic on ratio features).

**Probabilities:**

```
p_i = max(raw_score_i, eps) / sum_j max(raw_score_j, eps)
```

`eps` avoids zero-mass degeneracy. Weights and `eps` live on `SecondBidderConfig`.

---

## E. Time-awareness / rolling knowledge state

**`KnowledgeState`** accumulates **only after** each processed sale (in global chronological order: `raid_date`, `loot_id`).

**Updates (`update_knowledge_state`)** use the closing sale: buyer account, buyer character id (from `raid_loot`), `norm_name`, `cost_num`, `paid_to_ref_ratio` if available, global event index.

**Guarantee:** When scoring event *t*, the state contains purchases from events `< t` only.

---

## F. Evaluation

- **With labels** (optional map `loot_id -> second_bidder_account_id`): rank of label, top-k hit, NDCG@k (lightweight helper).
- **Without labels:** distribution summaries, exclusion counts, feature histograms, per-event debug reports.
- **Never** claim accuracy on unlabeled data beyond sanity checks.
