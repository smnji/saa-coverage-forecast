# SAA Coverage Forecast

A standalone prototype for the Cajon Valley pilot. It predicts daily **teacher
and paraeducator absences** and the resulting **uncovered-class gap**, so a
School Administrative Assistant (SAA) can plan plan-period coverage ahead of
time instead of scrambling each morning.

## Why

From the Cajon Valley district visit (May 2026), the absence/coverage workflow
is the SAAs' biggest daily pain: SmartFind and iVisions don't talk to each
other, the sub pool fills elementary first, and high-call-out days are
*predictable* ("Friday before a three-day weekend") but can't be pre-staged. A
forecast that says "next Friday you'll likely be ~4 teachers and ~12 paras
short, ~3 classes uncovered" turns that scramble into planning.

## How the prediction works

1. **Synthesize history** — `generateHistory()` produces ~1 school year of
   plausible daily absence records from the interview patterns (long-weekend
   spikes, flu season, ~40% para absence).
2. **Learn** — `trainForecaster()` fits average absence rates per *day type*
   from that history (nothing hard-coded into the forecast).
3. **Forecast + gap** — `forecast()` projects the next 14 days and subtracts the
   district sub fill rate and internal plan-period pulls to estimate uncovered
   classes, flagging high-risk days.

Pilot data is synthetic. Replace `generateHistory()` with a real
SmartFind/iVisions CSV export and steps 2–3 run unchanged.

## Develop

```bash
pnpm install
pnpm dev      # local dev server
pnpm build    # production build to dist/
```

## Deploy

Deployed as a Render **static site** (see `render.yaml`).
