import { execSync } from "node:child_process";
import { CONFIG } from "./config";
import { fetchAndCollect } from "./collector";
import { ZetDatabase } from "./db";
import { exportAccumulatedData } from "./exporter";
import { logger } from "./logger";

function runCommand(command: string): boolean {
  try {
    execSync(command, { stdio: "inherit" });
    return true;
  } catch (err) {
    logger.error(`Command failed: ${command}`, err);
    return false;
  }
}

export function commitAndPushData(): void {
  if (process.env.GITHUB_ACTIONS !== "true" && process.env.ENABLE_GIT_PUSH !== "true") {
    logger.info("Skipping Git commit/push (not running in GitHub Actions)");
    return;
  }

  logger.info("Executing Git commit and push for accumulated data...");
  runCommand('git config --global user.name "github-actions[bot]"');
  runCommand('git config --global user.email "github-actions[bot]@users.noreply.github.com"');

  const addSuccess = runCommand("git add data/ duckdb/");
  if (!addSuccess) {
    logger.warn("Failed to stage data/ and duckdb/");
    return;
  }

  try {
    const status = execSync("git status --porcelain").toString().trim();
    if (!status) {
      logger.info("No changes to commit.");
      return;
    }

    const timestamp = new Date().toISOString();
    const commitMsg = `data(collect): update GTFS-RT Parquet & DuckDB [${timestamp}]`;
    const commitSuccess = runCommand(`git commit -m "${commitMsg}"`);

    if (commitSuccess) {
      runCommand("git pull --rebase origin main");
      let pushSuccess = runCommand("git push origin main");
      if (!pushSuccess) {
        logger.warn("Initial git push failed. Retrying pull --rebase and push...");
        runCommand("git pull --rebase origin main");
        pushSuccess = runCommand("git push origin main");
      }
      if (pushSuccess) {
        logger.metrics.incCommit();
        logger.info("Data committed and pushed successfully.");
      } else {
        logger.error("Git push failed.");
      }
    }
  } catch (err) {
    logger.error("Error during Git status/commit/push", err);
  }
}

export function triggerWorkflowContinuation(): void {
  if (process.env.GITHUB_ACTIONS !== "true") {
    logger.info("Skipping workflow restart trigger (not in GitHub Actions)");
    return;
  }

  logger.info("Triggering workflow continuation via GitHub CLI (gh workflow run)...");
  const success = runCommand("gh workflow run collect.yml");
  if (success) {
    logger.metrics.incRestart();
    logger.info("Workflow continuation successfully dispatched.");
  } else {
    logger.error("Failed to dispatch workflow continuation via gh workflow run.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isSingleRun = args.includes("--single-run");
  const durationArgIndex = args.indexOf("--duration-ms");
  const durationValue = durationArgIndex !== -1 ? args[durationArgIndex + 1] : undefined;
  const maxDurationMs = durationValue
    ? parseInt(durationValue, 10)
    : CONFIG.WORKFLOW_MAX_RUN_TIME_MS;

  logger.info("Starting ZET GTFS-Realtime Data Collection Pipeline");
  logger.info(`Parameters: singleRun=${isSingleRun}, maxDurationMs=${maxDurationMs}ms, pollInterval=${CONFIG.POLL_INTERVAL_MS}ms`);

  const db = new ZetDatabase();
  await db.initSchema();

  const collectionStart = new Date();
  const startTime = Date.now();
  let lastExportTime = Date.now();

  if (isSingleRun) {
    logger.info("Running in single-run mode...");
    await fetchAndCollect(db);
    await exportAccumulatedData(db, collectionStart);
    await db.close();
    logger.metrics.printSummary();
    process.exit(0);
  }

  // Graceful termination handlers
  let keepRunning = true;
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}. Gracefully shutting down...`);
    keepRunning = false;
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Main collection loop
  while (keepRunning) {
    const elapsed = Date.now() - startTime;

    // Check if max execution time reached
    if (elapsed >= maxDurationMs) {
      logger.info(`Execution window limit reached (${maxDurationMs}ms). Initiating shutdown sequence...`);
      break;
    }

    // Fetch and store feed
    await fetchAndCollect(db);

    // Hourly export check
    const timeSinceLastExport = Date.now() - lastExportTime;
    if (timeSinceLastExport >= CONFIG.EXPORT_INTERVAL_MS) {
      logger.info("Hourly export window reached. Running export & commit...");
      await exportAccumulatedData(db, collectionStart);
      commitAndPushData();
      lastExportTime = Date.now();
    }

    // Wait for next polling interval
    await Bun.sleep(CONFIG.POLL_INTERVAL_MS);
  }

  // Final export, commit, and continuation trigger before exit
  logger.info("Running final Parquet export before workflow termination...");
  await exportAccumulatedData(db, collectionStart);
  commitAndPushData();
  await db.close();

  // Trigger next workflow shift only if explicitly enabled (default is schedule-driven)
  const totalElapsed = Date.now() - startTime;
  if (process.env.ENABLE_SELF_TRIGGER === "true" && totalElapsed >= maxDurationMs - CONFIG.POLL_INTERVAL_MS * 2) {
    triggerWorkflowContinuation();
  }

  logger.metrics.printSummary();
  logger.info("Pipeline runner finished cleanly.");
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error("Fatal error in main runner", err);
    process.exit(1);
  });
}
