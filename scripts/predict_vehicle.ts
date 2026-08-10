import transitRealtime from "gtfs-realtime-bindings";
import { CONFIG } from "../src/config";
import { ZetDatabase, type VehicleObservation } from "../src/db";
import { GtfsMlPredictor, haversineDistanceMeters } from "../src/prediction/gtfs_ml_predictor";

const { FeedMessage } = transitRealtime.transit_realtime;

async function fetchLiveFeed(): Promise<VehicleObservation[]> {
  const fetchTime = new Date();
  const response = await fetch(CONFIG.FEED_URL, {
    headers: {
      "User-Agent": "ZET-GTFS-ML-Predictor/2.0",
      Accept: "application/x-protobuf, application/octet-stream",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP error ${response.status}`);

  const buffer = new Uint8Array(await response.arrayBuffer());
  const feed = FeedMessage.decode(buffer);
  const headerTs = Number(feed.header?.timestamp || 0);
  const defaultTs = headerTs > 0 ? new Date(headerTs * 1000).toISOString() : fetchTime.toISOString();

  return (feed.entity || []).flatMap((entity) => {
    const v = entity.vehicle;
    if (!v?.position) return [];
    return [{
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
    }];
  });
}

async function main() {
  const targetVehicleId = process.argv[2] ?? "";

  if (!targetVehicleId) {
    console.log("Usage: bun run predict <VehicleID>");
    console.log("Example: bun run predict 102213");
    process.exit(1);
  }

  console.log("==========================================================================");
  console.log("  GTFS MULTI-LINE LIVE TRAM PREDICTOR (Real-time GPS + Learned ML Model)");
  console.log("==========================================================================\n");

  console.log(`[${new Date().toISOString()}] Fetching live GTFS-RT feed from ZET API...`);
  const liveObs = await fetchLiveFeed();
  console.log(`Live feed active vehicles: ${liveObs.length}`);

  let tram = liveObs.find((o) => o.vehicle_id.includes(targetVehicleId));

  const db = new ZetDatabase("duckdb/zet.duckdb");
  await db.initSchema();

  if (!tram) {
    console.log(`Vehicle ${targetVehicleId} not in active live feed. Checking recent parquet observation...`);
    const recent = await db.query<VehicleObservation>(`
      SELECT timestamp, vehicle_id, trip_id, route_id, latitude, longitude, bearing, speed
      FROM read_parquet('data/*/*/*.parquet')
      WHERE vehicle_id = '${targetVehicleId}'
      ORDER BY timestamp DESC LIMIT 1
    `);
    tram = recent[0];
  }

  if (!tram) {
    console.log(`❌ Vehicle ${targetVehicleId} could not be found in live feed or historical observations.`);
    await db.close();
    return;
  }

  const rawRouteId = tram.route_id || "11";
  const cleanRouteId = rawRouteId.replace(/^0+/, "");

  console.log(`\nFound Vehicle ${tram.vehicle_id} operating on Route ${cleanRouteId}.`);

  // 1. Init Predictor for this specific vehicle's route
  const predictor = new GtfsMlPredictor(db, cleanRouteId);

  // 2. Load GTFS stops for vehicle route
  await predictor.loadGtfsStops();

  // 3. Learn segment travel times for vehicle route
  await predictor.learnSegmentTimes();

  // 4. Run prediction
  const obsTime = new Date(tram.timestamp);
  const { currentStop, segmentMatch, directionId, headsign, results } = predictor.predict(
    tram.trip_id, tram.latitude, tram.longitude, tram.bearing, obsTime
  );

  const distToStop = haversineDistanceMeters(tram.latitude, tram.longitude, currentStop.latitude, currentStop.longitude);
  const progressPct = Math.round(segmentMatch.progress * 100);

  console.log("\n==========================================================================");
  console.log("  LIVE TRAM DETAILS");
  console.log("==========================================================================");
  console.log(`• Vehicle ID      : ${tram.vehicle_id}`);
  console.log(`• Route ID        : Route ${cleanRouteId}`);
  console.log(`• Trip ID         : ${tram.trip_id}`);
  console.log(`• Direction       : Direction ${directionId} (${headsign ? `→ Towards ${headsign}` : "Terminus"})`);
  console.log(`• Timestamp       : ${obsTime.toLocaleTimeString()} (${obsTime.toISOString()})`);
  console.log(`• GPS Position    : ${tram.latitude.toFixed(5)}, ${tram.longitude.toFixed(5)}`);
  console.log(`• Speed           : ${tram.speed != null ? `${(tram.speed * 3.6).toFixed(1)} km/h` : "Stopped"}`);
  console.log(`• Track Position  : ${segmentMatch.fromStop.stopName} → ${segmentMatch.toStop.stopName} (${progressPct}% completed)`);
  console.log(`• Nearest Stop    : ${currentStop.stopName} (${Math.round(distToStop)}m away)`);
  console.log("==========================================================================\n");

  console.log(`  PREDICTED ARRIVAL AT ALL UPCOMING STOPS FOR ROUTE ${cleanRouteId} (${headsign}):\n`);

  const table: any[] = [];

  for (const r of results) {
    table.push({
      "#": r.stopSequence,
      "Stop Name": r.stopName,
      "ETA": `+${(r.etaSeconds / 60).toFixed(1)} min`,
      "Predicted Clock": r.predictedArrivalTimestamp.toLocaleTimeString(),
      "Learned Samples": r.sampleCount > 0 ? `${r.sampleCount} trips` : "fallback",
    });
  }

  console.table(table);
  await db.close();
}

main().catch(console.error);
