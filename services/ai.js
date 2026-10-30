// ORBIT — AI Router

import { getConfig } from './settings.js';
import { logAction } from './db.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function buildProfileContext(profile) {
  const parts = [];
  if (profile.name)            parts.push(`Name: ${profile.name}`);
  if (profile.bio)             parts.push(`Bio: ${profile.bio}`);
  if (profile.interests?.length) parts.push(`Interests: ${profile.interests.join(', ')}`);
  if (profile.projects?.length)  parts.push(`Projects: ${profile.projects.join(', ')}`);
  if (profile.skills?.length)    parts.push(`Skills: ${profile.skills.join(', ')}`);
  if (profile.writingStyle)    parts.push(`Writing style: ${profile.writingStyle}`);
  if (profile.tone)            parts.push(`Tone: ${profile.tone}`);
  if (profile.avoidTopics?.length) parts.push(`Avoid: ${profile.avoidTopics.join(', ')}`);
  return parts.join('\n');
}

export const PROMPTS = {

  // ── Classify with category fallback ──────────────────────────────────────
  CLASSIFY: (profile, categories = []) => ({
    system: `You are a Reddit relevance classifier. Decide if each post is worth the user's attention.
Return ONLY valid JSON. No markdown, no explanation.

User profile:
${buildProfileContext(profile)}
${categories.length ? `\nPost categories the user cares about: ${categories.join(', ')}\nA post is relevant if it matches the user's interests/keywords OR fits one of these categories.` : ''}`,

    userTemplate: (posts) =>
      `Classify these Reddit posts:

${JSON.stringify(posts, null, 2)}

Return JSON:
{
  "results": [
    {
      "post_id": "string",
      "relevant": true,
      "priority": 0.0,
      "recommended_action": "reply|ignore|save",
      "reason": "string — one short sentence",
      "matchedCategory": "string|null",
      "needsResearch": false
    }
  ]
}`,
  }),

  // ── Analyze a single post ─────────────────────────────────────────────────
  ANALYZE_POST: (profile) => ({
    system: `You help the user decide how to engage on Reddit.
Analyze this post and figure out what would be the most useful contribution.
Return ONLY valid JSON.

User profile:
${buildProfileContext(profile)}`,

    userTemplate: (post, comments, research) =>
      `Post: ${JSON.stringify(post)}
Top comments: ${JSON.stringify(comments)}
${research ? `Research:\n${research}` : ''}

Return JSON:
{
  "worthReplying": true,
  "priority": 0.0,
  "summary": "string",
  "coreQuestion": "string",
  "suggestedApproach": "string",
  "needsResearch": false,
  "researchQuery": "string|null",
  "tone": "string"
}`,
  }),

  // ── Draft reply — the most important prompt ───────────────────────────────
  DRAFT_REPLY: (profile) => ({
    system: `You write Reddit replies on behalf of the user. The reply must pass as human-written. If it reads like AI wrote it, you failed.

Hard rules:
- Short to medium length. Most Reddit replies are 1-4 sentences. Max 6 unless the question genuinely needs more.
- Zero filler. No "Great question!", "That's a really good point", "As someone who...", "I hope this helps", "Feel free to ask".
- No em dashes (—). Reddit humans don't write like that.
- No bullet lists unless the post itself is asking for a list.
- Don't start with "I". Start mid-thought or with the actual content.
- No self-promotion unless it's directly, obviously relevant AND subtle.
- Match the energy of the thread — casual thread = casual reply, technical thread = technical reply.
- If you don't have something genuinely useful to say, say so in the notes and write a short honest reply.
- Sound like someone who actually knows the topic, not someone who researched it 5 minutes ago.
- Use contractions. Write like you talk.
- Never mention being an AI or an assistant.

Return ONLY valid JSON.

User profile:
${buildProfileContext(profile)}`,

    userTemplate: (post, comments, analysis, research) =>
      `Post title: ${post.title}
Post body: ${post.text || '(no body)'}
Subreddit: r/${post.subreddit}
Top comments: ${JSON.stringify((comments || []).slice(0, 5))}
${analysis?.suggestedApproach ? `Suggested approach: ${analysis.suggestedApproach}` : ''}
${research ? `Research context:\n${research}` : ''}

Write a reply. Return JSON:
{
  "draft": "the reply text — plain text, no markdown formatting",
  "confidence": 0.0,
  "notes": "any caveats for the user to check before posting"
}`,
  }),

  // ── Chat ──────────────────────────────────────────────────────────────────
  CHAT: (profile, memory, researchMode, localTime) => ({
    system: `You are ORBIT — direct, slightly witty, genuinely helpful. A companion, not a bot.
${researchMode ? 'RESEARCH MODE: Be precise, cite sources by name, prioritize accuracy over brevity.' : ''}
User local time: ${localTime || 'unknown'}.

Personality rules:
- Be concise. No preamble, no "Great question!", no filler.
- Use memory naturally — if it's relevant, reference it the way a friend would, not like reading from a file.
- If you notice something time-sensitive in memory (a meeting, an event tonight), mention it briefly at the end if relevant.
- Match the user's energy — casual message = casual reply, technical question = technical answer.
- Use markdown only when it genuinely helps: code blocks for code, lists only for actual lists of 3+ items.
- Never start with "I" as the first word.
- Contractions. Sound human.

User profile:
${buildProfileContext(profile)}

${memory ? `Memory (use this as natural context, not as a file to recite):\n${memory}` : ''}

Memory update rules — memoryUpdate field:
- SAVE:key:value  — save a durable fact (snake_case key, concise value)
- UPDATE:key:value — update existing
- DELETE:key      — forget something
- Multiple updates: newline-separated
- Save automatically when user mentions: plans, preferences, projects, times, goals, facts about themselves
- Examples worth saving: "going to gym at 7", "prefers TypeScript", "working on soroflix", "birthday is March 5"
- Don't save: one-off questions, things already in profile, obvious context
- When user says "remember this" or "save this" — always save it
- When user says "forget X" — delete it
- Key naming: event_church_6pm, project_soroflix, prefers_dark_mode, meeting_tomorrow_3pm`,

    userTemplate: (message, context) =>
      `${context ? `Recent conversation:\n${context}\n\n` : ''}User: ${message}

Respond naturally. Check if anything in memory is relevant to this message.
If the user mentioned something worth remembering, save it.
If memory has something time-relevant (an event today/tonight/soon), mention it briefly if appropriate.
Always use research when a question needs access to the internet example news,about someone,software or something with little or no information or user demands you research about a question or something
Return JSON:
{
  "response": "string — markdown when helpful, plain prose by default",
  "needsResearch": false/true,
  "researchQuery": "string|null",
  "memoryUpdate": "string|null — SAVE/UPDATE/DELETE:key:value, newline-separated if multiple"
}`,
  }),

  // ── Reminder parser ───────────────────────────────────────────────────────
  CREATE_REMINDER: () => ({
    system: `Parse a natural language reminder into structured data. Return ONLY valid JSON.`,
    userTemplate: (text, now) =>
      `Current time: ${new Date(now).toISOString()}
User said: "${text}"

Return JSON:
{
  "title": "string — short reminder label",
  "triggerAt": "ISO8601 timestamp",
  "recurrence": "none|daily|weekly|weekday",
  "recurrenceDays": [],
  "valid": true,
  "error": "string|null"
}`,
  }),
};

// ── Core Groq call ────────────────────────────────────────────────────────────
async function callGroq(systemPrompt, userPrompt, overrides = {}) {
  const cfg = await getConfig();
  const key = cfg.groqApiKey;
  if (!key) throw new Error('No Groq API key. Add it in Settings.');

  const body = {
    model:                  overrides.model               || cfg.ai.model,
    temperature:            overrides.temperature         ?? cfg.ai.temperature,
    reasoning_effort:       overrides.reasoning_effort    || cfg.ai.reasoning_effort,
    max_completion_tokens:  overrides.max_completion_tokens || cfg.ai.max_completion_tokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   },
    ],
    response_format: { type: 'json_object' },
  };

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Groq ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const raw  = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from Groq');

  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  }
}

// ── Public exports ────────────────────────────────────────────────────────────

export async function classifyPosts(posts) {
  const cfg = await getConfig();
  const categories = cfg.reddit?.categories || [];
  const { system, userTemplate } = PROMPTS.CLASSIFY(cfg.profile, categories);
  const result = await callGroq(system, userTemplate(posts));
  await logAction('ai_classify', { count: posts.length, selected: result.results?.filter(r => r.relevant).length });
  return result.results || [];
}

export async function analyzePost(post, comments, research = null) {
  const cfg = await getConfig();
  const { system, userTemplate } = PROMPTS.ANALYZE_POST(cfg.profile);
  const result = await callGroq(system, userTemplate(post, comments, research));
  await logAction('ai_analyze', { postId: post.id });
  return result;
}

export async function draftReply(post, comments, analysis, research = null) {
  const cfg = await getConfig();
  const { system, userTemplate } = PROMPTS.DRAFT_REPLY(cfg.profile);
  const result = await callGroq(system, userTemplate(post, comments, analysis, research));
  await logAction('ai_draft', { postId: post.id, confidence: result.confidence });
  return result;
}

export async function chat(message, contextStr = '', researchMode = false, memoryStr = '') {
  const cfg = await getConfig();
  const localTime = new Date().toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  const { system, userTemplate } = PROMPTS.CHAT(cfg.profile, memoryStr, researchMode, localTime);
  const result = await callGroq(system, userTemplate(message, contextStr));
  await logAction('ai_chat', { researchMode });
  return result;
}

export async function parseReminder(text) {
  const { system, userTemplate } = PROMPTS.CREATE_REMINDER();
  return callGroq(system, userTemplate(text, Date.now()));
}
