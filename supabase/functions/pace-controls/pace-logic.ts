// Pure pacing logic for pace-controls — kept separate from index.ts so it can be
// unit-tested without importing index.ts (whose top-level Deno.serve() would
// start a server). See pace.test.ts.

import type { AirtableRecord } from "../_shared/airtable.ts";

export interface WavePlan {
  total: number; // all controls
  alreadyLaunched: number; // run field already truthy
  remaining: number; // not yet launched
  toLaunchIds: string[]; // controls to tick THIS cycle
  done: boolean; // nothing left to launch
}

// A control is "launched" iff its run field is truthy (the per-control script
// never clears it). effectiveInFlight = max(actual running jobs, pending) so that
// once a prior wave's jobs are visible the actual count drives, but while they
// lag (Airtable automation latency) `pending` holds the line and we don't
// overshoot the cap. Slots clamp to ≥ 0 so a huge inflight (the job_runs
// read-error fallback) launches nothing rather than going negative.
//
// The cap is TWO-LEVEL because the pooler is shared across engagements:
//   - global: this engagement's slots = maxConcurrent − (othersInflight + own),
//     so two engagements can never sum past the pooler-safe ceiling (ADR-014).
//   - fair share: ceil(maxConcurrent / activeEngagements) per engagement, so one
//     engagement's long run can't hog every slot and starve a newcomer.
// Whichever is smaller binds. othersInflight/activeEngagements default to the
// single-engagement case (0 / 1), where both levels collapse to the old formula.
export function planWave(args: {
  records: AirtableRecord[];
  runField: string;
  maxConcurrent: number;
  inflight: number; // this engagement's running jobs
  pending: number;
  othersInflight?: number; // other engagements' running jobs (default 0)
  activeEngagements?: number; // engagements with in-flight work, incl. this one (default 1)
}): WavePlan {
  const remaining = args.records.filter((r) => !r.fields[args.runField]);
  const total = args.records.length;
  const alreadyLaunched = total - remaining.length;
  if (remaining.length === 0) {
    return { total, alreadyLaunched, remaining: 0, toLaunchIds: [], done: true };
  }
  const othersInflight = Math.max(0, args.othersInflight ?? 0);
  const activeEngagements = Math.max(1, args.activeEngagements ?? 1);
  const fairShare = Math.max(1, Math.ceil(args.maxConcurrent / activeEngagements));
  const effectiveOwn = Math.max(args.inflight, args.pending);
  const globalSlots = args.maxConcurrent - (othersInflight + effectiveOwn);
  const shareSlots = fairShare - effectiveOwn;
  const slots = Math.max(0, Math.min(globalSlots, shareSlots));
  const toLaunchIds = remaining.slice(0, slots).map((r) => r.id);
  return { total, alreadyLaunched, remaining: remaining.length, toLaunchIds, done: false };
}
