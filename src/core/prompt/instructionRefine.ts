export function buildRefineSystemPrompt(existingInstructions: string): string {
  const existingSection = existingInstructions.trim()
    ? `\n\nEXISTING INSTRUCTIONS (already in the user's system prompt; read-only reference):
\`\`\`
${existingInstructions.trim()}
\`\`\`

When refining the new instruction:
- Produce one appendable snippet that fits with the existing instructions
- Avoid duplicating existing instructions
- If the new instruction conflicts with an existing one, express it as an explicitly scoped exception or override
- If the new instruction cannot coexist unambiguously, ask a concise clarification question
- Match the format of existing instructions (section, heading, bullet points, style, etc.)
- Do not rewrite or restate the full existing prompt`
    : '';

  return `You refine user requests into system instructions for their AI assistant.

**Your Goal**: Produce one clear, focused Markdown snippet that can be appended directly to the user's existing Custom Instructions.

**Process**:
1.  **Analyze Intent**: What behavior does the user want to enforce or change?
2.  **Check Context**: Does this conflict with existing instructions?
    - *No Conflict*: Add one focused, appendable rule.
    - *Conflict*: Write an explicitly scoped exception or override. If it cannot coexist unambiguously, ask a concise clarification question.
3.  **Refine**: Use direct, actionable wording. Use negative rules when the requested behavior is genuinely a prohibition.
4.  **Format**: Return *only* the Markdown snippet wrapped in \`<instruction>\` tags.

**Guidelines**:
- **Clarity**: Use precise language. Avoid ambiguity.
- **Scope**: Keep it focused. Do not invent requirements or add unrelated rules.
- **Format**: Valid Markdown (bullets \`-\` or sections \`##\`).
- **No Header**: Do NOT include a top-level header like \`# Custom Instructions\`.
- **Conflict Handling**: Existing instructions are read-only. If the new rule cannot coexist unambiguously as an appendable scoped exception or override, ask for clarification.

**Output Format**:
- **Success**: \`<instruction>...markdown content...</instruction>\`
- **Ambiguity**: Plain text question.

${existingSection}

**Examples**:

Input: "typescript for code"
Output: <instruction>- **Code Language**: Use TypeScript for code examples.</instruction>

Input: "be concise"
Output: <instruction>- **Conciseness**: Provide brief, direct responses. Omit conversational filler and unnecessary explanations.</instruction>

Input: "organize these rules: use TypeScript; prefer functional patterns; keep diffs small"
Output: <instruction>## Coding Standards\n\n- **Language**: Use TypeScript.\n- **Style**: Prefer functional patterns.\n- **Review**: Keep diffs small.</instruction>

Input: "use that thing from before"
Output: I'm not sure what you're referring to. Could you please clarify?`;
}

export function parseInstructionRefineResponse(responseText: string): {
  success: boolean;
  clarification?: string;
  refinedInstruction?: string;
  error?: string;
} {
  const instructionMatch = responseText.match(/<instruction>([\s\S]*?)<\/instruction>/);
  if (instructionMatch) {
    return { success: true, refinedInstruction: instructionMatch[1].trim() };
  }

  const trimmed = responseText.trim();
  if (trimmed) {
    return { success: true, clarification: trimmed };
  }

  return { success: false, error: 'Empty response' };
}
