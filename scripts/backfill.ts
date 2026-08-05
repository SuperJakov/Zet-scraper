import transitRealtime from "gtfs-realtime-bindings";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../src/config";
import { ZetDatabase, type VehicleObservation } from "../src/db";
import { exportAccumulatedData } from "../src/exporter";
import { logger } from "../src/logger";

const { FeedMessage } = transitRealtime.transit_realtime;

async function backfill() {
  const args = process.argv.slice(2);
  const targetDir = args[0]
    ? path.resolve(args[0])
    : CONFIG.RAW_SNAPSHOTS_DIR;

  logger.info(`=== STARTING PROTOBUF BACKFILL FROM ${targetDir} ===`);

  if (!fs.existsSync(targetDir)) {
    logger.warn(`Directory ${targetDir} does not exist. Creating directory and exiting...`);
    fs.mkdirSync(targetDir, { recursive: true });
    logger.info("Place your archived raw .pb or .protobuf files into data/raw_protobuf and re-run bun run backfill.");
    process.exit(0);
  }

  const files = fs.readdirSync(targetDir).filter(
    (file) => file.endsWith(".pb") || file.endsWith(".protobuf") || file.endsWith(".bin")
  );

  if (files.length === 0) {
    logger.info(`No protobuf snapshot files (.pb, .protobuf) found in ${targetDir}.`);
    process.exit(0);
  }

  logger.info(`Found ${files.length} snapshot files to replay.`);
  const db = new ZetDatabase();
  await db.initSchema();

  let totalObservationsProcessed = 0;
  let successFiles = 0;

  for (const file of files) {
    const filePath = path.join(targetDir, file);
    try {
      const buffer = fs.readFileSync(filePath);
      const feed = FeedMessage.decode(new Uint8Array(buffer));
      const entities = feed.entity || [];
      const headerTs = Number(feed.header?.timestamp || 0);
      const fileStat = fs.statSync(filePath);
      const fallbackTs = headerTs > 0
        ? new Date(headerTs * 1000).toISOString()
        : fileStat.mtime.toISOString();

      const observations: VehicleObservation[] = [];

      for (const entity of entities) {
        if (!entity.vehicle) continue;
        const veh = entity.vehicle;
        const pos = veh.position;
        if (!pos || pos.latitude == null || pos.longitude == null) continue;

        const vehicleId = String(veh.vehicle?.id || veh.vehicle?.label || entity.id || "").trim();
        const tripId = String(veh.trip?.tripId || "").trim();
        const routeId = String(veh.trip?.routeId || "").trim();
        const obsTsSec = Number(veh.timestamp || 0);
        const timestampIso = obsTsSec > 0
          ? new Date(obsTsSec * 1000).toISOString()
          : fallbackTs;

        observations.push({
          timestamp: timestampIso,
          vehicle_id: vehicleId,
          trip_id: tripId,
          route_id: routeId,
          latitude: Number(pos.latitude),
          longitude: Number(pos.longitude),
          bearing: pos.bearing != null ? Number(pos.bearing) : null,
          speed: pos.speed != null ? Number(pos.speed) : null,
        });
      }

      const inserted = await db.insertObservations(observations);
      totalObservationsProcessed += inserted;
      successFiles++;
      logger.info(`Backfilled file [${file}]: ${inserted} vehicle positions inserted.`);
    } catch (err) {
      logger.error(`Failed to process snapshot file ${file}`, err);
    }
  }

  logger.info(`Exporting backfilled data into Parquet partitions...`);
  await exportAccumulatedData(db, new Date());
  await db.close();

  logger.info(`=== BACKFILL COMPLETED: ${successFiles}/${files.length} files replayed, ${totalObservationsProcessed} positions imported. ===`);
}

backfill().catch((err) => {
  logger.error("Fatal error during backfill", err);
  process.exit(1);
});
