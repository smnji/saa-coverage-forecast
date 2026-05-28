// ---------------------------------------------------------------------------
// SAA Coverage Forecast — prediction model
//
// Pipeline (kept deliberately transparent so SAAs can trust it):
//   1. generateHistory()  -> synthesizes ~1 school year of plausible daily
//                            absence records from the patterns surfaced in the
//                            Cajon Valley interviews (Fri-before-long-weekend
//                            spikes, flu season, ~40% para absence, etc.).
//   2. trainForecaster()  -> LEARNS average absence rates per "day type" from
//                            that history. Nothing is hard-coded into the
//                            forecast; it is fit from the data.
//   3. forecast()         -> projects the next N days and converts expected
//                            absences into a predicted UNCOVERED-CLASS gap
//                            using sub fill rates + internal plan-period pulls.
//
// Swap generateHistory() for a real SmartFind/iVisions CSV later and steps
// 2-3 keep working unchanged.
// ---------------------------------------------------------------------------

export interface SchoolProfile {
  name: string;
  teacherCount: number;
  paraCount: number;
  // Baseline daily probability that any given staff member is absent.
  teacherBaseRate: number;
  paraBaseRate: number;
  // Share of absences that get filled externally (district sub pool).
  // Middle schools get the leftovers after elementary fills first.
  subFillRateTeacher: number;
  subFillRatePara: number;
  // Internal coverage capacity: how many teachers can be pulled from plan
  // periods on a typical day before it "breaks down".
  planPeriodCapacity: number;
}

// Defaults tuned to Brook's CVMS numbers from the interviews:
// ~23 paras with ~10 out daily (~43%), teacher spikes up to ~9 out.
export const CVMS_PROFILE: SchoolProfile = {
  name: "Cajon Valley Middle (CVMS)",
  teacherCount: 55,
  paraCount: 23,
  teacherBaseRate: 0.045,
  paraBaseRate: 0.4,
  subFillRateTeacher: 0.5,
  subFillRatePara: 0.1,
  planPeriodCapacity: 4,
};

// ---------------------------------------------------------------------------
// Calendar: holidays / long weekends for the 2025-26 school year so the model
// can flag the "Friday before a three-day weekend" effect the SAAs called out.
// ---------------------------------------------------------------------------

// Observed holidays (school closed) in ISO yyyy-mm-dd.
const HOLIDAYS = new Set<string>([
  "2025-09-01", // Labor Day
  "2025-11-11", // Veterans Day
  "2025-11-27", // Thanksgiving
  "2025-11-28", // Thanksgiving Fri
  "2026-01-19", // MLK Day
  "2026-02-16", // Presidents Day
  "2026-05-25", // Memorial Day
]);

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

export function isHoliday(d: Date): boolean {
  return HOLIDAYS.has(iso(d));
}

// True if a school day sits directly next to a holiday/weekend gap — i.e. the
// Friday before a 3-day weekend or the day before/after a break. This is the
// single biggest absence driver per the interviews.
export function isLongWeekendAdjacent(d: Date): boolean {
  const dow = d.getDay();
  // Friday whose following Monday is a holiday -> 3-day weekend.
  if (dow === 5 && isHoliday(addDays(d, 3))) return true;
  // Any school day immediately before or after a holiday.
  if (isHoliday(addDays(d, 1)) || isHoliday(addDays(d, -1))) return true;
  return false;
}

function isFluSeason(d: Date): boolean {
  const m = d.getMonth(); // 0=Jan
  return m === 11 || m === 0 || m === 1; // Dec, Jan, Feb
}

function isSchoolDay(d: Date): boolean {
  const dow = d.getDay();
  return dow >= 1 && dow <= 5 && !isHoliday(d);
}

// ---------------------------------------------------------------------------
// Day-type key — the buckets the forecaster learns rates for.
// ---------------------------------------------------------------------------

export interface DayFactors {
  dow: number;
  longWeekendAdjacent: boolean;
  fluSeason: boolean;
}

export function dayFactors(d: Date): DayFactors {
  return {
    dow: d.getDay(),
    longWeekendAdjacent: isLongWeekendAdjacent(d),
    fluSeason: isFluSeason(d),
  };
}

function dayTypeKey(f: DayFactors): string {
  return `${f.dow}|${f.longWeekendAdjacent ? 1 : 0}|${f.fluSeason ? 1 : 0}`;
}

// Human-readable list of which factors are pushing a day up.
export function activeDrivers(d: Date): string[] {
  const drivers: string[] = [];
  const dow = d.getDay();
  if (isLongWeekendAdjacent(d)) drivers.push("Adjacent to a long weekend");
  if (dow === 5) drivers.push("Friday");
  if (dow === 1) drivers.push("Monday");
  if (isFluSeason(d)) drivers.push("Flu season (Dec–Feb)");
  if (drivers.length === 0) drivers.push("Typical mid-week");
  return drivers;
}

// ---------------------------------------------------------------------------
// 1. Synthetic history generator
// ---------------------------------------------------------------------------

// Small seeded RNG (mulberry32) for reproducible demos.
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample a Poisson count (Knuth) given expected mean lambda.
function poisson(lambda: number, rng: () => number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

// Multipliers applied to the base rate. These shape the SYNTHETIC data only;
// the forecaster re-learns them from the generated history.
function dowMultiplier(dow: number): number {
  switch (dow) {
    case 1:
      return 1.15; // Monday
    case 5:
      return 1.25; // Friday
    case 2:
    case 4:
      return 0.95;
    default:
      return 0.9; // Wednesday
  }
}

function dayMultiplier(d: Date): number {
  let m = dowMultiplier(d.getDay());
  if (isFluSeason(d)) m *= 1.3;
  if (isLongWeekendAdjacent(d)) m *= 1.8;
  return m;
}

export interface DayRecord {
  date: string;
  teacherAbsences: number;
  paraAbsences: number;
}

export function generateHistory(
  profile: SchoolProfile,
  endDate: Date,
  days = 365,
  seed = 42,
): DayRecord[] {
  const rng = makeRng(seed);
  const records: DayRecord[] = [];
  for (let i = days; i >= 1; i--) {
    const d = addDays(endDate, -i);
    if (!isSchoolDay(d)) continue;
    const m = dayMultiplier(d);
    const tLambda = profile.teacherCount * profile.teacherBaseRate * m;
    const pLambda = profile.paraCount * profile.paraBaseRate * m;
    records.push({
      date: iso(d),
      teacherAbsences: Math.min(poisson(tLambda, rng), profile.teacherCount),
      paraAbsences: Math.min(poisson(pLambda, rng), profile.paraCount),
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// 2. Forecaster — learns mean + spread per day type from history.
// ---------------------------------------------------------------------------

interface Stat {
  mean: number;
  std: number;
  n: number;
}

export interface TrainedModel {
  teacher: Map<string, Stat>;
  para: Map<string, Stat>;
  // Global fallbacks for day types unseen in history.
  teacherGlobal: Stat;
  paraGlobal: Stat;
}

function summarize(values: number[]): Stat {
  const n = values.length;
  if (n === 0) return { mean: 0, std: 0, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(n, 1);
  return { mean, std: Math.sqrt(variance), n };
}

export function trainForecaster(history: DayRecord[]): TrainedModel {
  const teacherBuckets = new Map<string, number[]>();
  const paraBuckets = new Map<string, number[]>();
  const allTeacher: number[] = [];
  const allPara: number[] = [];

  for (const rec of history) {
    const key = dayTypeKey(dayFactors(new Date(rec.date + "T12:00:00")));
    (teacherBuckets.get(key) ?? teacherBuckets.set(key, []).get(key)!).push(
      rec.teacherAbsences,
    );
    (paraBuckets.get(key) ?? paraBuckets.set(key, []).get(key)!).push(
      rec.paraAbsences,
    );
    allTeacher.push(rec.teacherAbsences);
    allPara.push(rec.paraAbsences);
  }

  const teacher = new Map<string, Stat>();
  const para = new Map<string, Stat>();
  for (const [k, v] of teacherBuckets) teacher.set(k, summarize(v));
  for (const [k, v] of paraBuckets) para.set(k, summarize(v));

  return {
    teacher,
    para,
    teacherGlobal: summarize(allTeacher),
    paraGlobal: summarize(allPara),
  };
}

// ---------------------------------------------------------------------------
// 3. Forecast + coverage-gap layer
// ---------------------------------------------------------------------------

export type RiskLevel = "low" | "moderate" | "high";

export interface DayForecast {
  date: string;
  weekday: string;
  expectedTeacherAbsences: number;
  expectedParaAbsences: number;
  // Predicted classes/assignments left uncovered after subs + plan-period pulls.
  uncoveredClasses: number;
  uncoveredParaSupport: number;
  totalGap: number;
  risk: RiskLevel;
  drivers: string[];
  // ± range (one std dev) for the headline absence figure.
  teacherLow: number;
  teacherHigh: number;
}

function lookup(model: TrainedModel, role: "teacher" | "para", key: string): Stat {
  const map = role === "teacher" ? model.teacher : model.para;
  const global = role === "teacher" ? model.teacherGlobal : model.paraGlobal;
  const s = map.get(key);
  // Require a few observations before trusting a bucket.
  return s && s.n >= 3 ? s : global;
}

function riskFor(gap: number): RiskLevel {
  if (gap >= 3) return "high";
  if (gap >= 1) return "moderate";
  return "low";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function forecast(
  model: TrainedModel,
  profile: SchoolProfile,
  startDate: Date,
  horizonDays = 14,
): DayForecast[] {
  const out: DayForecast[] = [];
  for (let i = 0; i < horizonDays; i++) {
    const d = addDays(startDate, i);
    if (!isSchoolDay(d)) continue;
    const key = dayTypeKey(dayFactors(d));
    const t = lookup(model, "teacher", key);
    const p = lookup(model, "para", key);

    const expectedTeacher = t.mean;
    const expectedPara = p.mean;

    // Teacher gap: subs fill a share, internal plan-period pulls absorb the
    // rest up to capacity, remainder is uncovered.
    const teacherNeedAfterSubs = expectedTeacher * (1 - profile.subFillRateTeacher);
    const uncoveredClasses = Math.max(
      0,
      teacherNeedAfterSubs - profile.planPeriodCapacity,
    );
    // Para gap: almost no sub pool, little internal slack.
    const uncoveredParaSupport = expectedPara * (1 - profile.subFillRatePara);

    const totalGap = uncoveredClasses + uncoveredParaSupport;

    out.push({
      date: iso(d),
      weekday: WEEKDAYS[d.getDay()],
      expectedTeacherAbsences: round1(expectedTeacher),
      expectedParaAbsences: round1(expectedPara),
      uncoveredClasses: round1(uncoveredClasses),
      uncoveredParaSupport: round1(uncoveredParaSupport),
      totalGap: round1(totalGap),
      risk: riskFor(uncoveredClasses),
      drivers: activeDrivers(d),
      teacherLow: Math.max(0, Math.round(expectedTeacher - t.std)),
      teacherHigh: Math.round(expectedTeacher + t.std),
    });
  }
  return out;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
