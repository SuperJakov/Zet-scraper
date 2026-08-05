export interface PipelineMetrics {
  feedFetchSuccess: number;
  feedFetchFailure: number;
  entityCountTotal: number;
  exportCountTotal: number;
  commitCountTotal: number;
  workflowRestartCount: number;
}

const metrics: PipelineMetrics = {
  feedFetchSuccess: 0,
  feedFetchFailure: 0,
  entityCountTotal: 0,
  exportCountTotal: 0,
  commitCountTotal: 0,
  workflowRestartCount: 0,
};

function formatTimestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(message: string, meta?: Record<string, any>) {
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : "";
    console.log(`[${formatTimestamp()}] [INFO] ${message}${metaStr}`);
  },
  warn(message: string, meta?: Record<string, any>) {
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : "";
    console.warn(`[${formatTimestamp()}] [WARN] ${message}${metaStr}`);
  },
  error(message: string, error?: unknown, meta?: Record<string, any>) {
    const errStr = error instanceof Error ? `${error.message}\n${error.stack}` : String(error || "");
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : "";
    console.error(`[${formatTimestamp()}] [ERROR] ${message} ${errStr}${metaStr}`);
  },
  metrics: {
    incFeedSuccess(entities: number) {
      metrics.feedFetchSuccess++;
      metrics.entityCountTotal += entities;
    },
    incFeedFailure() {
      metrics.feedFetchFailure++;
    },
    incExport(exportedRows: number) {
      metrics.exportCountTotal += exportedRows;
    },
    incCommit() {
      metrics.commitCountTotal++;
    },
    incRestart() {
      metrics.workflowRestartCount++;
    },
    get(): Readonly<PipelineMetrics> {
      return { ...metrics };
    },
    printSummary() {
      console.log(`\n================ PIPELINE METRICS SUMMARY ================`);
      console.log(`Feed Fetch Successes  : ${metrics.feedFetchSuccess}`);
      console.log(`Feed Fetch Failures   : ${metrics.feedFetchFailure}`);
      console.log(`Total Entities Processed: ${metrics.entityCountTotal}`);
      console.log(`Total Exported Rows   : ${metrics.exportCountTotal}`);
      console.log(`Total Git Commits     : ${metrics.commitCountTotal}`);
      console.log(`Workflow Restarts     : ${metrics.workflowRestartCount}`);
      console.log(`==========================================================\n`);
    },
  },
};
