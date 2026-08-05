import transitRealtime from "gtfs-realtime-bindings";
import { CONFIG } from "./config";
import { ZetDatabase, type VehicleObservation } from "./db";
import { logger } from "./logger";

const { FeedMessage } = transitRealtime.transit_realtime;

export interface FetchResult {
  success: boolean;
  entityCount: number;
  insertedCount: number;
  error?: string;
}

export async function fetchAndCollect(db: ZetDatabase): Promise<FetchResult> {
  const fetchTime = new Date();
  try {
    const response = await fetch(CONFIG.FEED_URL, {
      headers: {
        "User-Agent": "ZET-GTFS-RT-Collector/1.0",
        Accept: "application/x-protobuf, application/octet-stream",
      },
      signal: AbortSignal.timeout(10000), // 10s fetch timeout
    });

    if (!response.ok) {
      const errMessage = `HTTP status ${response.status} ${response.statusText}`;
      logger.error(`Failed to fetch GTFS feed: ${errMessage}`);
      logger.metrics.incFeedFailure();
      return { success: false, entityCount: 0, insertedCount: 0, error: errMessage };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);

    if (buffer.length === 0) {
      logger.warn("Received empty GTFS feed buffer");
      logger.metrics.incFeedFailure();
      return { success: false, entityCount: 0, insertedCount: 0, error: "Empty buffer" };
    }

    const feed = FeedMessage.decode(buffer);
    const entities = feed.entity || [];
    const headerTimestampSec = Number(feed.header?.timestamp || 0);
    const defaultTimestamp = headerTimestampSec > 0
      ? new Date(headerTimestampSec * 1000).toISOString()
      : fetchTime.toISOString();

    const observations: VehicleObservation[] = [];

    for (const entity of entities) {
      if (!entity.vehicle) continue;

      const vehicle = entity.vehicle;
      const pos = vehicle.position;
      if (!pos || pos.latitude == null || pos.longitude == null) continue;

      const vehicleId = String(vehicle.vehicle?.id || vehicle.vehicle?.label || entity.id || "").trim();
      const tripId = String(vehicle.trip?.tripId || "").trim();
      const routeId = String(vehicle.trip?.routeId || "").trim();

      const obsTimestampSec = Number(vehicle.timestamp || 0);
      const timestampIso = obsTimestampSec > 0
        ? new Date(obsTimestampSec * 1000).toISOString()
        : defaultTimestamp;

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
    logger.metrics.incFeedSuccess(entities.length);
    logger.info(`Feed fetched successfully: ${entities.length} entities, ${observations.length} vehicle positions inserted`);

    return {
      success: true,
      entityCount: entities.length,
      insertedCount: inserted,
    };
  } catch (error) {
    logger.error("Error during GTFS feed fetch/parse", error);
    logger.metrics.incFeedFailure();
    return {
      success: false,
      entityCount: 0,
      insertedCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
