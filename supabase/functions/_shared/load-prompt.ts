import { getServiceClient } from "./supabase-client.ts";
import type { ActivePrompt } from "./types.ts";

export async function loadActivePrompt(promptKey: string): Promise<ActivePrompt> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("prompts")
    .select("id, prompt_key, version, model, system_prompt, user_prompt_template, max_tokens")
    .eq("prompt_key", promptKey)
    .eq("is_active", true)
    .single();

  if (error) throw new Error(`Failed to load prompt '${promptKey}': ${error.message}`);
  if (!data) throw new Error(`No active prompt found for key '${promptKey}'`);

  return {
    prompt_id: data.id,
    prompt_key: data.prompt_key,
    version: data.version,
    model: data.model,
    system_prompt: data.system_prompt,
    user_prompt_template: data.user_prompt_template,
    max_tokens: data.max_tokens,
  };
}
