import { Router } from "express";
import { metricsSnapshotJson } from "../../metrics/metrics.js";

/**
 * JSON metrics for the dashboard's KPI cards. The Prometheus text format at
 * GET /metrics (see server.ts) stays the real scrape endpoint; this is a
 * browser-friendly read of the same counters.
 */
export function metricsRouter(): Router {
  const router = Router();

  router.get("/metrics/summary", (_req, res) => {
    res.json(metricsSnapshotJson());
  });

  return router;
}
