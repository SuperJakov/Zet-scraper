# ZET GTFS-Realtime Data Collection Pipeline

A self-sustaining, continuous data collection pipeline for Zagreb **ZET GTFS-Realtime** vehicle position data. The system runs entirely within **GitHub Actions**, storing observations in **DuckDB**, exporting Snappy-compressed **Parquet** partitions hourly, and automatically committing datasets back to the Git repository. The resulting historical dataset is designed for training Machine Learning models for ETA prediction.

---

## 🏗️ Architecture Overview

```
                        ┌──────────────────────────────────────┐
                        │ ZET GTFS-Realtime Protobuf Feed      │
                        │ https://www.zet.hr/gtfs-rt-protobuf  │
                        └──────────────────┬───────────────────┘
                                           │ (Poll every 15s)
                                           ▼
                        ┌──────────────────────────────────────┐
                        │ Bun Runtime + GTFS Decoder           │
                        │ (gtfs-realtime-bindings)             │
                        └──────────────────┬───────────────────┘
                                           │ Batch Insert
                                           ▼
                        ┌──────────────────────────────────────┐
                        │ Local DuckDB Store                   │
                        │ (duckdb/zet.duckdb)                  │
                        └──────────────────┬───────────────────┘
                                           │ Hourly Export & Dedup
                                           ▼
                        ┌──────────────────────────────────────┐
                        │ Partitioned Snappy Parquet Datasets  │
                        │ data/date=YYYY-MM-DD/hour=HH/*.parquet│
                        └──────────────────┬───────────────────┘
                                           │ Git Commit & Push
                                           ▼
                        ┌──────────────────────────────────────┐
                        │ GitHub Repository / Storage          │
                        │ (Continuous Continuation Shifts)     │
                        └──────────────────────────────────────┘
```

1. **Shift Orchestration**: Runs continuous ~3-hour collector shifts in GitHub Actions.
2. **High-Frequency Polling**: Polls the feed every 15 seconds, extracts position records (`timestamp`, `vehicle_id`, `trip_id`, `route_id`, `latitude`, `longitude`, `bearing`, `speed`), and inserts them into DuckDB.
3. **Idempotent Partitioning**: Every 60 minutes, exports accumulated records into Hive-partitioned Snappy-compressed Parquet files: `data/date=YYYY-MM-DD/hour=HH/vehicle_positions.parquet`. Atomic replacement and record deduplication guarantee append safety.
4. **Auto-Continuation**: Near the end of each ~3-hour execution shift, the runner automatically dispatches the next workflow run via `gh workflow run collect.yml`.
5. **Concurrency Protection**: Uses `concurrency: group: zet-collector, cancel-in-progress: false` to ensure exactly one collector runs at any time without parallel duplicate workers.

---

## 📊 Dataset Schema Documentation

### `vehicle_positions` Partition Schema

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `timestamp` | `TIMESTAMP` | Vehicle position observation time (ISO 8601 / UTC timestamp) |
| `vehicle_id` | `VARCHAR` | Unique vehicle identifier or fleet label |
| `trip_id` | `VARCHAR` | GTFS trip identifier assigned to the current vehicle block |
| `route_id` | `VARCHAR` | GTFS route identifier (tram or bus line ID) |
| `latitude` | `DOUBLE` | Vehicle latitude coordinate (WGS84) |
| `longitude` | `DOUBLE` | Vehicle longitude coordinate (WGS84) |
| `bearing` | `FLOAT` | Compass heading angle in degrees (0-360, nullable) |
| `speed` | `FLOAT` | Current vehicle speed in meters/second (nullable) |

### `metadata` Schema

| Field Name | Type | Description |
| :--- | :--- | :--- |
| `collection_start` | `TIMESTAMP` | ISO timestamp marking start of collection shift |
| `collection_end` | `TIMESTAMP` | ISO timestamp marking end of collection shift |
| `observation_count` | `BIGINT` | Total observations stored in DuckDB database |
| `export_timestamp` | `TIMESTAMP` | Time when Parquet export was performed |

---

## 📈 Storage Growth Estimates & Cost Considerations

### Storage Growth
- **Polling Rate**: Every 15 seconds (4 updates/minute = 240 updates/hour/vehicle).
- **Active Fleet**: ~200 - 300 active ZET vehicles (trams & buses) during peak hours.
- **Uncompressed Row Size**: ~100 bytes/observation (~57,600 - 72,000 observations/hour).
- **Parquet Compression Ratio**: ~70-80% compression with Snappy.
- **Hourly Parquet Size**: ~1.5 MB – 3.0 MB per hour.
- **Daily Storage**: ~35 MB – 70 MB per day.
- **Monthly Dataset Accumulation**: **~1.0 GB – 2.1 GB per month**.

### Cost Considerations
- **GitHub Actions Usage**: GitHub public repositories provide unlimited free Actions minutes. For private repositories, free accounts include 2,000 minutes/month. Running 24/7 requires ~43,200 minutes/month.
- **Git Repository Size**: Storing raw data in Git keeps repository footprint modest when compressed as Parquet.

---

## ⏯️ Instructions for Controlling Collection

### How to Stop Collection
To halt the continuous collection loop:
1. Go to the GitHub repository **Actions** tab.
2. Select **ZET GTFS-Realtime Data Collector**.
3. Cancel any currently running workflow run.
4. Disable the workflow to prevent scheduled triggers:
   ```bash
   gh workflow disable collect.yml
   ```

### How to Resume Collection
To restart or resume continuous collection:
1. Re-enable the workflow:
   ```bash
   gh workflow enable collect.yml
   ```
2. Manually trigger the first run via GitHub CLI or UI:
   ```bash
   gh workflow run collect.yml
   ```
   *The workflow will run for 3 hours, commit data, and automatically chain to the next shift.*

---

## 🛠️ CLI Utilities & Commands

- **System Validation**:
  ```bash
  bun run validate
  ```
  *Tests feed reachability, protobuf decoding, DuckDB schema, and Parquet export.*

- **Manual Data Export**:
  ```bash
  bun run export
  ```
  *Exports all accumulated DuckDB observations to Parquet partitions under `data/`.*

- **Protobuf Snapshot Backfill**:
  ```bash
  bun run backfill [path/to/raw_protobuf_dir]
  ```
  *Replays archived raw GTFS `.pb` binary files into DuckDB and updates Parquet datasets.*

- **Type Checking**:
  ```bash
  bun run check
  ```

- **Local Pipeline Execution**:
  ```bash
  bun run start
  ```
