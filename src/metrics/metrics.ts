// Lightweight metrics collection emitting real Prometheus text exposition
// format, without requiring `prom-client` to be installed. Swap in
// `prom-client`'s Registry/Counter/Histogram (already a package.json
// dependency) for a production build if you want native
// buckets/quantiles/push-gateway support — the /metrics route in
// src/api/server.ts only depends on getting a text/plain body back, so
// that's a one-file change.

interface LabeledCount {
  labels: Record<string, string>;
  count: number;
}

class Counter {
  constructor(private name: string, private help: string) {}
  private counts = new Map<string, LabeledCount>();

  inc(labels: Record<string, string> = {}) {
    const key = JSON.stringify(labels);
    const existing = this.counts.get(key);
    if (existing) existing.count++;
    else this.counts.set(key, { labels, count: 1 });
  }

  total(): number {
    let sum = 0;
    for (const { count } of this.counts.values()) sum += count;
    return sum;
  }

  /** Sums counts across all label sets that share a given label value, e.g. breakdown("status"). */
  byLabel(labelKey: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const { labels, count } of this.counts.values()) {
      const value = labels[labelKey];
      if (value === undefined) continue;
      out[value] = (out[value] ?? 0) + count;
    }
    return out;
  }

  toPrometheusText(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.counts.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const { labels, count } of this.counts.values()) {
        lines.push(`${this.name}${formatLabels(labels)} ${count}`);
      }
    }
    return lines.join("\n");
  }
}

class Histogram {
  constructor(private name: string, private help: string) {}
  private samples: number[] = [];

  observe(value: number) {
    this.samples.push(value);
  }

  private percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  }

  count(): number {
    return this.samples.length;
  }

  snapshot(): { p50: number; p90: number; p95: number; p99: number; count: number } {
    return {
      p50: Number(this.percentile(0.5).toFixed(3)),
      p90: Number(this.percentile(0.9).toFixed(3)),
      p95: Number(this.percentile(0.95).toFixed(3)),
      p99: Number(this.percentile(0.99).toFixed(3)),
      count: this.count(),
    };
  }

  toPrometheusText(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} summary`];
    for (const q of [0.5, 0.9, 0.95, 0.99]) {
      lines.push(`${this.name}{quantile="${q}"} ${this.percentile(q).toFixed(4)}`);
    }
    lines.push(`${this.name}_count ${this.samples.length}`);
    return lines.join("\n");
  }
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return "{" + entries.map(([k, v]) => `${k}="${v}"`).join(",") + "}";
}

export const metrics = {
  reservationsAccepted: new Counter("reservations_accepted_total", "Total accepted inventory reservations"),
  reservationsRejected: new Counter("reservations_rejected_total", "Total rejected inventory reservations (insufficient stock)"),
  sagaOutcomes: new Counter("saga_outcomes_total", "Order saga outcomes by final status"),
  reservationLatency: new Histogram("reservation_latency_ms", "Latency of InventoryService.reserve() calls, in milliseconds"),
};

export function metricsSnapshotText(): string {
  return [
    metrics.reservationsAccepted.toPrometheusText(),
    metrics.reservationsRejected.toPrometheusText(),
    metrics.sagaOutcomes.toPrometheusText(),
    metrics.reservationLatency.toPrometheusText(),
  ].join("\n\n") + "\n";
}

/**
 * JSON-shaped version of the same counters, for the dashboard's KPI cards —
 * the Prometheus text above stays the wire format for real scrapers, this is
 * just a friendlier read for a browser fetch().
 */
export function metricsSnapshotJson() {
  const outcomes = metrics.sagaOutcomes.byLabel("status");
  return {
    reservationsAccepted: metrics.reservationsAccepted.total(),
    reservationsRejected: metrics.reservationsRejected.total(),
    sagaOutcomes: outcomes, // e.g. { CONFIRMED: 12, CANCELLED: 3 }
    reservationLatencyMs: metrics.reservationLatency.snapshot(),
  };
}
