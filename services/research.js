// ORBIT — Tavily Research Service

import { getConfig } from './settings.js';
import { db, logAction, STORES } from './db.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function research(query, options = {}) {
  const cfg = await getConfig();
  const key = cfg.tavilyApiKey;
  if (!key) throw new Error('No Tavily API key configured. Add it in Settings.');

  // Check cache
  const allCached = await db.getAll(STORES.RESEARCH);
  const cached = allCached.find(
    r => r.query === query && (Date.now() - r.createdAt) < CACHE_TTL_MS
  );
  if (cached) {
    return { ...cached, fromCache: true };
  }

  const body = {
    api_key: key,
    query,
    search_depth: options.searchDepth || cfg.research.searchDepth,
    max_results: options.maxResults || cfg.research.maxResults,
    include_answer: true,
    include_raw_content: false,
  };

  if (options.topic) body.topic = options.topic;
  if (options.days) body.days = options.days;
  if (options.includeDomains) body.include_domains = options.includeDomains;
  if (options.excludeDomains) body.exclude_domains = options.excludeDomains;

  const resp = await fetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Tavily ${resp.status}: ${err}`);
  }

  const data = await resp.json();

  const result = {
    query,
    answer: data.answer || '',
    sources: (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      content: r.content?.slice(0, 500), // trim
      score: r.score,
    })),
    createdAt: Date.now(),
  };

  await db.put(STORES.RESEARCH, result);
  await logAction('research', { query, sourceCount: result.sources.length });

  return result;
}

// Format research result as compact context string for AI prompts
export function formatResearchContext(result) {
  if (!result) return '';
  const lines = [`Research on: "${result.query}"`];
  if (result.answer) lines.push(`Summary: ${result.answer}`);
  lines.push('Sources:');
  for (const s of result.sources.slice(0, 3)) {
    lines.push(`- ${s.title} (${s.url}): ${s.content}`);
  }
  return lines.join('\n');
}
