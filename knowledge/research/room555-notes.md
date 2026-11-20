# Room 555 notes (2026-11-20, post-match 2026-11-20T13-10-22_room555)

## Scoring discrepancies resolved
- Official itemPoint 44885 vs estimated 36990 → **+7895 gap**. Cause: the G70-79 family
  (labels 71/77/79, 73 pickups total) actually pays ~+490..500 average per G tile, not +400.
  Knowledge tiles.json now records the family correction (ids 61/62 stubs kept for the
  estimator hook).
- Official actionPoint -1790 vs estimated -2020 → **+230 gap** (`keilu` fatigue slightly
  cheaper than the -250 flat guess; gr/w family -10/-20 table holds).

## Match facts
- HTTP 500 game-over at t89 (server-side), score 69495 was still banked; room high score.
- 6 segments confirmed (WARPED_TO_SEGMENT_1..6); warps (20-53) pay +5 and teleport, no
  fatigue loss beyond the walk cost itself.
- BlackStar `B` tile again gave 0 on landing (no score event observed in turns.jsonl).
- kei* (t20) used once for a +400 G jump — with the tightened >=400 gate this same jump
  still fires; pure-150 F jumps no longer pass through (each costs ~-250, net-negative).
