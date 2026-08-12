import { Database } from "duckdb";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config";
import { logger } from "./logger";

export interface VehicleObservation {
  timestamp: string; // ISO 8601 string, e.g. "2026-08-05T18:00:00.000Z"
  vehicle_id: string;
  trip_id: string;
  route_id: string;
  latitude: number;
  longitude: number;
  bearing: number | null;
  speed: number | null;
}

export class ZetDatabase {
  private db: Database;

  constructor(dbPath: string = CONFIG.DUCKDB_FILE) {
    const dir = path.dirname(dbPath);
    if (dbPath !== ":memory:" && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
  }

  public query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const callback = (err: Error | null, rows: T[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      };
      if (params.length > 0) {
        this.db.all(sql, ...params, callback as any);
      } else {
        this.db.all(sql, callback as any);
      }
    });
  }

  public async initSchema(): Promise<void> {
    logger.info("Initializing DuckDB schema...");
    await this.query("SET TimeZone = 'UTC';");
    await this.query(`
      CREATE TABLE IF NOT EXISTS vehicle_positions (
        timestamp TIMESTAMP,
        vehicle_id VARCHAR,
        trip_id VARCHAR,
        route_id VARCHAR,
        latitude DOUBLE,
        longitude DOUBLE,
        bearing FLOAT,
        speed FLOAT,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await this.query(`
      CREATE TABLE IF NOT EXISTS metadata (
        collection_start TIMESTAMP,
        collection_end TIMESTAMP,
        observation_count BIGINT,
        export_timestamp TIMESTAMP
      );
    `);
    logger.info("DuckDB schema initialized successfully.");
  }

  public async insertObservations(observations: VehicleObservation[]): Promise<number> {
    if (observations.length === 0) return 0;

    // Use appender or bulk insert values in chunks
    const chunkSize = 500;
    let inserted = 0;

    for (let i = 0; i < observations.length; i += chunkSize) {
      const chunk = observations.slice(i, i + chunkSize);
      const valueClauses: string[] = [];
      const params: any[] = [];

      for (const obs of chunk) {
        valueClauses.push("(?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)");
        params.push(
          obs.timestamp,
          obs.vehicle_id,
          obs.trip_id,
          obs.route_id,
          obs.latitude,
          obs.longitude,
          obs.bearing,
          obs.speed
        );
      }

      const sql = `
        INSERT INTO vehicle_positions (
          timestamp, vehicle_id, trip_id, route_id, latitude, longitude, bearing, speed, fetched_at
        ) VALUES ${valueClauses.join(", ")};
      `;

      await this.query(sql, params);
      inserted += chunk.length;
    }

    return inserted;
  }

  public async getObservationCount(): Promise<number> {
    const result = await this.query<{ cnt: bigint }>("SELECT COUNT(*) as cnt FROM vehicle_positions;");
    return Number(result[0]?.cnt || 0);
  }

  public async getDistinctPartitions(): Promise<Array<{ date_str: string; hour_str: string }>> {
    const rows = await this.query<{ date_str: string; hour_str: string }>(`
      SELECT DISTINCT
        strftime(timestamp, '%Y-%m-%d') as date_str,
        strftime(timestamp, '%H') as hour_str
      FROM vehicle_positions
      WHERE timestamp IS NOT NULL;
    `);
    return rows;
  }

  public async exportHourParquet(dateStr: string, hourStr: string, baseDataDir: string = CONFIG.DATA_DIR): Promise<number> {
    const targetDir = path.join(baseDataDir, `date=${dateStr}`, `hour=${hourStr}`);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFile = path.join(targetDir, "vehicle_positions.parquet");
    const tempFile = path.join(targetDir, `vehicle_positions.tmp_${Date.now()}.parquet`);

    // Normalize dateStr and hourStr format check
    const startWindow = `${dateStr} ${hourStr}:00:00`;
    const endWindow = `${dateStr} ${hourStr}:59:59.999`;

    // Skip rewriting existing Parquet file if DuckDB has 0 new observations for this partition window
    const dbRowsResult = await this.query<{ cnt: bigint }>(
      `SELECT COUNT(*) as cnt FROM vehicle_positions WHERE timestamp >= '${startWindow}' AND timestamp <= '${endWindow}';`
    );
    const newDbRowsCount = Number(dbRowsResult[0]?.cnt || 0);

    if (newDbRowsCount === 0 && fs.existsSync(targetFile)) {
      const verifyResult = await this.query<{ cnt: bigint }>(
        `SELECT COUNT(*) as cnt FROM read_parquet('${targetFile.replace(/'/g, "''")}');`
      );
      return Number(verifyResult[0]?.cnt || 0);
    }

    let exportQuery: string;

    if (fs.existsSync(targetFile)) {
      // Merge current DB data with existing Parquet file, deduplicating records
      // Standard deduplication: ROW_NUMBER() over (PARTITION BY timestamp, vehicle_id, trip_id)
      const existingFileEscaped = targetFile.replace(/'/g, "''");
      exportQuery = `
        COPY (
          WITH combined AS (
            SELECT
              timestamp, vehicle_id, trip_id, route_id, latitude, longitude, bearing, speed
            FROM vehicle_positions
            WHERE timestamp >= '${startWindow}' AND timestamp <= '${endWindow}'

            UNION ALL

            SELECT
              timestamp, vehicle_id, trip_id, route_id, latitude, longitude, bearing, speed
            FROM read_parquet('${existingFileEscaped}')
          ),
          deduped AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY timestamp, vehicle_id, trip_id
                ORDER BY timestamp DESC
              ) as rn
            FROM combined
          )
          SELECT
            timestamp, vehicle_id, trip_id, route_id, latitude, longitude, bearing, speed
          FROM deduped
          WHERE rn = 1
          ORDER BY timestamp ASC
        ) TO '${tempFile.replace(/'/g, "''")}' (FORMAT PARQUET, CODEC 'SNAPPY');
      `;
    } else {
      exportQuery = `
        COPY (
          WITH deduped AS (
            SELECT *,
              ROW_NUMBER() OVER (
                PARTITION BY timestamp, vehicle_id, trip_id
                ORDER BY timestamp DESC
              ) as rn
            FROM vehicle_positions
            WHERE timestamp >= '${startWindow}' AND timestamp <= '${endWindow}'
          )
          SELECT
            timestamp, vehicle_id, trip_id, route_id, latitude, longitude, bearing, speed
          FROM deduped
          WHERE rn = 1
          ORDER BY timestamp ASC
        ) TO '${tempFile.replace(/'/g, "''")}' (FORMAT PARQUET, CODEC 'SNAPPY');
      `;
    }

    await this.query(exportQuery);

    // Safe atomic replacement compatible with open handle locks
    fs.copyFileSync(tempFile, targetFile);
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Temp file cleanup optional
      }
    }

    // Verify row count in final parquet file
    const verifyResult = await this.query<{ cnt: bigint }>(
      `SELECT COUNT(*) as cnt FROM read_parquet('${targetFile.replace(/'/g, "''")}');`
    );
    const count = Number(verifyResult[0]?.cnt || 0);
    logger.info(`Exported Parquet partition date=${dateStr}/hour=${hourStr}: ${count} total rows`);
    return count;
  }

  public async recordMetadata(
    collectionStart: Date,
    collectionEnd: Date,
    observationCount: number
  ): Promise<void> {
    await this.query(
      `
      INSERT INTO metadata (collection_start, collection_end, observation_count, export_timestamp)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP);
    `,
      [collectionStart.toISOString(), collectionEnd.toISOString(), observationCount]
    );
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
