import path from "node:path";

export const CONFIG = {
  FEED_URL: process.env.ZET_FEED_URL || "https://www.zet.hr/gtfs-rt-protobuf",
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || "15000", 10), // 15 seconds
  EXPORT_INTERVAL_MS: parseInt(process.env.EXPORT_INTERVAL_MS || "3600000", 10), // 60 minutes
  // Maximum execution time for single GitHub Actions shift (170 minutes ~ 2h 50m)
  WORKFLOW_MAX_RUN_TIME_MS: parseInt(
    process.env.WORKFLOW_MAX_RUN_TIME_MS || String(170 * 60 * 1000),
    10
  ),
  DUCKDB_DIR: path.resolve(process.cwd(), "duckdb"),
  DUCKDB_FILE: path.resolve(process.cwd(), "duckdb", "zet.duckdb"),
  DATA_DIR: path.resolve(process.cwd(), "data"),
  RAW_SNAPSHOTS_DIR: path.resolve(process.cwd(), "data", "raw_protobuf"),
};
