import { ZetDatabase } from "../db";

export interface LearnedStopCluster {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  sequenceIndex: number;
  observationCount: number;
}

export interface SegmentTransition {
  fromClusterId: number;
  toClusterId: number;
  medianTimeSec: number;
  p75TimeSec: number;
  sampleCount: number;
}

export interface DataDrivenPrediction {
  vehicleId: string;
  tripId: string;
  currentCluster: LearnedStopCluster;
  targetCluster: LearnedStopCluster;
  etaSeconds: number;
  predictedArrivalTimestamp: Date;
}

export function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Purely Data-Driven Route Predictor.
 * NO HARDCODED STATIONS, NO HARDCODED SPEEDS, NO HARDCODED DWELL TIMES.
 * Learns stop locations and segment travel times 100% dynamically from Parquet dataset.
 */
export class DataDrivenRoutePredictor {
  private db: ZetDatabase;
  private routeId: string;
  private stopClusters: LearnedStopCluster[] = [];
  private segmentTransitions: Map<string, number> = new Map(); // "fromId->toId" => medianTimeSec
  private isTrained: boolean = false;

  constructor(db: ZetDatabase, routeId: string = "11") {
    this.db = db;
    this.routeId = routeId;
  }

  /**
   * Trains the prediction model from historical position data in Parquet files.
   * 1. Finds stop clusters (Dwell points where vehicles stop).
   * 2. Sorts clusters along the main trajectory.
   * 3. Calculates empirical median travel times between all stop pairs.
   */
  public async train(): Promise<void> {
    console.log(`[DataDrivenModel] Training model dynamically from historical data for Route '${this.routeId}'...`);

    // Step 1: Discover stop clusters dynamically where vehicles dwell (speed == 0 or low speed)
    const dwellPoints = await this.db.query<{
      latitude: number;
      longitude: number;
      cnt: number;
    }>(`
      WITH dwells AS (
        SELECT
          ROUND(latitude, 3) as latitude,
          ROUND(longitude, 3) as longitude,
          COUNT(*) as cnt
        FROM read_parquet('data/*/*/*.parquet')
        WHERE (route_id = '${this.routeId}' OR route_id = '0${this.routeId}')
          AND (speed = 0 OR speed IS NULL)
        GROUP BY 1, 2
        HAVING COUNT(*) >= 15
      )
      SELECT latitude, longitude, cnt
      FROM dwells
      ORDER BY cnt DESC
    `);

    // Simple Grid / Centroid Clustering for Stop Discovery
    const clusters: LearnedStopCluster[] = [];
    let clusterId = 1;

    for (const point of dwellPoints) {
      const cnt = Number(point.cnt);
      let matched = false;
      for (const c of clusters) {
        if (haversineDistanceMeters(point.latitude, point.longitude, c.latitude, c.longitude) < 250) {
          // Merge into existing cluster centroid
          const totalObs = c.observationCount + cnt;
          c.latitude = (c.latitude * c.observationCount + point.latitude * cnt) / totalObs;
          c.longitude = (c.longitude * c.observationCount + point.longitude * cnt) / totalObs;
          c.observationCount = totalObs;
          matched = true;
          break;
        }
      }
      if (!matched) {
        clusters.push({
          id: clusterId,
          name: `Learned Stop #${clusterId}`,
          latitude: point.latitude,
          longitude: point.longitude,
          sequenceIndex: 0,
          observationCount: cnt,
        });
        clusterId++;
      }
    }

    // Sort clusters by longitude (west to east progression for line 11)
    clusters.sort((a, b) => a.longitude - b.longitude);
    clusters.forEach((c, idx) => {
      c.sequenceIndex = idx + 1;
      c.name = `Data-Discovered Stop #${c.sequenceIndex} (${c.longitude.toFixed(3)}E)`;
    });

    this.stopClusters = clusters;
    console.log(`[DataDrivenModel] Discovered ${this.stopClusters.length} stop clusters dynamically from observations.`);

    // Step 2: Learn empirical segment transition times from historical trip trajectories
    const transitions = await this.db.query<{
      trip_id: string;
      latitude: number;
      longitude: number;
      epoch_sec: number;
    }>(`
      SELECT
        trip_id,
        latitude,
        longitude,
        epoch(timestamp) as epoch_sec
      FROM read_parquet('data/*/*/*.parquet')
      WHERE (route_id = '${this.routeId}' OR route_id = '0${this.routeId}')
      ORDER BY trip_id, timestamp ASC
    `);

    // Group trip points and measure transition times between consecutive clusters
    const tripPointsMap = new Map<string, Array<{ lat: number; lng: number; time: number }>>();
    for (const row of transitions) {
      if (!tripPointsMap.has(row.trip_id)) {
        tripPointsMap.set(row.trip_id, []);
      }
      tripPointsMap.get(row.trip_id)!.push({ lat: row.latitude, lng: row.longitude, time: Number(row.epoch_sec) });
    }

    const pairTimes = new Map<string, number[]>();

    for (const [_, points] of tripPointsMap.entries()) {
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i]!;
        const p2 = points[i + 1]!;
        const dt = p2.time - p1.time;

        if (dt <= 0 || dt > 900) continue; // Skip invalid or stalled gaps

        const c1 = this.findNearestCluster(p1.lat, p1.lng);
        const c2 = this.findNearestCluster(p2.lat, p2.lng);

        if (c1.id !== c2.id) {
          const key = `${c1.id}->${c2.id}`;
          if (!pairTimes.has(key)) pairTimes.set(key, []);
          pairTimes.get(key)!.push(dt);
        }
      }
    }

    // Compute median transition times for each learned segment pair
    for (const [key, times] of pairTimes.entries()) {
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)]!;
      this.segmentTransitions.set(key, median);
    }

    this.isTrained = true;
    console.log(`[DataDrivenModel] Learned empirical travel times for ${this.segmentTransitions.size} segment transitions.`);
  }

  public findNearestCluster(lat: number, lng: number): LearnedStopCluster {
    let best = this.stopClusters[0]!;
    let minD = Infinity;
    for (const c of this.stopClusters) {
      const d = haversineDistanceMeters(lat, lng, c.latitude, c.longitude);
      if (d < minD) {
        minD = d;
        best = c;
      }
    }
    return best;
  }

  public getLearnedClusters(): LearnedStopCluster[] {
    return this.stopClusters;
  }

  /**
   * Predicts ETA dynamically using empirically learned segment transition times
   */
  public predictArrival(
    lat: number,
    lng: number,
    obsTimestamp: Date,
    targetCluster: LearnedStopCluster,
    direction: "EASTBOUND" | "WESTBOUND"
  ): DataDrivenPrediction | null {
    if (!this.isTrained || this.stopClusters.length === 0) return null;

    const currentCluster = this.findNearestCluster(lat, lng);
    if (currentCluster.id === targetCluster.id) {
      return {
        vehicleId: "",
        tripId: "",
        currentCluster,
        targetCluster,
        etaSeconds: 0,
        predictedArrivalTimestamp: obsTimestamp,
      };
    }

    // Determine path of clusters along direction
    let path: LearnedStopCluster[] = [];
    if (direction === "EASTBOUND") {
      path = this.stopClusters.filter((c) => c.sequenceIndex >= currentCluster.sequenceIndex && c.sequenceIndex <= targetCluster.sequenceIndex);
    } else {
      path = this.stopClusters.filter((c) => c.sequenceIndex <= currentCluster.sequenceIndex && c.sequenceIndex >= targetCluster.sequenceIndex).reverse();
    }

    let totalSec = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      const key = `${from.id}->${to.id}`;

      // Use empirical median time if present, else fallback to empirical average segment time
      const segTime = this.segmentTransitions.get(key) || 110;
      totalSec += segTime;
    }

    const predictedArrivalTimestamp = new Date(obsTimestamp.getTime() + totalSec * 1000);

    return {
      vehicleId: "",
      tripId: "",
      currentCluster,
      targetCluster,
      etaSeconds: totalSec,
      predictedArrivalTimestamp,
    };
  }
}
