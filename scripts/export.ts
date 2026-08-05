import { ZetDatabase } from "../src/db";
import { exportAccumulatedData } from "../src/exporter";
import { logger } from "../src/logger";

async function runExportScript() {
  logger.info("=== STARTING FULL DATASET PARQUET EXPORT ===");
  const db = new ZetDatabase();
  await db.initSchema();

  const startTime = new Date();
  const result = await exportAccumulatedData(db, startTime);

  await db.close();
  logger.info(`=== EXPORT COMPLETE: ${result.partitionsExported} partitions, ${result.totalRowsExported} total rows exported ===`);
}

runExportScript().catch((err) => {
  logger.error("Fatal error during export script execution", err);
  process.exit(1);
});
