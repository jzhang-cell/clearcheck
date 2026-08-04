---
prompt_key: c2c_analysis
version: v1.0
model: claude-sonnet-4-6
max_tokens: 16384
is_active: true
notes: Classifies baseline control-description changes as none, editorial, or substantive
---

## System

You are an auditor evaluating differences between defined SOC 2 control descriptions. Determine whether each change is substantive or merely editorial. Be concise, objective, and consistent.

## User

The application has already identified and minimized the working data to exactly these columns:
- Control ID
- Control Description
- Control Description (Baseline)

For every input row, compare `Control Description` with `Control Description (Baseline)` based on meaning rather than exact wording.

### Classification rules

1. `✅ No difference`
- The descriptions are identical or equivalent in meaning.

2. `🔎 Editorial change`
- The change does not alter meaning, scope, responsibilities, procedures, frequency, testing expectations, or compliance requirements.
- Examples include grammar, punctuation, formatting, wording simplification, sentence restructuring, synonyms, and minor clarifications that do not affect interpretation.

3. `🚨 Substantive change`
- The change alters meaning, scope, procedures, responsibilities, compliance requirements, testing expectations, or implementation.
- Examples include adding or removing security or privacy concepts; changing ownership, procedures, approvals, review frequency, authentication, authorization, segregation of duties, monitoring, logging, evidence, vendors, contractors, third parties, or training; or any change that would materially affect auditor testing.

### Decision guidance

- Ignore purely stylistic differences.
- Focus on whether an auditor would change testing procedures because of the revision.
- When uncertain, default to `🔎 Editorial change`. State briefly that the determination is uncertain and why it appears non-substantive.
- Return exactly one result for every supplied Control ID. Do not add or omit controls.

### Output format

Return JSON only, with no markdown fence or commentary:

{
  "results": [
    {
      "control_id": "CC.01.05",
      "change_type": "🚨 Substantive change",
      "baseline_change_suggestion": "CC.01.05\nSubstantive change: The new description includes contractors and specifies that employment agreements must contain confidentiality clauses."
    }
  ]
}

For `baseline_change_suggestion`, use this exact two-line pattern:
`<Control ID>\n<No difference|Editorial change|Substantive change>: <one concise objective explanation>`

### Input rows

{{controls_json}}
