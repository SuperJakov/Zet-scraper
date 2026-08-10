import fs from "node:fs";
import path from "node:path";
import { ZetDatabase } from "../db";

// ─── GTFS Types ────────────────────────────────────────────────────────────────

export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: number;
  stop_lon: number;
}

export interface RouteStop {
  stopSequence: number;
  stopId: string;
  stopName: string;
  latitude: number;
  longitude: number;
}

export interface StopEtaResult {
  stopSequence: number;
  stopId: string;
  stopName: string;
  latitude: number;
  longitude: number;
  etaSeconds: number;
  predictedArrivalTimestamp: Date;
  sampleCount: number; // how many real trips the model learned this segment from
}

export interface SegmentMatch {
  segmentIndex: number;
  fromStop: RouteStop;
  toStop: RouteStop;
  progress: number; // 0.0 (at fromStop) to 1.0 (at toStop)
  distanceMeters: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function projectOntoSegment(
  pLat: number,
  pLon: number,
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): { progress: number; distanceMeters: number } {
  const cosLat = Math.cos((lat1 * Math.PI) / 180);
  const vx = (lon2 - lon1) * 111320 * cosLat;
  const vy = (lat2 - lat1) * 111320;
  const px = (pLon - lon1) * 111320 * cosLat;
  const py = (pLat - lat1) * 111320;

  const lenSq = vx * vx + vy * vy;
  if (lenSq === 0) {
    return { progress: 0, distanceMeters: haversineDistanceMeters(pLat, pLon, lat1, lon1) };
  }

  const t = (px * vx + py * vy) / lenSq;
  const progress = Math.max(0, Math.min(1, t));

  const projLat = lat1 + progress * (lat2 - lat1);
  const projLon = lon1 + progress * (lon2 - lon1);

  const distanceMeters = haversineDistanceMeters(pLat, pLon, projLat, projLon);
  return { progress, distanceMeters };
}

function parseGtfsCsv(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.replace(/\r/g, "").split("\n").filter(Boolean);
  const headers = lines[0]!.split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map((line) => {
    const values: string[] = [];
    let inQuotes = false;
    let current = "";
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === "," && !inQuotes) { values.push(current); current = ""; }
      else { current += ch; }
    }
    values.push(current);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (values[i] ?? "").trim(); });
    return obj;
  });
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// ─── Main Predictor ───────────────────────────────────────────────────────────

/**
 * GTFS-stops + High-Precision ML travel time predictor.
 *
 * Stations  → fetched from ZET GTFS static feed (stops.txt / stop_times.txt / trips.txt)
 * ETA model → learned from historical Parquet GPS observations using direction-aware,
 *              hourly-binned travel times with fractional segment projection.
 */
export class GtfsMlPredictor {
  private db: ZetDatabase;
  private routeId: string;
  private gtfsDir: string;

  /** Route stops for direction 0 (FORWARD) and direction 1 (REVERSE) */
  private routeStopsDir0: RouteStop[] = [];
  private routeStopsDir1: RouteStop[] = [];

  /** Trip lookup map: trip_id -> { direction_id, trip_headsign } */
  private tripMap: Map<string, { directionId: string; headsign: string }> = new Map();

  /**
   * Empirically learned median travel time (seconds) between consecutive stops.
   * Keys:
   *   Directional global key: `fromSeq->toSeq`
   *   Hourly binned key:     `fromSeq->toSeq_h{hour}`
   */
  private learnedSegmentSec: Map<string, { median: number; samples: number }> = new Map();

  constructor(db: ZetDatabase, routeId: string = "11", gtfsDir: string = "duckdb/gtfs_zet") {
    this.db = db;
    this.routeId = routeId;
    this.gtfsDir = gtfsDir;
  }

  public async ensureGtfsFeed(): Promise<void> {
    const stopsPath = path.join(this.gtfsDir, "stops.txt");
    if (fs.existsSync(stopsPath)) return;

    console.log(`[GtfsML] GTFS static feed not found at ${this.gtfsDir}. Downloading automatically from ZET...`);
    fs.mkdirSync(this.gtfsDir, { recursive: true });
    const zipPath = path.join(this.gtfsDir, "..", "gtfs_zet.zip");

    const res = await fetch("https://www.zet.hr/gtfs-scheduled/latest");
    if (!res.ok) throw new Error(`Failed to download GTFS static feed: HTTP ${res.status}`);

    const arrayBuffer = await res.arrayBuffer();
    fs.writeFileSync(zipPath, Buffer.from(arrayBuffer));

    // Unzip using system unzip / tar / powershell
    const proc = Bun.spawnSync(["powershell", "-Command", `Expand-Archive -Path "${zipPath}" -DestinationPath "${this.gtfsDir}" -Force`]);
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract GTFS zip file: ${proc.stderr.toString()}`);
    }
    console.log(`[GtfsML] GTFS static feed downloaded and extracted successfully.`);
  }

  // ─── Phase 1: Load stop sequence from GTFS ──────────────────────────────────

  public async loadGtfsStops(): Promise<void> {
    await this.ensureGtfsFeed();
    console.log(`[GtfsML] Loading route ${this.routeId} stops from GTFS static feed...`);

    const stops = parseGtfsCsv(path.join(this.gtfsDir, "stops.txt"));
    const stopMap = new Map<string, GtfsStop>();
    for (const s of stops) {
      const id = s["stop_id"] ?? "";
      const name = s["stop_name"] ?? id;
      const lat = parseFloat(s["stop_lat"] ?? "0");
      const lon = parseFloat(s["stop_lon"] ?? "0");
      if (!id) continue;
      stopMap.set(id, { stop_id: id, stop_name: name, stop_lat: lat, stop_lon: lon });
    }

    const trips = parseGtfsCsv(path.join(this.gtfsDir, "trips.txt"));
    const cleanRouteId = this.routeId.replace(/^0+/, "");
    const routeTrips = trips.filter((t) => (t["route_id"] ?? "").replace(/^0+/, "") === cleanRouteId);
    if (routeTrips.length === 0) {
      throw new Error(`No trips found for route_id '${this.routeId}' in GTFS trips.txt`);
    }

    for (const t of routeTrips) {
      const tid = t["trip_id"] ?? "";
      if (tid) {
        this.tripMap.set(tid, {
          directionId: t["direction_id"] ?? "0",
          headsign: t["trip_headsign"] ?? "",
        });
      }
    }

    const allRouteTripIds = new Set(routeTrips.map((t) => t["trip_id"] ?? ""));
    const stopTimes = parseGtfsCsv(path.join(this.gtfsDir, "stop_times.txt"));

    const tripStopCount = new Map<string, number>();
    for (const st of stopTimes) {
      const tid = st["trip_id"] ?? "";
      if (!allRouteTripIds.has(tid)) continue;
      tripStopCount.set(tid, (tripStopCount.get(tid) ?? 0) + 1);
    }

    const buildDirectionStops = (dirId: string): RouteStop[] => {
      const dirTrips = routeTrips.filter((t) => (t["direction_id"] ?? "") === dirId);
      if (dirTrips.length === 0) return [];

      const shapeInfo = new Map<string, { freq: number; maxStops: number; headsign: string }>();
      for (const t of dirTrips) {
        const shape = t["shape_id"] ?? "";
        const tid = t["trip_id"] ?? "";
        const stopCount = tripStopCount.get(tid) ?? 0;
        if (!shapeInfo.has(shape)) {
          shapeInfo.set(shape, { freq: 0, maxStops: 0, headsign: t["trip_headsign"] ?? "" });
        }
        const info = shapeInfo.get(shape)!;
        info.freq++;
        info.maxStops = Math.max(info.maxStops, stopCount);
      }

      if (shapeInfo.size === 0) return [];

      const maxStops = Math.max(...Array.from(shapeInfo.values()).map((i) => i.maxStops));
      const fullShapes = Array.from(shapeInfo.entries())
        .filter(([, info]) => info.maxStops >= maxStops - 2)
        .sort((a, b) => b[1].freq - a[1].freq || b[1].maxStops - a[1].maxStops);

      const [canonicalShapeId, canonicalInfo] = fullShapes[0]!;
      const canonicalTrip = dirTrips.find((t) => t["shape_id"] === canonicalShapeId);
      if (!canonicalTrip) return [];
      const canonicalTripId = canonicalTrip["trip_id"] ?? "";

      console.log(`[GtfsML] Direction ${dirId} canonical shape '${canonicalShapeId}' (Headsign: "${canonicalInfo.headsign}")`);

      const canonicalStops = stopTimes
        .filter((st) => (st["trip_id"] ?? "") === canonicalTripId)
        .map((st) => ({ seq: parseInt(st["stop_sequence"] ?? "0"), stopId: st["stop_id"] ?? "" }))
        .sort((a, b) => a.seq - b.seq);

      return canonicalStops.map(({ seq, stopId }) => {
        const s = stopMap.get(stopId);
        return {
          stopSequence: seq,
          stopId,
          stopName: s?.stop_name ?? stopId,
          latitude: s?.stop_lat ?? 0,
          longitude: s?.stop_lon ?? 0,
        };
      });
    };

    this.routeStopsDir0 = buildDirectionStops("0");
    this.routeStopsDir1 = buildDirectionStops("1");

    // Fallback if direction 1 was missing in trips: reverse direction 0
    if (this.routeStopsDir1.length === 0 && this.routeStopsDir0.length > 0) {
      this.routeStopsDir1 = this.routeStopsDir0.slice().reverse().map((s, idx) => ({
        ...s,
        stopSequence: idx + 1,
      }));
    }

    console.log(`[GtfsML] Loaded ${this.routeStopsDir0.length} stops (Dir 0) & ${this.routeStopsDir1.length} stops (Dir 1) for route ${this.routeId}.`);
  }

  // ─── Phase 2: Learn direction-aware & hourly travel times ────────────────────

  public async learnSegmentTimes(): Promise<void> {
    console.log(`[GtfsML] Learning direction-aware & hourly segment travel times...`);

    const cleanRouteId = this.routeId.replace(/^0+/, "");
    const rows = await this.db.query<{
      trip_id: string;
      latitude: number;
      longitude: number;
      epoch_sec: number;
      hour_of_day: number;
    }>(`
      SELECT
        trip_id,
        latitude,
        longitude,
        epoch(timestamp) AS epoch_sec,
        extract(hour from timestamp) AS hour_of_day
      FROM read_parquet('data/*/*/*.parquet')
      WHERE route_id = '${cleanRouteId}' OR route_id = '0${cleanRouteId}'
      ORDER BY trip_id, timestamp ASC
    `);

    const byTrip = new Map<string, Array<{ lat: number; lng: number; t: number; hour: number }>>();
    for (const r of rows) {
      const t = Number(r.epoch_sec);
      const hour = Number(r.hour_of_day);
      if (!byTrip.has(r.trip_id)) byTrip.set(r.trip_id, []);
      byTrip.get(r.trip_id)!.push({ lat: r.latitude, lng: r.longitude, t, hour });
    }

    const rawSegmentTimes = new Map<string, number[]>();

    for (const [tripId, points] of byTrip.entries()) {
      if (points.length < 5) continue;

      const tripMeta = this.tripMap.get(tripId);
      const isDir1 = tripMeta?.directionId === "1";
      const stopsToUse = isDir1 ? this.routeStopsDir1 : this.routeStopsDir0;

      const stopArrivals: Array<{ seq: number; t: number; hour: number }> = [];

      for (const stop of stopsToUse) {
        let bestDist = 200;
        let bestTime = -1;
        let bestHour = -1;
        for (const p of points) {
          const d = haversineDistanceMeters(p.lat, p.lng, stop.latitude, stop.longitude);
          if (d < bestDist) {
            bestDist = d;
            bestTime = p.t;
            bestHour = p.hour;
          }
        }
        if (bestTime >= 0) {
          stopArrivals.push({ seq: stop.stopSequence, t: bestTime, hour: bestHour });
        }
      }

      stopArrivals.sort((a, b) => a.t - b.t);

      for (let i = 0; i < stopArrivals.length - 1; i++) {
        const fromObs = stopArrivals[i]!;
        const toObs = stopArrivals[i + 1]!;
        const dt = toObs.t - fromObs.t;

        if (dt >= 10 && dt <= 600) {
          const dirPrefix = isDir1 ? "d1_" : "d0_";
          const keyGlobal = `${dirPrefix}${fromObs.seq}->${toObs.seq}`;
          const keyHourly = `${dirPrefix}${fromObs.seq}->${toObs.seq}_h${fromObs.hour}`;

          if (!rawSegmentTimes.has(keyGlobal)) rawSegmentTimes.set(keyGlobal, []);
          if (!rawSegmentTimes.has(keyHourly)) rawSegmentTimes.set(keyHourly, []);

          rawSegmentTimes.get(keyGlobal)!.push(dt);
          rawSegmentTimes.get(keyHourly)!.push(dt);
        }
      }
    }

    for (const [key, times] of rawSegmentTimes.entries()) {
      this.learnedSegmentSec.set(key, { median: median(times), samples: times.length });
    }

    console.log(`[GtfsML] Learned ${this.learnedSegmentSec.size} directional/hourly travel time models across segments.`);
  }

  // ─── Phase 3: High-Precision Fractional Projection & ETAs ─────────────────

  public findNearestSegment(
    lat: number,
    lng: number,
    stops: RouteStop[]
  ): SegmentMatch {
    let bestMatch: SegmentMatch = {
      segmentIndex: 0,
      fromStop: stops[0]!,
      toStop: stops[1] ?? stops[0]!,
      progress: 0,
      distanceMeters: Infinity,
    };

    for (let i = 0; i < stops.length - 1; i++) {
      const s1 = stops[i]!;
      const s2 = stops[i + 1]!;
      const proj = projectOntoSegment(lat, lng, s1.latitude, s1.longitude, s2.latitude, s2.longitude);

      if (proj.distanceMeters < bestMatch.distanceMeters) {
        bestMatch = {
          segmentIndex: i,
          fromStop: s1,
          toStop: s2,
          progress: proj.progress,
          distanceMeters: proj.distanceMeters,
        };
      }
    }

    return bestMatch;
  }

  public findNearestStop(lat: number, lng: number, stops: RouteStop[]): RouteStop {
    let best = stops[0]!;
    let bestDist = Infinity;
    for (const stop of stops) {
      const d = haversineDistanceMeters(lat, lng, stop.latitude, stop.longitude);
      if (d < bestDist) { bestDist = d; best = stop; }
    }
    return best;
  }

  public determineDirection(
    tripId: string,
    lat: number,
    lng: number
  ): { directionId: string; headsign: string; routeStops: RouteStop[] } {
    // 1. Direct GTFS tripId lookup from ZET feed
    const tripMeta = this.tripMap.get(tripId);
    if (tripMeta) {
      const stops = tripMeta.directionId === "1" ? this.routeStopsDir1 : this.routeStopsDir0;
      const headsign = tripMeta.headsign || (tripMeta.directionId === "1" ? stops[stops.length - 1]?.stopName : stops[stops.length - 1]?.stopName) || "";
      return { directionId: tripMeta.directionId, headsign, routeStops: stops };
    }

    // 2. Trajectory distance check fallback
    const match0 = this.findNearestSegment(lat, lng, this.routeStopsDir0);
    const match1 = this.findNearestSegment(lat, lng, this.routeStopsDir1);

    if (match1.distanceMeters < match0.distanceMeters) {
      const stops = this.routeStopsDir1;
      return { directionId: "1", headsign: stops[stops.length - 1]?.stopName ?? "", routeStops: stops };
    }

    const stops = this.routeStopsDir0;
    return { directionId: "0", headsign: stops[stops.length - 1]?.stopName ?? "", routeStops: stops };
  }

  private getLearnedSegmentTime(
    fromSeq: number,
    toSeq: number,
    hour: number,
    isDir1: boolean,
    stops: RouteStop[]
  ): { segSec: number; samples: number } {
    const dirPrefix = isDir1 ? "d1_" : "d0_";
    const keyHourly = `${dirPrefix}${fromSeq}->${toSeq}_h${hour}`;
    const keyGlobal = `${dirPrefix}${fromSeq}->${toSeq}`;

    const hourly = this.learnedSegmentSec.get(keyHourly);
    if (hourly && hourly.samples >= 3) {
      return { segSec: hourly.median, samples: hourly.samples };
    }

    const global = this.learnedSegmentSec.get(keyGlobal);
    if (global && global.samples > 0) {
      return { segSec: global.median, samples: global.samples };
    }

    // Fallback: straight-line distance / average speed
    const s1 = stops.find((s) => s.stopSequence === fromSeq);
    const s2 = stops.find((s) => s.stopSequence === toSeq);
    if (s1 && s2) {
      const dist = haversineDistanceMeters(s1.latitude, s1.longitude, s2.latitude, s2.longitude);
      return { segSec: dist / 5.0, samples: 0 };
    }

    return { segSec: 60, samples: 0 };
  }

  public predict(
    tripId: string,
    lat: number,
    lng: number,
    bearing: number | null,
    observedAt: Date
  ): {
    currentStop: RouteStop;
    segmentMatch: SegmentMatch;
    directionId: string;
    headsign: string;
    results: StopEtaResult[];
  } {
    const { directionId, headsign, routeStops } = this.determineDirection(tripId, lat, lng);
    const isDir1 = directionId === "1";

    const currentStop = this.findNearestStop(lat, lng, routeStops);
    const segmentMatch = this.findNearestSegment(lat, lng, routeStops);
    const hour = observedAt.getHours();

    const downstreamStops = routeStops.slice(segmentMatch.segmentIndex + 1);

    const results: StopEtaResult[] = [];
    let cumulativeSec = 0;

    // Remaining time for the current segment
    const { segSec: currentSegSec, samples: currentSegSamples } = this.getLearnedSegmentTime(
      segmentMatch.fromStop.stopSequence,
      segmentMatch.toStop.stopSequence,
      hour,
      isDir1,
      routeStops
    );

    const remainingCurrentSegSec = (1 - segmentMatch.progress) * currentSegSec;
    cumulativeSec += remainingCurrentSegSec;

    // Add first downstream stop
    results.push({
      stopSequence: segmentMatch.toStop.stopSequence,
      stopId: segmentMatch.toStop.stopId,
      stopName: segmentMatch.toStop.stopName,
      latitude: segmentMatch.toStop.latitude,
      longitude: segmentMatch.toStop.longitude,
      etaSeconds: Math.max(0, Math.round(cumulativeSec)),
      predictedArrivalTimestamp: new Date(observedAt.getTime() + cumulativeSec * 1000),
      sampleCount: currentSegSamples,
    });

    let prevStop = segmentMatch.toStop;

    // Add remaining downstream stops
    for (let i = 1; i < downstreamStops.length; i++) {
      const stop = downstreamStops[i]!;
      const { segSec, samples } = this.getLearnedSegmentTime(prevStop.stopSequence, stop.stopSequence, hour, isDir1, routeStops);

      cumulativeSec += segSec;
      results.push({
        stopSequence: stop.stopSequence,
        stopId: stop.stopId,
        stopName: stop.stopName,
        latitude: stop.latitude,
        longitude: stop.longitude,
        etaSeconds: Math.round(cumulativeSec),
        predictedArrivalTimestamp: new Date(observedAt.getTime() + cumulativeSec * 1000),
        sampleCount: samples,
      });

      prevStop = stop;
    }

    return { currentStop, segmentMatch, directionId, headsign, results };
  }

  public getRouteStops(directionId: string = "0"): RouteStop[] {
    return directionId === "1" ? this.routeStopsDir1 : this.routeStopsDir0;
  }
}


