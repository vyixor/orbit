// ORBIT — Settings Service
// Wraps chrome.storage.sync with deep-merge against defaults.

import { DEFAULT_CONFIG } from '../lib/config.js';

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

export async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('orbit_config', (result) => {
      const saved = result.orbit_config || {};
      resolve(deepMerge(DEFAULT_CONFIG, saved));
    });
  });
}

export async function saveConfig(partial) {
  const current = await getConfig();
  const merged = deepMerge(current, partial);
  return new Promise((resolve) => {
    chrome.storage.sync.set({ orbit_config: merged }, resolve);
  });
}

export async function resetConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.remove('orbit_config', resolve);
  });
}

// Convenience: get a single nested value
export async function getConfigValue(...path) {
  const cfg = await getConfig();
  return path.reduce((obj, key) => obj?.[key], cfg);
}
