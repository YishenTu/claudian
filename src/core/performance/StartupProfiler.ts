/**
 * Lightweight, in-memory startup profiler.
 *
 * Records spans and counts during plugin startup without writing files or
 * emitting console output. Diagnostics are only materialized when a command
 * explicitly requests them.
 */

export interface StartupSpan {
  name: string;
  start: number;
  end?: number;
}

export interface StartupReportSpan {
  name: string;
  durationMs: number;
}

export interface StartupReport {
  moduleEvalTime: number;
  onloadStartTime: number;
  onloadEndTime?: number;
  totalDurationMs?: number;
  spans: StartupReportSpan[];
  counts: Record<string, number>;
}

interface StartupProfilerState {
  moduleEvalTime: number;
  onloadStartTime: number;
  onloadEndTime?: number;
  spans: StartupSpan[];
  counts: Record<string, number>;
  frozen: boolean;
}

const state: StartupProfilerState = {
  moduleEvalTime: 0,
  onloadStartTime: 0,
  spans: [],
  counts: {},
  frozen: false,
};

function now(): number {
  return performance.now();
}

const moduleEvaluationStartedAt = now();

function finishSpan(span: StartupSpan): void {
  if (span.end === undefined) {
    span.end = now();
  }
}

export class StartupProfiler {
  static finishModuleEvaluation(): void {
    StartupProfiler.setModuleEvalTime(now() - moduleEvaluationStartedAt);
  }

  static setModuleEvalTime(time: number): void {
    if (state.frozen) return;
    state.moduleEvalTime = time;
  }

  static startOnload(): void {
    if (state.frozen) return;
    state.onloadStartTime = now();
  }

  static finishOnload(): void {
    if (state.frozen) return;
    state.onloadEndTime = now();
  }

  static start(name: string): StartupSpan {
    if (state.frozen) {
      return { name, start: now() };
    }
    const span: StartupSpan = { name, start: now() };
    state.spans.push(span);
    return span;
  }

  static finish(span: StartupSpan): void {
    if (state.frozen) return;
    finishSpan(span);
  }

  static run<T>(name: string, fn: () => T): T {
    const span = StartupProfiler.start(name);
    try {
      return fn();
    } finally {
      StartupProfiler.finish(span);
    }
  }

  static async runAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const span = StartupProfiler.start(name);
    try {
      return await fn();
    } finally {
      StartupProfiler.finish(span);
    }
  }

  static recordCount(name: string, value: number): void {
    if (state.frozen) return;
    state.counts[name] = value;
  }

  static increment(name: string, delta = 1): void {
    if (state.frozen) return;
    state.counts[name] = (state.counts[name] ?? 0) + delta;
  }

  static freeze(): void {
    state.frozen = true;
  }

  static reset(): void {
    state.moduleEvalTime = 0;
    state.onloadStartTime = 0;
    state.onloadEndTime = undefined;
    state.spans = [];
    state.counts = {};
    state.frozen = false;
  }

  static getReport(): StartupReport {
    // Finish any unclosed spans using the current time so the report is complete.
    const spans: StartupReportSpan[] = state.spans.map((span) => ({
      name: span.name,
      durationMs: (span.end ?? now()) - span.start,
    }));

    const report: StartupReport = {
      moduleEvalTime: state.moduleEvalTime,
      onloadStartTime: state.onloadStartTime,
      onloadEndTime: state.onloadEndTime,
      spans,
      counts: { ...state.counts },
    };

    if (state.onloadEndTime !== undefined && state.onloadStartTime > 0) {
      report.totalDurationMs = state.onloadEndTime - state.onloadStartTime;
    }

    return report;
  }

  static toJSON(): string {
    return JSON.stringify(StartupProfiler.getReport(), null, 2);
  }

  static async copyToClipboard(): Promise<boolean> {
    const json = StartupProfiler.toJSON();
    try {
      await navigator.clipboard.writeText(json);
      return true;
    } catch {
      return false;
    }
  }
}
