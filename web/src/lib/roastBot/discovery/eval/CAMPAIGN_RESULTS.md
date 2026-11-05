# Discovery reliability campaign — results

## What fixed

1. **Stale wrong-entity answers (critical)**  
   `tryMergeFollowUp` now parses the new utterance independently (including mold/item phrases) and replaces prior item identity. `what about silk robe` after plate BP no longer reuses breastplate.

2. **Reported five-turn sequence**  
   Covered by `conversation.regression.test.js` via production-shaped `pipelineTrace` (recognize → runDiscovery → handleMessage).

3. **Temporal / singular answers**  
   `most recent` / `latest` map to `last_award`. `item_last` renders a singular-first answer (recipient, date, raid) before optional short history.

4. **Intent gaps**  
   Compositional cues for `what did BOSS drop`, `looted`, `last X loot`, verb typos (`who go`/`gott`), `who looted`, zone/phase follow-ups (`Actually, PoF.`, P4).

5. **Conversation provenance**  
   Empty successful results clear `lastDiscovery.primary` instead of retaining a prior item.

6. **Cache integrity**  
   Fingerprints include resolved item id / selector names; failed/ambiguous results are not cached.

7. **Eval harness**  
   `npm run test:discovery-eval` — generative ≥300-case corpus, structured scoring, JSON+Markdown reports under `eval/reports/`.

## Metrics (latest eval run)

See `eval/reports/latest.md` for the machine-written summary. Acceptance gates:

- Corpus ≥ 300
- Interpretation ≥ 95% on in-scope unambiguous cases
- 100% fixture-backed retrieval correctness where awards are asserted
- Zero wrong-entity factual answers
- Zero stale-result reuse
- Mandatory five-turn seed passing

## Remaining failures (by layer)

Any residual failures in `latest.md` are typically:

- **Parser:** rare word-order or underspecified fragments still `unsupported` / `not_discovery`
- **Metadata:** phase/slot aliases incomplete for fringe labels
- **Retrieval:** empty fixture history for some mold/item paraphrases (correct `no_match`, not wrong entity)
- **Conversation-state:** topic switches that are not discovery-shaped by design

Do not treat the five seed strings alone as success; use the eval corpus.
