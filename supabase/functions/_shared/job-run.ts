import { getServiceClient } from "./supabase-client.ts";
import type { JobRunHandle } from "./types.ts";

export async function startJobRun(args: {
  function_name: string;
  trigger_source?: string;
  payload?: Record<string, unknown>;
  engagement_id?: string | null;
}): Promise<JobRunHandle> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("job_runs")
    .insert({
      function_name: args.function_name,
      trigger_source: args.trigger_source ?? "manual",
      payload: args.payload ?? {},
      engagement_id: args.engagement_id ?? null,
      status: "running",
    })
    .select("id")
    .single();

  if (error) throw new Error(`Failed to start job_run: ${error.message}`);
  return { id: data.id, started_at: Date.now() };
}

export async function completeJobRun(args: {
  handle: JobRunHandle;
  result?: Record<string, unknown>;
}): Promise<void> {
  const supabase = getServiceClient();
  const duration_ms = Date.now() - args.handle.started_at;
  const { error } = await supabase
    .from("job_runs")
    .update({
      status: "success",
      completed_at: new Date().toISOString(),
      duration_ms,
      result: args.result ?? {},
    })
    .eq("id", args.handle.id);

  // Don't throw — we already succeeded; logging the bookkeeping failure is enough.
  if (error) console.error(`completeJobRun ${args.handle.id} failed: ${error.message}`);
}

export async function failJobRun(args: {
  handle: JobRunHandle;
  error_message: string;
  error_stack?: string;
}): Promise<void> {
  const supabase = getServiceClient();
  const duration_ms = Date.now() - args.handle.started_at;
  const { error } = await supabase
    .from("job_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      duration_ms,
      error_message: args.error_message,
      error_stack: args.error_stack ?? null,
    })
    .eq("id", args.handle.id);

  // Don't throw — we're already in a failure path; would mask the original error.
  if (error) console.error(`failJobRun ${args.handle.id} failed: ${error.message}`);
}
