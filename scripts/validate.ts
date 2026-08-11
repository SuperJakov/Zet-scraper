import transitRealtime from "gtfs-realtime-bindings";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "../src/config";
import { ZetDatabase } from "../src/db";
import { fetchWithRetry } from "../src/fetch";
import { logger } from "../src/logger";

const { FeedMessage } = transitRealtime.transit_realtime;

async function validate() {
  logger.info("=== STARTING PIPELINE VALIDATION CHECK ===");
  let passed = true;

  // 1. Feed reachability test
  logger.info(`Step 1: Checking feed reachability at ${CONFIG.FEED_URL}...`);
  let buffer: Uint8Array | null = null;
  try {
    const response = await fetchWithRetry(CONFIG.FEED_URL, {
      retries: CONFIG.FETCH_MAX_RETRIES,
      retryDelayMs: CONFIG.FETCH_RETRY_DELAY_MS,
      timeoutMs: CONFIG.FETCH_TIMEOUT_MS,
      headers: {
        "User-Agent": "ZET-GTFS-RT-Validator/1.0",
        Accept: "application/x-protobuf, application/octet-stream",
      },
    });
    const ab = await response.arrayBuffer();
    buffer = new Uint8Array(ab);
    logger.info(`✓ Feed reachable! Downloaded ${buffer.length} bytes.`);
  } catch (err) {
    logger.error(`✗ Feed reachability check failed after ${CONFIG.FETCH_MAX_RETRIES} attempts`, err);
    passed = false;
  }

  // 2. Protobuf decoding test
  logger.info("Step 2: Testing GTFS Protobuf decoding...");
  let entityCount = 0;
  if (buffer) {
    try {
      const feed = FeedMessage.decode(buffer);
      entityCount = feed.entity?.length || 0;
      logger.info(`✓ Protobuf decoded successfully! Found ${entityCount} entities.`);
    } catch (err) {
      logger.error("✗ Protobuf decoding failed", err);
      passed = false;
    }
  } else {
    logger.warn("Skipping Protobuf decode check due to fetch failure.");
  }

  // 3. DuckDB schema validation test
  logger.info("Step 3: Validating DuckDB schema & database initialization...");
  const tempDbFile = path.join(CONFIG.DUCKDB_DIR, `test_validate_${Date.now()}.duckdb`);
  const db = new ZetDatabase(tempDbFile);
  try {
    await db.initSchema();
    await db.insertObservations([
      {
        timestamp: new Date().toISOString(),
        vehicle_id: "VALIDATE_VEH_1",
        trip_id: "TRIP_101",
        route_id: "ROUTE_11",
        latitude: 45.815,
        longitude: 15.9819,
        bearing: 180,
        speed: 10.5,
      },
    ]);
    const count = await db.getObservationCount();
    if (count !== 1) {
      throw new Error(`Expected 1 observation in DuckDB, found ${count}`);
    }
    logger.info("✓ DuckDB schema creation & record insertion verified.");
  } catch (err) {
    logger.error("✗ DuckDB schema validation failed", err);
    passed = false;
  }

  // 4. Parquet export test
  logger.info("Step 4: Testing Parquet export & read-back...");
  try {
    const today = new Date();
    const dateStr = today.toISOString().split("T")[0] || "1970-01-01";
    const hourStr = String(today.getUTCHours()).padStart(2, "0");
    const exportedCount = await db.exportHourParquet(dateStr, hourStr);

    const parquetPath = path.join(CONFIG.DATA_DIR, `date=${dateStr}`, `hour=${hourStr}`, "vehicle_positions.parquet");
    if (!fs.existsSync(parquetPath)) {
      throw new Error(`Parquet export file missing at ${parquetPath}`);
    }
    logger.info(`✓ Parquet export verified! ${exportedCount} rows written to ${parquetPath}`);
  } catch (err) {
    logger.error("✗ Parquet export verification failed", err);
    passed = false;
  } finally {
    await db.close();
    await Bun.sleep(100);
    if (fs.existsSync(tempDbFile)) {
      try {
        fs.unlinkSync(tempDbFile);
      } catch {
        // Ignore temporary file cleanup locks on Windows
      }
    }
  }

  if (passed) {
    logger.info("=== ALL PIPELINE VALIDATION CHECKS PASSED SUCCESSFULLY ===");
    process.exit(0);
  } else {
    logger.error("=== PIPELINE VALIDATION CHECKS FAILED ===");
    process.exit(1);
  }
}

validate().catch((err) => {
  logger.error("Fatal error during validation", err);
  process.exit(1);
});
