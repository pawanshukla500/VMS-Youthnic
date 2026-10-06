// Lightweight process monitor: event-loop delay + memory, sampled once a
// minute (no work in between), one warning line when a threshold is crossed
// (at most every 10 minutes per kind) so lag / leaks show up in the logs.
import { monitorEventLoopDelay } from 'perf_hooks';

export interface ProcessHealth {
  uptimeSeconds: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  // Worst values seen since start (spikes between samples).
  peakRssMb: number;
  peakEventLoopP99Ms: number;
  sampledAt: string | null;
}

export interface MonitorThresholds {
  eventLoopP99Ms: number;
  rssMb: number;
}

const DEFAULT_THRESHOLDS: MonitorThresholds = { eventLoopP99Ms: 200, rssMb: 450 };
const WARN_EVERY_MS = 10 * 60_000;

let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let timer: NodeJS.Timeout | null = null;
const lastWarnAt: Record<string, number> = {};
let latest: ProcessHealth = {
  uptimeSeconds: 0, rssMb: 0, heapUsedMb: 0, heapTotalMb: 0, externalMb: 0,
  eventLoopP99Ms: 0, eventLoopMaxMs: 0, peakRssMb: 0, peakEventLoopP99Ms: 0, sampledAt: null,
};

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;

export function sampleProcessHealth(): ProcessHealth {
  const mem = process.memoryUsage();
  const p99 = histogram ? ms(histogram.percentile(99)) : 0;
  const max = histogram ? ms(histogram.max) : 0;
  histogram?.reset();
  const rssMb = mb(mem.rss);
  latest = {
    uptimeSeconds: Math.round(process.uptime()),
    rssMb,
    heapUsedMb: mb(mem.heapUsed),
    heapTotalMb: mb(mem.heapTotal),
    externalMb: mb(mem.external),
    eventLoopP99Ms: p99,
    eventLoopMaxMs: max,
    peakRssMb: Math.max(latest.peakRssMb, rssMb),
    peakEventLoopP99Ms: Math.max(latest.peakEventLoopP99Ms, p99),
    sampledAt: new Date().toISOString(),
  };
  return latest;
}

export function processHealthWarnings(health: ProcessHealth, thresholds: MonitorThresholds = DEFAULT_THRESHOLDS): string[] {
  const warnings: string[] = [];
  if (health.eventLoopP99Ms > thresholds.eventLoopP99Ms) {
    warnings.push(`event loop p99 ${health.eventLoopP99Ms} ms (max ${health.eventLoopMaxMs} ms) over ${thresholds.eventLoopP99Ms} ms`);
  }
  if (health.rssMb > thresholds.rssMb) {
    warnings.push(`memory rss ${health.rssMb} MB (heap ${health.heapUsedMb}/${health.heapTotalMb} MB) over ${thresholds.rssMb} MB`);
  }
  return warnings;
}

export function startProcessMonitor(thresholds: MonitorThresholds = DEFAULT_THRESHOLDS, intervalMs = 60_000): void {
  if (timer) return;
  histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  timer = setInterval(() => {
    const health = sampleProcessHealth();
    for (const warning of processHealthWarnings(health, thresholds)) {
      const kind = warning.split(' ')[0];
      if (Date.now() - (lastWarnAt[kind] || 0) < WARN_EVERY_MS) continue;
      lastWarnAt[kind] = Date.now();
      console.warn(`[monitor] ${warning}`);
    }
  }, intervalMs);
  // Never keeps the process alive on shutdown.
  timer.unref();
}

export function getProcessHealth(): ProcessHealth {
  return latest.sampledAt ? latest : sampleProcessHealth();
}

export function stopProcessMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  histogram?.disable();
  histogram = null;
}
