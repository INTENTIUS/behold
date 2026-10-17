# Tours: a cycle told as chapters, on its real events

**Issue:** #711 · **Refs** #715, #716 to #721

A tour tells one cycle of a demo as a story, chapter by chapter, in the
kiosk's Watch. The terralith's carve is the first one. Every visual in a tour
stands on a record of that cycle: a dot moves only when a progress line says a
write happened, a light comes on only when a run's plan planned that resource,
and a number is shown only when a record says it. A fact or a visual with no
record behind it is left out, never drawn as a 0.

## The tour file, `behold.tour/v1`

A tour is a JSON file checked against
`web/tours/behold.tour.v1.schema.json` (`tourProblem` in
`src/terragucci-tour.ts`, which also checks that every name the file uses is
one it defines). behold ships `web/tours/terralith.json`.

| field | what it holds |
|---|---|
| `match` | the demo cycles it narrates: demo.json's `tool` and/or `scenario` |
| `steps` | demo.json's steps in the order a beat walks them, for how far a chapter has got |
| `replay` | how a recorded cycle plays condensed, in ms: `maxGapMs` and `keepMs` (an idle stretch longer than the first plays as the second), `chapterMinMs`, `endHoldMs`, `flightMs` |
| `runs` | named runs of the cycle: a report index row by repo (`{repo}` is demo.json's), stage, wave, no pull request, `after` another named run, first or last; or a migration's apply run, by its record's commit |
| `facts` | named values: a run's `planned`, `changed`, `recreated`, `job` or an `output`'s planned value; a migration record's counts, `writes`, `version_id` or `approved_by`; a `sum` of facts; `approvals`; a `duration` from `started_at` to a run's finish |
| `chapters` | each with a `trigger`, a `title`, up to two lines of `text` naming facts as `{name}`, an optional `focus` (`source`, `all`, or the box its lights are in) and `show`, its visuals |

A trigger matches a real event: demo.json's `beat` (and `step`), a
migration's `first` or `last` progress line by name, or a wave's job starting
or ending by number, `after` a named run. `any` matches the first of several.

A visual names the record it is drawn from: `light` (what a run's plan.json
planned, brighter where it changes), `pulse` (the boxes of the roots a wave
planned), `travel` (a plan's read threads, with the output's planned value
moving along them), `state` (a migration's source state file, by its version
id, "unchanged" once its last line is in), `checks` (each root of a run that
plans no change), `counts` (each box's dots, from the progress lines) and
`card` (labelled rows of facts). Each may wait for its own `when`.

## One player for live and recorded

The server (`src/terragucci-tour.ts`) resolves a tour against the records:
every fact and visual, and the cycle's events (demo.json's beat and step,
each migration's first and last line, each wave's job from `runs/index.json`).
The page's player (`web/tour-player.js`) is pure: the tour and an event stream
in, the chapter, its progress and its visuals out. The current chapter is the
last one in the file whose trigger has fired. The live carve feeds it
(`/api/terragucci/carve`'s `tour`), and so does a recorded cycle.

## A recorded cycle, condensed

`/kiosk?replay=<tool>` plays the tool's latest recorded cycle
(`cycles/<tool>/latest.json`) whether or not its scenario runs live; a tool's
page replays its own the same way whenever its scenario is not live.
`/api/terragucci/carve?cycle=<tool>&n=<cycle>` reads that cycle's carve: its
rosters, every progress line between its start and its end, and its tour,
with one beat event per step it wrote. `web/cycle-replay.js` builds the one
clock everything runs on: recorded time one to one, an idle stretch longer
than `maxGapMs` played as `keepMs` and drawn on the timeline as a break with
its real gap, each write's flight and each chapter's first `chapterMinMs`
never cut, a chapter still too short held at its start, and `endHoldMs` on
the closing chapter before the loop starts again. The kiosk holds the
playhead and tells the frame where it is; a seek, a pause or a speed in the
frame's timeline moves the kiosk's. A newer latest cycle starts at the loop's
end. The shipped tour's settings play a 425 s cycle of 31 steps in about 85 s.

## Where tour files live

The tour for a cycle is a served repo's `.behold/tours/*.json` first, so a
customer's tour wins, then the ones behold ships. A file that is not a tour is
named in the answer's problems and skipped.

## Later: suggesting a draft from a run's events

Not built. A cycle already records what a draft needs: demo.json's beats in
the cycle timeline, the migrations under `<project>/migrations/`, and each
wave's report rows. A suggester could read one finished cycle and write a
chapter per beat (or per migration and wave when there are no beats), name a
run for each report row it saw, and offer the facts each row and record can
back (`planned`, `writes`, `recreated`), leaving the words for a person to
write. It would only propose a file; the schema and the rule that each visual
needs a record stay the same.
