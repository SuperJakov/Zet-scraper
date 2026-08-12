/**
 * Prediction Accuracy Analysis
 *
 * Reads the JSONL log files produced by prediction_logger.ts and prints a
 * comprehensive accuracy report.
 *
 * Metrics reported:
 *   • Overall MAE / RMSE / median absolute error (seconds)
 *   • % of predictions within ±30s / ±60s / ±120s
 *   • Breakdown by prediction horizon bucket (0-2 min, 2-5 min, 5-10 min, 10+ min)
 *   • Breakdown by route
 *   • Breakdown by stop
 *   • Breakdown by hour of day
 *   • Bias: mean signed error (positive = vehicle arrives late, negative = early)
 *
 * Usage:
 *   bun run scripts/prediction_analysis.ts
 *   bun run scripts/prediction_analysis.ts --log-dir logs
 *   bun run scripts/prediction_analysis.ts --date 2026-08-10   (analyse a single day)
 *   bun run scripts/prediction_analysis.ts --min-samples 5     (min arrivals for breakdown rows)
 *   bun run scripts/prediction_analysis.ts --json              (also write results to logs/analysis_YYYY-MM-DD.json)
 *   bun run scripts/prediction_analysis.ts --fresh-only        (skip records from before the obs_timestamp fix)
 */

import fs from "node:fs";
import path from "node:path";

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const getFlag = (flag: string, defaultVal: string): string => {
  const idx = argv.indexOf(flag);
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1]! : defaultVal;
};
const hasFlag = (flag: string): boolean => argv.includes(flag);

const LOG_DIR = getFlag("--log-dir", path.resolve(process.cwd(), "logs"));
const FILTER_DATE = getFlag("--date", "");
const MIN_SAMPLES = parseInt(getFlag("--min-samples", "3"), 10);
const OUTPUT_JSON = hasFlag("--json");
// --fresh-only: skip records produced before the obs_timestamp fix.
// Old records had every arrival in a tick sharing the exact same actual_arrival
// timestamp (coarse tickTime), which made error measurements unreliable.
const FRESH_ONLY = hasFlag("--fresh-only");

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActualArrivalRecord {
  type: "actual_arrival";
  logged_at: string;
  vehicle_id: string;
  route_id: string;
  trip_id: string;
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lng: number;
  actual_arrival: string;
  prediction_made_at: string;
  predicted_arrival: string;
  horizon_minutes: number;
  error_seconds: number;
  abs_error_seconds: number;
}

// ── Load logs ─────────────────────────────────────────────────────────────────

function loadArrivals(): ActualArrivalRecord[] {
  if (!fs.existsSync(LOG_DIR)) {
    console.error(`Log directory not found: ${LOG_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.startsWith("prediction_log_") && f.endsWith(".jsonl"))
    .filter((f) => {
      if (!FILTER_DATE) return true;
      return f.includes(FILTER_DATE);
    })
    .sort();

  if (files.length === 0) {
    console.error(`No prediction log files found in ${LOG_DIR}${FILTER_DATE ? ` for date ${FILTER_DATE}` : ""}`);
    process.exit(1);
  }

  console.log(`Loading ${files.length} log file(s): ${files.join(", ")}`);

  const arrivals: ActualArrivalRecord[] = [];
  let skippedOldFormat = 0;

  // Detect old-format batches: records produced by the buggy logger where
  // actual_arrival = tickTime (all arrivals in a tick share the exact same ms).
  // We identify these by collecting all unique actual_arrival values and flagging
  // any timestamp that appears more than once (real arrivals are sub-second unique).
  const arrivalTimestampCounts = new Map<string, number>();

  const rawArrivals: ActualArrivalRecord[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(LOG_DIR, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { type: string };
        if (rec.type === "actual_arrival") {
          const a = rec as ActualArrivalRecord;
          rawArrivals.push(a);
          arrivalTimestampCounts.set(
            a.actual_arrival,
            (arrivalTimestampCounts.get(a.actual_arrival) ?? 0) + 1
          );
        }
      } catch {
        // skip malformed lines
      }
    }
  }

  // A timestamp that appears for more than 2 vehicles simultaneously almost
  // certainly came from the old tickTime bug (real trams rarely arrive at
  // different stops at the exact same millisecond).
  const OLD_FORMAT_THRESHOLD = 3;
  const isBuggyTimestamp = (ts: string): boolean =>
    (arrivalTimestampCounts.get(ts) ?? 0) >= OLD_FORMAT_THRESHOLD;

  for (const a of rawArrivals) {
    if (FRESH_ONLY && isBuggyTimestamp(a.actual_arrival)) {
      skippedOldFormat++;
      continue;
    }
    arrivals.push(a);
  }

  if (skippedOldFormat > 0) {
    console.warn(`⚠️  Skipped ${skippedOldFormat} records from old-format ticks (--fresh-only active).`);
  } else {
    // Warn even without --fresh-only if old format records are detected
    const buggyCount = rawArrivals.filter((a) => isBuggyTimestamp(a.actual_arrival)).length;
    if (buggyCount > 0) {
      console.warn(`⚠️  Warning: ${buggyCount} record(s) detected with old tick-time actual_arrival timestamps.`);
      console.warn(`   These were produced before the obs_timestamp fix and will skew results.`);
      console.warn(`   Re-run with --fresh-only to exclude them.`);
    }
  }

  return arrivals;
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

interface Stats {
  count: number;
  mae: number;           // mean absolute error (seconds)
  rmse: number;          // root mean square error
  medianAbs: number;     // median absolute error
  bias: number;          // mean signed error (+ = late arrivals, - = early arrivals)
  within30s: number;     // % within ±30s
  within60s: number;     // % within ±60s
  within120s: number;    // % within ±120s
  p25: number;           // 25th percentile of abs error
  p75: number;           // 75th percentile of abs error
  p95: number;           // 95th percentile of abs error
}

function computeStats(errors: number[]): Stats {
  if (errors.length === 0) {
    return { count: 0, mae: 0, rmse: 0, medianAbs: 0, bias: 0, within30s: 0, within60s: 0, within120s: 0, p25: 0, p75: 0, p95: 0 };
  }

  const abs = errors.map(Math.abs);
  const sorted = abs.slice().sort((a, b) => a - b);
  const n = errors.length;

  const percentile = (arr: number[], p: number): number => {
    const idx = Math.min(Math.floor((p / 100) * arr.length), arr.length - 1);
    return arr[idx]!;
  };

  const mae = abs.reduce((s, v) => s + v, 0) / n;
  const bias = errors.reduce((s, v) => s + v, 0) / n;
  const rmse = Math.sqrt(errors.reduce((s, v) => s + v * v, 0) / n);
  const medianAbs = percentile(sorted, 50);

  const within30s = (abs.filter((v) => v <= 30).length / n) * 100;
  const within60s = (abs.filter((v) => v <= 60).length / n) * 100;
  const within120s = (abs.filter((v) => v <= 120).length / n) * 100;

  return {
    count: n,
    mae: Math.round(mae * 10) / 10,
    rmse: Math.round(rmse * 10) / 10,
    medianAbs: Math.round(medianAbs * 10) / 10,
    bias: Math.round(bias * 10) / 10,
    within30s: Math.round(within30s * 10) / 10,
    within60s: Math.round(within60s * 10) / 10,
    within120s: Math.round(within120s * 10) / 10,
    p25: Math.round(percentile(sorted, 25) * 10) / 10,
    p75: Math.round(percentile(sorted, 75) * 10) / 10,
    p95: Math.round(percentile(sorted, 95) * 10) / 10,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(n: number, decimals: number = 1): string {
  return n.toFixed(decimals);
}

function printStats(label: string, stats: Stats, indent: string = ""): void {
  const bias = stats.bias >= 0 ? `+${fmt(stats.bias)}s (model predicts early)` : `${fmt(stats.bias)}s (model predicts late)`;
  console.log(`${indent}${label} (n=${stats.count})`);
  console.log(`${indent}  MAE=${fmt(stats.mae)}s  RMSE=${fmt(stats.rmse)}s  Median=${fmt(stats.medianAbs)}s  Bias=${bias}`);
  console.log(`${indent}  Within ±30s: ${fmt(stats.within30s)}%  ±60s: ${fmt(stats.within60s)}%  ±120s: ${fmt(stats.within120s)}%`);
  console.log(`${indent}  P25=${fmt(stats.p25)}s  P75=${fmt(stats.p75)}s  P95=${fmt(stats.p95)}s`);
}

function printTable(
  title: string,
  rows: Array<{ label: string; stats: Stats }>,
  minSamples: number
): void {
  const filtered = rows.filter((r) => r.stats.count >= minSamples);
  if (filtered.length === 0) {
    console.log(`\n  ${title}: (no rows with ≥${minSamples} samples)`);
    return;
  }

  console.log(`\n${"─".repeat(100)}`);
  console.log(title);
  console.log("─".repeat(100));
  console.log(
    "Label".padEnd(30) +
    "N".padStart(6) +
    "MAE(s)".padStart(9) +
    "RMSE(s)".padStart(9) +
    "Median(s)".padStart(11) +
    "Bias(s)".padStart(9) +
    "±30s%".padStart(8) +
    "±60s%".padStart(8) +
    "±120s%".padStart(9) +
    "P95(s)".padStart(9)
  );
  console.log("─".repeat(100));

  for (const { label, stats: s } of filtered.sort((a, b) => b.stats.count - a.stats.count)) {
    console.log(
      label.substring(0, 29).padEnd(30) +
      String(s.count).padStart(6) +
      fmt(s.mae).padStart(9) +
      fmt(s.rmse).padStart(9) +
      fmt(s.medianAbs).padStart(11) +
      (s.bias >= 0 ? "+" : "") + fmt(s.bias).padStart(8) +
      fmt(s.within30s).padStart(8) +
      fmt(s.within60s).padStart(8) +
      fmt(s.within120s).padStart(9) +
      fmt(s.p95).padStart(9)
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const arrivals = loadArrivals();

  if (arrivals.length === 0) {
    console.log("No actual_arrival records found. Run prediction_logger.ts for a while to generate data.");
    process.exit(0);
  }

  const errors = arrivals.map((a) => a.error_seconds);

  console.log("\n" + "═".repeat(100));
  console.log("  ZET PREDICTION ACCURACY ANALYSIS");
  console.log("═".repeat(100));
  console.log(`  Total resolved predictions: ${arrivals.length}`);
  console.log(`  Date range: ${arrivals[0]!.actual_arrival.substring(0, 10)} → ${arrivals[arrivals.length - 1]!.actual_arrival.substring(0, 10)}`);
  console.log("═".repeat(100) + "\n");

  // ── Overall ────────────────────────────────────────────────────────────────
  console.log("OVERALL ACCURACY");
  console.log("─".repeat(60));
  printStats("All predictions", computeStats(errors));

  // ── By horizon bucket ──────────────────────────────────────────────────────
  const horizonBuckets: Array<{ label: string; min: number; max: number }> = [
    { label: "0–2 min ahead", min: 0, max: 2 },
    { label: "2–5 min ahead", min: 2, max: 5 },
    { label: "5–10 min ahead", min: 5, max: 10 },
    { label: "10–20 min ahead", min: 10, max: 20 },
    { label: "20–30 min ahead", min: 20, max: 30 },
  ];

  printTable(
    "BY PREDICTION HORIZON",
    horizonBuckets.map(({ label, min, max }) => ({
      label,
      stats: computeStats(
        arrivals
          .filter((a) => a.horizon_minutes >= min && a.horizon_minutes < max)
          .map((a) => a.error_seconds)
      ),
    })),
    MIN_SAMPLES
  );

  // ── By route ───────────────────────────────────────────────────────────────
  const byRoute = new Map<string, number[]>();
  for (const a of arrivals) {
    if (!byRoute.has(a.route_id)) byRoute.set(a.route_id, []);
    byRoute.get(a.route_id)!.push(a.error_seconds);
  }

  printTable(
    "BY ROUTE",
    Array.from(byRoute.entries()).map(([route, errs]) => ({
      label: `Route ${route}`,
      stats: computeStats(errs),
    })),
    MIN_SAMPLES
  );

  // ── By direction ───────────────────────────────────────────────────────────
  // Extract direction from trip_id? We don't have direction_id on ActualArrivalRecord
  // so we group from the stop perspective instead - by route for now, direction from
  // the matching prediction record in the log (available separately). Skipping direction
  // breakdown here since actual_arrival records don't carry direction_id directly.

  // ── By hour of day ─────────────────────────────────────────────────────────
  const byHour = new Map<number, number[]>();
  for (const a of arrivals) {
    const hour = new Date(a.actual_arrival).getHours();
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour)!.push(a.error_seconds);
  }

  printTable(
    "BY HOUR OF DAY",
    Array.from(byHour.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([hour, errs]) => ({
        label: `${String(hour).padStart(2, "0")}:00`,
        stats: computeStats(errs),
      })),
    MIN_SAMPLES
  );

  // ── By stop ────────────────────────────────────────────────────────────────
  const byStop = new Map<string, number[]>();
  for (const a of arrivals) {
    const key = `${a.stop_name} (${a.stop_id})`;
    if (!byStop.has(key)) byStop.set(key, []);
    byStop.get(key)!.push(a.error_seconds);
  }

  printTable(
    `BY STOP (min ${MIN_SAMPLES} samples)`,
    Array.from(byStop.entries()).map(([stop, errs]) => ({
      label: stop,
      stats: computeStats(errs),
    })),
    MIN_SAMPLES
  );

  // ── Error distribution histogram ───────────────────────────────────────────
  console.log("\n" + "─".repeat(60));
  console.log("ERROR DISTRIBUTION (seconds)");
  console.log("─".repeat(60));

  const buckets = [
    { label: "< -120s (very early)", fn: (e: number) => e < -120 },
    { label: "-120s to -60s", fn: (e: number) => e >= -120 && e < -60 },
    { label: "-60s to -30s", fn: (e: number) => e >= -60 && e < -30 },
    { label: "-30s to 0s (early)", fn: (e: number) => e >= -30 && e < 0 },
    { label: "0s to +30s (on time)", fn: (e: number) => e >= 0 && e <= 30 },
    { label: "+30s to +60s", fn: (e: number) => e > 30 && e <= 60 },
    { label: "+60s to +120s", fn: (e: number) => e > 60 && e <= 120 },
    { label: "> +120s (very late)", fn: (e: number) => e > 120 },
  ];

  const total = errors.length;
  for (const { label, fn } of buckets) {
    const count = errors.filter(fn).length;
    const pct = (count / total) * 100;
    const bar = "█".repeat(Math.round(pct / 2));
    console.log(`  ${label.padEnd(26)} ${String(count).padStart(5)} (${fmt(pct)}%) ${bar}`);
  }

  // ── JSON output ────────────────────────────────────────────────────────────
  if (OUTPUT_JSON) {
    const report = {
      generated_at: new Date().toISOString(),
      total_arrivals: arrivals.length,
      overall: computeStats(errors),
      by_horizon: Object.fromEntries(
        horizonBuckets.map(({ label, min, max }) => [
          label,
          computeStats(
            arrivals
              .filter((a) => a.horizon_minutes >= min && a.horizon_minutes < max)
              .map((a) => a.error_seconds)
          ),
        ])
      ),
      by_route: Object.fromEntries(
        Array.from(byRoute.entries()).map(([r, errs]) => [r, computeStats(errs)])
      ),
      by_hour: Object.fromEntries(
        Array.from(byHour.entries()).map(([h, errs]) => [String(h), computeStats(errs)])
      ),
      by_stop: Object.fromEntries(
        Array.from(byStop.entries())
          .filter(([, errs]) => errs.length >= MIN_SAMPLES)
          .map(([s, errs]) => [s, computeStats(errs)])
      ),
    };

    const dateStr = new Date().toISOString().split("T")[0]!;
    const jsonPath = path.join(LOG_DIR, `analysis_${dateStr}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`\n✓ JSON report written to ${jsonPath}`);
  }

  console.log("\n" + "═".repeat(100));
}

main();
