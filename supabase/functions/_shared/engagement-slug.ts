// engagement_id → Storage-path slug (the per-client folder under the `evidence`
// bucket: evidence/{slug}/{control_id}/{filename}).
//
// Known engagements get a readable slug; any other engagement falls back to its
// UUID. This is zero-config for new clients (no code change needed to onboard
// one) and never throws. To give a new client a readable folder instead of its
// UUID, add a line to SLUG_MAP. A future migration may move this onto an
// `engagements.slug` column (see ADR-012).
const SLUG_MAP: Record<string, string> = {
  "11111111-1111-1111-1111-111111111111": "ecton",
};

export function engagementSlug(engagementId: string): string {
  return SLUG_MAP[engagementId] ?? engagementId;
}
