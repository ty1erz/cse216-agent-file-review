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
- binary approval accuracy against the scenario answer key: approve a matching
  command, or decline a mismatching command (reject and request change both
  count as declining; preserve the selected action for separate analysis);
- response time and confidence;
- perceived visibility, confidence, ease and information load;
- screen preference and free-text comments;
- assigned harness, survey version and counterbalancing group.

Practice trials are not included in the submitted trial rows.
Response time runs from the constructed trial screen to the final selected
decision, including any change of mind before advancing.
The live prompt-driven `#try` demonstration is separate from the fixed survey.

## Deployment checklist

1. Inspect all scenarios and answer keys in `#demo`.
2. Update and redeploy `survey/collect_responses.gs` so `harness` receives its
   own Sheet column and `?receipt=<id>` confirms a complete saved response.
3. Merge the integration branch into `main`; GitHub Pages publishes only
   `main`.
4. Run one test response per fixed harness link and confirm both `responses`
   and `trials` rows contain the expected harness. Verify a matching receipt
   returns `saved: true` and the page says the response was saved. Test with
   the collector unavailable as well: the page must offer the downloadable
   response and keep its local backup without reporting success.
5. Delete those test rows before distributing the survey.
