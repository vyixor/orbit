// ORBIT — Memory Service
// Managed key-value store with automatic compression when near limit.
// Max 50 entries. When full, AI compresses least-relevant into summaries.

import { db, STORES } from './db.js';

const MAX_ENTRIES    = 50;
const WARN_THRESHOLD = 45;

// ── Read ──────────────────────────────────────────────────────────────────────

export async function memoryGetAll() {
  const all = await db.getAll(STORES.MEMORY);
  return all.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));
}

export async function memoryGet(key) {
  const rec = await db.get(STORES.MEMORY, key);
  return rec?.value ?? null;
}

// ── Write ─────────────────────────────────────────────────────────────────────

export async function memorySave(key, value, opts = {}) {
  const {
    relevance = 5,   // 1-10, higher = keep longer
    category  = 'general',
    source    = 'user', // user | auto | orbit
  } = opts;

  await db.put(STORES.MEMORY, {
    key,
    value,
    relevance,
    category,
    source,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await enforceLimit();
}

export async function memoryDelete(key) {
  await db.delete(STORES.MEMORY, key);
}

// ── Format for AI prompt ──────────────────────────────────────────────────────

export async function memoryForPrompt(maxEntries = 20) {
  const all = await memoryGetAll();
  return all
    .slice(0, maxEntries)
    .map(m => `[${m.category}] ${m.key}: ${m.value}`)
    .join('\n');
}

// ── Enforce size limit — drop lowest relevance when over limit ─────────────────

async function enforceLimit() {
  const all = await db.getAll(STORES.MEMORY);
  if (all.length <= MAX_ENTRIES) return;

  // Sort by relevance asc (lowest first), then by age (oldest first)
  const sorted = all.sort((a, b) => {
    const rDiff = (a.relevance || 1) - (b.relevance || 1);
    if (rDiff !== 0) return rDiff;
    return (a.updatedAt || 0) - (b.updatedAt || 0);
  });

  // Remove oldest/least-relevant until under limit
  const toRemove = sorted.slice(0, all.length - MAX_ENTRIES);
  for (const item of toRemove) {
    await db.delete(STORES.MEMORY, item.key);
  }
}

// ── Parse AI memory update instructions ──────────────────────────────────────
// AI returns: "SAVE:key:value" | "DELETE:key" | "UPDATE:key:value"

export async function applyMemoryUpdate(instruction) {
  if (!instruction) return;
  const lines = instruction.split('\n').filter(Boolean);
  for (const line of lines) {
    if (line.startsWith('SAVE:') || line.startsWith('UPDATE:')) {
      const parts = line.split(':');
      const key   = parts[1]?.trim();
      const value = parts.slice(2).join(':').trim();
      if (key && value) {
        await memorySave(key, value, { source: 'auto', relevance: 5 });
      }
    } else if (line.startsWith('DELETE:')) {
      const key = line.split(':')[1]?.trim();
      if (key) await memoryDelete(key);
    }
  }
}

export async function memoryStats() {
  const all = await db.getAll(STORES.MEMORY);
  return { count: all.length, max: MAX_ENTRIES, warn: all.length >= WARN_THRESHOLD };
}
