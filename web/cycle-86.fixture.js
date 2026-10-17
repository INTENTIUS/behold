// A recorded terralith cycle in the shape of the demo host's cycle 86 (14
// resources, 31 steps over 425 s): demo.cycle/v1's steps with the real gaps
// between them, and the carve read of it: the adoption's stamps, the split's
// moves, and each apply wave's job. For web/cycle-replay.test.js.

const T0 = Date.parse("2026-10-16T18:02:11Z");
const iso = (s) => new Date(T0 + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// [beat, step, seconds after the step before]
const STEPS = [
  ["stock", "applying", 0],
  ["stock", "applied", 30],
  ["adopt", "pull-request", 9],
  ["adopt", "planned", 27],
  ["adopt", "merged", 12],
  ["adopt", "applying", 5],
  ["adopt", "waiting", 21],
  ["adopt", "approved", 12],
  ["adopt", "resumed", 2],
  ["adopt", "applied", 17],
  ["split", "pull-request", 9],
  ["split", "planned", 28],
  ["split", "merged", 12],
  ["split", "applying", 5],
  ["split", "waiting", 21],
  ["split", "approved", 12],
  ["split", "resumed", 2],
  ["split", "applied", 19],
  ["team", "pull-request", 9],
  ["team", "planned", 25],
  ["team", "merged", 8],
  ["team", "applying", 5],
  ["team", "applied", 22],
  ["cross", "pull-request", 9],
  ["cross", "planned", 26],
  ["cross", "merged", 8],
  ["cross", "applying", 5],
  ["cross", "waiting", 24],
  ["cross", "approved", 5],
  ["cross", "applied", 21],
  [null, "reset", 15],
];

let s = 0;
const steps = STEPS.map(([beat, step, gap]) => {
  s += gap;
  return { cycle: 86, scenario: "terralith", tool: "terralith", title: "One shared root, carved", step, beat, label: `${beat || "reset"} ${step}`, at: iso(s), started_at: iso(0), repo: "demo/demo-terralith", pull: null, commit: null };
});
const at = (beat, step) => Date.parse(steps.find((x) => x.beat === beat && x.step === step).at);

export const cycle86 = { schema: "demo.cycle/v1", tool: "terralith", repo: "demo/demo-terralith", scenario: "terralith", cycle: 86, started: steps[0].at, ended: steps[steps.length - 1].at, steps, runs: [901, 902, 903, 904, 905] };

// The adoption stamps all 14 resources in under a second, 6 s after the resume; the split moves team B's 5, 1 s apart.
const stamps = Array.from({ length: 14 }, (_, i) => ({ at: new Date(at("adopt", "resumed") + 6_000 + i * 40).toISOString(), estate_from: "tl86-shared", estate_to: "tl86-shared", address: `aws_iam_role.r${i}`, outcome: "stamped" }));
const moves = Array.from({ length: 5 }, (_, i) => ({ at: new Date(at("split", "resumed") + 8_000 + i * 1_000).toISOString(), estate_from: "tl86-shared", estate_to: "tl86-team-b", address: `aws_iam_role.r${i}`, outcome: "moved" }));
const line = (m, which) => ({ kind: "line", migration: m.name, line: which, at: Date.parse(m.lines[which === "first" ? 0 : m.lines.length - 1].at) });
const adopt = { name: "adopt", progress: "demo-terralith/migrations/adopt/progress.jsonl", lines: stamps };
const split = { name: "split", progress: "demo-terralith/migrations/split/progress.jsonl", lines: moves };
const wave = (w, from, len) => [
  { kind: "wave", wave: w, edge: "start", at: from },
  { kind: "wave", wave: w, edge: "end", at: from + len },
];

/** The carve read of cycle 86 (`/api/terragucci/carve?cycle=terralith&n=86`), less its rosters; the tour's chapters and replay come from the tour file. */
export const carve86 = {
  live: true,
  migrations: [adopt, split],
  recorded: cycle86,
  tour: {
    events: [
      ...steps.map((x) => ({ kind: "beat", beat: x.beat, step: x.step, at: Date.parse(x.at) })),
      line(adopt, "first"),
      line(adopt, "last"),
      line(split, "first"),
      line(split, "last"),
      ...wave(1, at("cross", "applying") + 4_000, 9_000),
      ...wave(2, at("cross", "approved") + 3_000, 8_000),
    ].sort((a, b) => a.at - b.at),
  },
};
