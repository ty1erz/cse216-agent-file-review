# Integrated experiment design

## Research question

Does a file-by-file preview help people catch incorrect or over-broad file
operations compared with a normal command confirmation prompt? The three
harnesses test whether the same review component remains understandable in
common coding-agent contexts.

## Variables

- **Within participant:** plain prompt versus structured file preview.
- **Between participants:** OpenHands, Cline or Codex CLI interface shell.
- **Counterbalanced:** scenario set assigned to each confirmation screen and
  which screen appears first (`A1`, `A2`, `B1`, `B2`).
- **Randomized:** scenario order inside each block.

The command, task wording, simulated file system and decision controls are the
same across harnesses. Only the surrounding interaction shell changes.

## Pilot assignment

Use fixed links to keep the pilot balanced:

| Harness | Survey URL suffix | Suggested reviewers (n=5) |
|---|---|---:|
| OpenHands | `?harness=openhands#survey` | 2 |
| Cline | `?harness=cline#survey` | 2 |
| Codex CLI | `?harness=codex#survey` | 1 |

With five reviewers, report harness observations as qualitative or exploratory.
Do not present differences between the three harnesses as statistically
conclusive. The primary quantitative result is the within-participant plain
versus preview comparison.

## Recorded measures

- approve, reject or request-change decision;
- correctness against the scenario answer key;
- response time and confidence;
- perceived visibility, confidence, ease and information load;
- screen preference and free-text comments;
- assigned harness, survey version and counterbalancing group.

Practice trials are not included in the submitted trial rows.

## Deployment checklist

1. Inspect all scenarios and answer keys in `#demo`.
2. Update and redeploy `survey/collect_responses.gs` so `harness` receives its
   own Sheet column.
3. Merge the integration branch into `main`; GitHub Pages publishes only
   `main`.
4. Run one test response per fixed harness link and confirm both `responses`
   and `trials` rows contain the expected harness.
5. Delete those test rows before distributing the survey.
