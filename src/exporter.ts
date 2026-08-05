import { ZetDatabase } from "./db";
import { logger } from "./logger";

export async function exportAccumulatedData(
  db: ZetDatabase,
  collectionStart: Date
): Promise<{ partitionsExported: number; totalRowsExported: number }> {
  logger.info("Starting hourly export of accumulated observations...");
  const partitions = await db.getDistinctPartitions();
  let totalRows = 0;
  let partitionsCount = 0;

  for (const { date_str, hour_str } of partitions) {
    try {
      const rows = await db.exportHourParquet(date_str, hour_str);
      totalRows += rows;
      partitionsCount++;
    } catch (err) {
      logger.error(`Failed to export partition date=${date_str}/hour=${hour_str}`, err);
    }
  }

  const now = new Date();
  const dbObservationCount = await db.getObservationCount();
  await db.recordMetadata(collectionStart, now, dbObservationCount);

  logger.metrics.incExport(totalRows);
  logger.info(`Export completed. ${partitionsCount} partitions exported, ${totalRows} total rows written.`);

  return { partitionsExported: partitionsCount, totalRowsExported: totalRows };
}
