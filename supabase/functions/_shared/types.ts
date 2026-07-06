export interface ActivePrompt {
  prompt_id: string;
  prompt_key: string;
  version: string;
  model: string;
  system_prompt: string | null;
  user_prompt_template: string;
  max_tokens: number;
}

export interface ClaudeCallResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
}

export interface JobRunHandle {
  id: string;
  started_at: number;
}
