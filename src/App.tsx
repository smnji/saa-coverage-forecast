import { useMemo, useState } from "react";
import {
  CVMS_PROFILE,
  forecast,
  generateHistory,
  trainForecaster,
  type DayForecast,
  type RiskLevel,
} from "./model";

// Pilot snapshot anchor. Defaults to a date whose 14-day window contains the
// Presidents Day long weekend so the "Friday before a 3-day weekend" spike is
// visible in the demo. Change it to scrub the forecast to any date.
const DEFAULT_ANCHOR = "2026-02-09";

const RISK_STYLES: Record<RiskLevel, { dot: string; chip: string; label: string }> = {
  high: {
    dot: "bg-red-500",
    chip: "bg-red-50 text-red-700 ring-1 ring-red-200",
    label: "High risk",
  },
  moderate: {
    dot: "bg-amber-500",
    chip: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    label: "Watch",
  },
  low: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    label: "Clear",
  },
};

function formatDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function App() {
  const [anchor, setAnchor] = useState(DEFAULT_ANCHOR);

  const days = useMemo<DayForecast[]>(() => {
    const anchorDate = new Date(anchor + "T12:00:00");
    const history = generateHistory(CVMS_PROFILE, anchorDate);
    const model = trainForecaster(history);
    return forecast(model, CVMS_PROFILE, anchorDate, 14);
  }, [anchor]);

  const highDays = days.filter((d) => d.risk === "high");
  const worst = days.reduce<DayForecast | null>(
    (acc, d) => (acc && acc.totalGap >= d.totalGap ? acc : d),
    null,
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-indigo-600">
            UniqLearn · Cajon Valley pilot
          </div>
          <h1 className="mt-1 text-2xl font-bold">SAA Coverage Forecast</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Predicts daily teacher and paraeducator absences and the resulting{" "}
            <span className="font-semibold">uncovered-class gap</span>, so
            coverage can be planned ahead instead of scrambled at 8:50 when the
            bell rings.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {/* Controls + headline summary */}
        <section className="mb-8 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-500">
              Forecast as of
            </label>
            <input
              type="date"
              value={anchor}
              onChange={(e) => setAnchor(e.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <p className="mt-2 text-xs text-slate-500">{CVMS_PROFILE.name}</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              High-risk days (next 14)
            </div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {highDays.length}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Days likely to leave classes uncovered after subs.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Toughest day ahead
            </div>
            <div className="mt-2 text-lg font-bold">
              {worst ? `${worst.weekday} ${formatDate(worst.date)}` : "—"}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {worst
                ? `~${worst.uncoveredClasses} classes + ${worst.uncoveredParaSupport} para slots uncovered`
                : ""}
            </p>
          </div>
        </section>

        {/* Forecast list */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            14-day forecast
          </h2>
          {days.map((d) => (
            <DayCard key={d.date} day={d} />
          ))}
        </section>

        <footer className="mt-10 rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500">
          <p className="font-semibold text-slate-600">How this works</p>
          <p className="mt-1">
            A synthetic year of absence history is generated from the patterns
            surfaced in the Cajon Valley SAA interviews (Friday-before-long-weekend
            spikes, flu season, ~40% paraeducator absence). A forecaster{" "}
            <span className="font-medium">learns</span> the average rate per day
            type from that history, then projects forward and subtracts the
            district sub fill rate and internal plan-period pulls to estimate the
            uncovered-class gap. Pilot data is synthetic — drop in a real
            SmartFind / iVisions export and the same model runs on it.
          </p>
        </footer>
      </main>
    </div>
  );
}

function DayCard({ day }: { day: DayForecast }) {
  const style = RISK_STYLES[day.risk];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3 sm:w-44">
        <span className={`h-2.5 w-2.5 rounded-full ${style.dot}`} />
        <div>
          <div className="font-semibold">
            {day.weekday} {formatDate(day.date)}
          </div>
          <span
            className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${style.chip}`}
          >
            {style.label}
          </span>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric
          label="Teachers out"
          value={day.expectedTeacherAbsences}
          sub={`range ${day.teacherLow}–${day.teacherHigh}`}
        />
        <Metric label="Paras out" value={day.expectedParaAbsences} />
        <Metric
          label="Classes uncovered"
          value={day.uncoveredClasses}
          emphasize={day.uncoveredClasses > 0}
        />
        <Metric
          label="Para slots short"
          value={day.uncoveredParaSupport}
          emphasize={day.uncoveredParaSupport > 0}
        />
      </div>

      <div className="sm:w-52">
        <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
          Why
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {day.drivers.map((dr) => (
            <span
              key={dr}
              className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
            >
              {dr}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  emphasize,
}: {
  label: string;
  value: number;
  sub?: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div
        className={`text-xl font-bold ${emphasize ? "text-red-600" : "text-slate-900"}`}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}
