# Discovery evaluation campaign

Deterministic natural-language reliability suite for the DKP Inquisitor loot discovery engine.

## Commands

From `web/`:

```bash
npm run test:discovery-eval
npm run test:discovery
```

- `test:discovery-eval` — generative ≥300-case corpus, structured scoring, writes reports
- `test:discovery` — all unit/regression tests under `discovery/`

## Reports

After an eval run:

- `eval/reports/latest.json` — machine-readable summary
- `eval/reports/latest.md` — concise human summary

## Scoring

Cases assert structured fields (recognition, intent, resolved IDs, award IDs/recipients, outcome class), not exact natural-language strings. Multi-turn cases use the production path via `pipelineTrace` (`recognize → runDiscovery → handleMessage`).

## Acceptance targets

- ≥95% correct interpretation on in-scope unambiguous cases
- 100% factual record correctness on deterministic fixture award cases
- Zero wrong-entity factual answers
- Zero stale-result reuse across changed queries
- Mandatory five-turn reported failure sequence covered and passing
