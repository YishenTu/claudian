/**
 * Claudian - Title Generation System Prompt
 *
 * System prompt for generating conversation titles.
 */

/** System prompt for AI-powered conversation title generation. */
export const TITLE_GENERATION_SYSTEM_PROMPT = `You generate concise conversation titles.

Given the user's first message and the AI's first response, generate a short title (max 50 characters) that captures the essence of the conversation.

Guidelines:
- Be specific about the topic, not generic
- Use sentence case (capitalize first word only, unless proper nouns)
- Don't use quotes or punctuation at the end
- Focus on what the user is trying to accomplish
- If code-related, mention the language/framework

Output ONLY the title text, nothing else. No quotes, no explanation.`;
