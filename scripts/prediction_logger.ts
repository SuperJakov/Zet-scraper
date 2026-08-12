/**
 * Prediction Accuracy Logger
 *
 * Runs every minute. For each tick it:
 *   1. Fetches the live GTFS-RT feed to get all currently-driving vehicles.
 *   2. Filters to vehicles that are on a valid GTFS route path (matched to a route segment
 *      within MAX_OFFPATH_METERS).
 *   3. Initialises GtfsMlPredictor for each unique route and runs predict().
 *   4. Logs a JSON-Lines record for each vehicle + stop prediction.
 *   5. On subsequent ticks it compares the previous predictions against the
 *      vehicle's *actual* position to compute realised-vs-predicted arrival errors.
 *
 * Log format  →  logs/prediction_log_YYYY-MM-DD.jsonl
 *
 * Each line is one of two record types:
 *
 *   type: "prediction"
 *     logged_at           ISO timestamp of when the prediction was made
 *     vehicle_id
 *     route_id
 *     trip_id
 *     direction_id
 *     obs_lat / obs_lng   GPS position at prediction time
 *     segment_from        name of "from" stop of matched segment
 *     segment_to          name of "to" stop of matched segment
 *     segment_progress    0-1 progress along the segment
 *     stop_sequence       sequence number of the predicted stop
 *     stop_id
 *     stop_name
 *     stop_lat / stop_lng
 *     eta_seconds         predicted seconds until arrival at that stop
 *     predicted_arrival   ISO timestamp of predicted arrival
 *     sample_count        how many historical samples backed the segment model
 *
 *   type: "actual_arrival"
 *     logged_at           ISO timestamp of when the actual arrival was detected
 *     vehicle_id
 *     route_id
 *     trip_id
 *     stop_id
 *     stop_name
 *     stop_lat / stop_lng
 *     actual_arrival      ISO timestamp of when the vehicle was first seen near the stop
 *     prediction_made_at  ISO timestamp of the corresponding prediction
 *     predicted_arrival   ISO timestamp of the original prediction
 *     horizon_minutes     how many minutes ahead was the prediction made
 *     error_seconds       actual - predicted in seconds (positive = vehicle was late, negative = early)
 *     abs_error_seconds
 *
 * Usage:
 *   bun run scripts/prediction_logger.ts
 *   bun run scripts/prediction_logger.ts --interval 60   (poll interval in seconds, default 60)
 *   bun run scripts/prediction_logger.ts --max-offpath 150  (max distance from route path, default 100m)
 */

import transitRealtime from "gtfs-realtime-bindings";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../src/config";
import { ZetDatabase, type VehicleObservation } from "../src/db";
import { fetchWithRetry } from "../src/fetch";
import { GtfsMlPredictor, haversineDistanceMeters } from "../src/prediction/gtfs_ml_predictor";
import type { StopEtaResult } from "../src/prediction/gtfs_ml_predictor";

const { FeedMessage } = transitRealtime.transit_realtime;

// ── Config ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag: string, defaultVal: number): number => {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1]!, 10) : defaultVal;
};

const POLL_INTERVAL_SEC = getArg("--interval", 60);
const MAX_OFFPATH_METERS = getArg("--max-offpath", 100);
const LOG_DIR = path.resolve(process.cwd(), "logs");
const ARRIVAL_DETECTION_METERS = 80; // vehicle "at stop" threshold

// ── Types ─────────────────────────────────────────────────────────────────────

interface PredictionRecord {
  type: "prediction";
  logged_at: string;         // wall-clock time this prediction was logged (tick time)
  obs_timestamp: string;     // vehicle GPS fix time from the GTFS-RT feed — base for predicted_arrival
  vehicle_id: string;
  route_id: string;
  trip_id: string;
  direction_id: string;
  obs_lat: number;
  obs_lng: number;
  segment_from: string;
  segment_to: string;
  segment_progress: number;
  stop_sequence: number;
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lng: number;
  eta_seconds: number;
  predicted_arrival: string; // obs_timestamp + eta_seconds
  sample_count: number;
}

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

type LogRecord = PredictionRecord | ActualArrivalRecord;

// Outstanding predictions keyed: `${vehicle_id}::${stop_id}`
interface PendingPrediction {
  predictionRecord: PredictionRecord;
  expiresAt: Date; // discard if vehicle hasn't reached stop by this time
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getLogFilePath(date: Date): string {
  const dateStr = date.toISOString().split("T")[0]!;
  return path.join(LOG_DIR, `prediction_log_${dateStr}.jsonl`);
}

function appendLog(record: LogRecord): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const filePath = getLogFilePath(new Date());
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Feed ──────────────────────────────────────────────────────────────────────

async function fetchLiveFeed(): Promise<VehicleObservation[]> {
  const fetchTime = new Date();
  const response = await fetchWithRetry(CONFIG.FEED_URL, {
    retries: CONFIG.FETCH_MAX_RETRIES,
    retryDelayMs: CONFIG.FETCH_RETRY_DELAY_MS,
    timeoutMs: CONFIG.FETCH_TIMEOUT_MS,
    headers: {
      "User-Agent": "ZET-PredictionLogger/1.0",
      Accept: "application/x-protobuf, application/octet-stream",
    },
  });

  const buffer = new Uint8Array(await response.arrayBuffer());
  const feed = FeedMessage.decode(buffer);
  const headerTs = Number(feed.header?.timestamp || 0);
  const defaultTs = headerTs > 0 ? new Date(headerTs * 1000).toISOString() : fetchTime.toISOString();

  return (feed.entity || []).flatMap((entity) => {
    const v = entity.vehicle;
    if (!v?.position) return [];
    return [
      {
        timestamp: Number(v.timestamp || 0) > 0
          ? new Date(Number(v.timestamp) * 1000).toISOString()
          : defaultTs,
        vehicle_id: String(v.vehicle?.id || v.vehicle?.label || entity.id || "").trim(),
        trip_id: String(v.trip?.tripId || "").trim(),
        route_id: String(v.trip?.routeId || "").trim(),
        latitude: Number(v.position.latitude),
        longitude: Number(v.position.longitude),
        bearing: v.position.bearing != null ? Number(v.position.bearing) : null,
        speed: v.position.speed != null ? Number(v.position.speed) : null,
      },
    ];
  });
}

// ── Predictor cache (one per route, lives for entire process) ─────────────────

interface PredictorEntry {
  predictor: GtfsMlPredictor;
  loadedAt: Date;
}

const predictorCache = new Map<string, PredictorEntry>();

async function getPredictor(db: ZetDatabase, routeId: string): Promise<GtfsMlPredictor | null> {
  const CACHE_TTL_MS = 30 * 60 * 1000; // re-learn every 30 min
  const cached = predictorCache.get(routeId);
  if (cached && Date.now() - cached.loadedAt.getTime() < CACHE_TTL_MS) {
    return cached.predictor;
  }

  try {
    const predictor = new GtfsMlPredictor(db, routeId);
    await predictor.loadGtfsStops();
    await predictor.learnSegmentTimes();
    predictorCache.set(routeId, { predictor, loadedAt: new Date() });
    return predictor;
  } catch (err) {
    console.error(`[PredictorCache] Failed to init predictor for route ${routeId}:`, err);
    return null;
  }
}

// ── On-path filter ────────────────────────────────────────────────────────────

function isOnPath(predictor: GtfsMlPredictor, tripId: string, lat: number, lng: number): boolean {
  const { routeStops } = predictor.determineDirection(tripId, lat, lng);
  const match = predictor.findNearestSegment(lat, lng, routeStops);
  return match.distanceMeters <= MAX_OFFPATH_METERS;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const pendingPredictions = new Map<string, PendingPrediction>();

async function tick(db: ZetDatabase, tickTime: Date): Promise<void> {
  log("Fetching live feed...");
  let vehicles: VehicleObservation[];
  try {
    vehicles = await fetchLiveFeed();
  } catch (err) {
    console.error("Feed fetch failed:", err);
    return;
  }

  log(`Live vehicles: ${vehicles.length}`);

  // ── Step 1: Check pending predictions against current positions ───────────
  let resolvedCount = 0;
  let staleTripCount = 0;
  const nowStr = tickTime.toISOString();

  // Build a map of vehicleId → current live trip_id so we can detect trip switches.
  const liveTripByVehicle = new Map<string, string>();
  for (const obs of vehicles) {
    if (obs.vehicle_id && obs.trip_id) {
      liveTripByVehicle.set(obs.vehicle_id, obs.trip_id);
    }
  }

  // First pass: discard any pending prediction whose vehicle has switched to a
  // different trip_id. This handles the X→Y then Y→X turnaround case: the
  // prediction was for trip T1 but the vehicle is now reporting trip T2, so the
  // stop proximity check would be meaningless (the stop could appear on both
  // directions and would trigger a false arrival event).
  for (const [key, pending] of pendingPredictions.entries()) {
    const { predictionRecord: pred } = pending;
    const currentTripId = liveTripByVehicle.get(pred.vehicle_id);

    if (currentTripId !== undefined && currentTripId !== pred.trip_id) {
      // Vehicle has started a new trip — this prediction is stale.
      pendingPredictions.delete(key);
      staleTripCount++;
      continue;
    }

    // Also expire by time.
    if (tickTime > pending.expiresAt) {
      pendingPredictions.delete(key);
    }
  }

  if (staleTripCount > 0) {
    log(`Discarded ${staleTripCount} pending prediction(s) — vehicle trip_id changed (route turnaround).`);
  }

  // Second pass: resolve predictions for vehicles that are close to their
  // predicted stop and still on the same trip.
  for (const obs of vehicles) {
    if (!obs.vehicle_id || !obs.trip_id) continue;

    for (const [key, pending] of pendingPredictions.entries()) {
      const { predictionRecord: pred } = pending;

      // Only match predictions for this specific vehicle on this specific trip.
      if (pred.vehicle_id !== obs.vehicle_id) continue;
      if (pred.trip_id !== obs.trip_id) continue;

      // Check if vehicle is close to the predicted stop.
      const distToStop = haversineDistanceMeters(
        obs.latitude, obs.longitude,
        pred.stop_lat, pred.stop_lng
      );

      if (distToStop <= ARRIVAL_DETECTION_METERS) {
        const predictedArrival = new Date(pred.predicted_arrival);
        // Use the vehicle's own GPS fix timestamp as the actual arrival time.
        // This is far more precise than tickTime, which is just when our poll
        // happened to run (up to POLL_INTERVAL_SEC seconds coarser).
        const actualArrival = new Date(obs.timestamp);
        const errorSeconds = (actualArrival.getTime() - predictedArrival.getTime()) / 1000;
        // Horizon = time between when the prediction was made and when the vehicle
        // was actually observed near the stop.
        const horizonMinutes = (actualArrival.getTime() - new Date(pred.obs_timestamp).getTime()) / 60000;

        const arrivalRecord: ActualArrivalRecord = {
          type: "actual_arrival",
          logged_at: nowStr,
          vehicle_id: pred.vehicle_id,
          route_id: pred.route_id,
          trip_id: pred.trip_id,
          stop_id: pred.stop_id,
          stop_name: pred.stop_name,
          stop_lat: pred.stop_lat,
          stop_lng: pred.stop_lng,
          actual_arrival: actualArrival.toISOString(),
          prediction_made_at: pred.logged_at,
          predicted_arrival: pred.predicted_arrival,
          horizon_minutes: Math.round(horizonMinutes * 10) / 10,
          error_seconds: Math.round(errorSeconds),
          abs_error_seconds: Math.round(Math.abs(errorSeconds)),
        };

        appendLog(arrivalRecord);
        pendingPredictions.delete(key);
        resolvedCount++;
      }
    }
  }

  if (resolvedCount > 0) {
    log(`Resolved ${resolvedCount} actual arrival(s).`);
  }

  // ── Step 2: Group live vehicles by route and run predictions ──────────────
  const byRoute = new Map<string, VehicleObservation[]>();
  for (const obs of vehicles) {
    if (!obs.route_id || !obs.vehicle_id) continue;
    const cleanRoute = obs.route_id.replace(/^0+/, "");
    if (!byRoute.has(cleanRoute)) byRoute.set(cleanRoute, []);
    byRoute.get(cleanRoute)!.push(obs);
  }

  let predictedVehicles = 0;
  let predictedStops = 0;

  for (const [routeId, routeVehicles] of byRoute.entries()) {
    const predictor = await getPredictor(db, routeId);
    if (!predictor) continue;

    for (const obs of routeVehicles) {
      // Filter: vehicle must be on-path
      if (!isOnPath(predictor, obs.trip_id, obs.latitude, obs.longitude)) continue;

      // Use the vehicle's own GPS fix time as the prediction base, not tickTime.
      // This matches how predict_vehicle.ts works and avoids a systematic offset
      // equal to how stale the GTFS-RT feed observation is (~15-30 s typically).
      const obsTime = new Date(obs.timestamp);

      let predResult: ReturnType<typeof predictor.predict>;
      try {
        predResult = predictor.predict(
          obs.trip_id,
          obs.latitude,
          obs.longitude,
          obs.bearing,
          obsTime   // ← vehicle GPS fix time, not wall-clock
        );
      } catch {
        continue;
      }

      // Only log stops within a reasonable prediction horizon (e.g., next 30 minutes)
      const MAX_HORIZON_SEC = 30 * 60;
      const usefulResults: StopEtaResult[] = predResult.results.filter(
        (r) => r.etaSeconds >= 0 && r.etaSeconds <= MAX_HORIZON_SEC
      );

      if (usefulResults.length === 0) continue;

      predictedVehicles++;

      for (const result of usefulResults) {
        const predRecord: PredictionRecord = {
          type: "prediction",
          logged_at: nowStr,             // tick wall-clock time
          obs_timestamp: obs.timestamp,  // vehicle GPS fix time (prediction anchor)
          vehicle_id: obs.vehicle_id,
          route_id: routeId,
          trip_id: obs.trip_id,
          direction_id: predResult.directionId,
          obs_lat: obs.latitude,
          obs_lng: obs.longitude,
          segment_from: predResult.segmentMatch.fromStop.stopName,
          segment_to: predResult.segmentMatch.toStop.stopName,
          segment_progress: Math.round(predResult.segmentMatch.progress * 1000) / 1000,
          stop_sequence: result.stopSequence,
          stop_id: result.stopId,
          stop_name: result.stopName,
          stop_lat: result.latitude,
          stop_lng: result.longitude,
          eta_seconds: result.etaSeconds,
          // predicted_arrival is anchored to obs_timestamp (the vehicle's GPS fix),
          // which is what predict() uses internally.
          predicted_arrival: result.predictedArrivalTimestamp.toISOString(),
          sample_count: result.sampleCount,
        };

        appendLog(predRecord);
        predictedStops++;

        // Register this as a pending prediction to check in future ticks.
        // Key includes trip_id so the same stop visited on a return trip is
        // tracked as a completely independent prediction event.
        const pendingKey = `${obs.vehicle_id}::${obs.trip_id}::${result.stopId}`;
        // Only store the first (earliest) prediction for this vehicle+trip+stop tuple.
        if (!pendingPredictions.has(pendingKey)) {
          pendingPredictions.set(pendingKey, {
            predictionRecord: predRecord,
            // Expire 2x the ETA (plus a 5-min grace) to allow for late arrivals.
            expiresAt: new Date(tickTime.getTime() + result.etaSeconds * 2 * 1000 + 5 * 60 * 1000),
          });
        }
      }
    }
  }

  log(`Predicted ${predictedStops} stop ETAs for ${predictedVehicles} on-path vehicles. Pending checks: ${pendingPredictions.size}`);
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("=== Prediction Accuracy Logger started ===");
  log(`Poll interval: ${POLL_INTERVAL_SEC}s | Max off-path: ${MAX_OFFPATH_METERS}m | Arrival threshold: ${ARRIVAL_DETECTION_METERS}m`);
  log(`Logs directory: ${LOG_DIR}`);

  const db = new ZetDatabase();
  await db.initSchema();

  let keepRunning = true;
  const shutdown = (): void => {
    log("Shutting down gracefully...");
    keepRunning = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (keepRunning) {
    const tickStart = Date.now();
    const tickTime = new Date();

    try {
      await tick(db, tickTime);
    } catch (err) {
      console.error("Tick error:", err);
    }

    const elapsed = Date.now() - tickStart;
    const waitMs = Math.max(0, POLL_INTERVAL_SEC * 1000 - elapsed);

    if (!keepRunning) break;
    log(`Tick completed in ${elapsed}ms. Waiting ${Math.round(waitMs / 1000)}s until next tick...`);
    await Bun.sleep(waitMs);
  }

  await db.close();
  log("=== Prediction Accuracy Logger stopped ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
