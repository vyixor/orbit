// ORBIT — Central Configuration
// All defaults live here. User overrides stored in chrome.storage.sync.

export const ORBIT_VERSION = '1.0.0';

export const DEFAULT_CONFIG = {
  // --- Keys ---
  groqApiKey: '',
  tavilyApiKey: '',

  // --- Identity (used in prompts) ---
  profile: {
    name: '',
    bio: '',
    interests: [],          // ['Python automation', 'Windows tools', 'indie dev']
    projects: [],           // ['Surtr', 'NicheRadar', 'TrueShield']
    skills: [],             // ['Python', 'Electron', 'C++']
    writingStyle: 'casual-technical',  // casual | technical | casual-technical | formal
    tone: 'helpful',        // helpful | witty | direct | concise
    avoidTopics: [],
  },

  // --- Reddit ---
  reddit: {
    enabled: true,
    subreddits: [],         // ['Python', 'learnprogramming', 'sideprojects']
    blockedSubreddits: [],
    keywords: [],
    categories: [],         // ['coding', 'tools', 'automation', 'pdf', 'ai', 'saas']
    blockedKeywords: [],
    minScore: 1,
    maxAgeHours: 48,
    minComments: 0,
    maxCandidatesPerScan: 30,
    maxAIBatch: 15,
    autoScanOnReddit: true,
    scanIntervalMinutes: 30,
  },

  // --- Relevance scoring weights (must sum to 100) ---
  scoringWeights: {
    topicMatch: 40,
    keywordMatch: 20,
    freshness: 15,
    discussionActivity: 10,
    subredditMatch: 10,
    questionDetected: 5,
  },

  // --- AI ---
  ai: {
    model: 'openai/gpt-oss-20b',
    temperature: 0.4,
    reasoning_effort: 'low',
    max_completion_tokens: 1500,
  },

  // --- Scripting ---
  scripting: {
    totalTimeoutMs:    300000,  // 5 minutes — long enough for agent tasks
    maxLoopIterations: 1000,
    maxNestDepth:      32,
  },

  // --- Agent ---
  agent: {
    // Controls the random human-like delay before each AI call.
    // 'low'    = 1–3s   fast, may hit free-tier rate limits
    // 'normal' = 4–8s   balanced, recommended for free plan (default)
    // 'high'   = 9–16s  very safe on free tier
    rateCaution:   'normal',

    // Maximum total characters stored in chunk notes.
    // Oldest notes are evicted automatically when this is exceeded.
    // 800 chars ≈ ~200 tokens — safe even on tight token budgets.
    maxNotesChars: 800,
  },

  // --- Research ---
  research: {
    enabled: true,
    searchDepth: 'basic',      // basic | advanced
    maxResults: 5,
    autoResearch: false,       // auto-trigger tavily when AI flags needsResearch
    confidenceThreshold: 0.6,
  },

  // --- Voice ---
  voice: {
    ttsEnabled:      true,   // ORBIT speaks its replies
    autoSpeakOnSTT:  true,   // auto-speak when reply follows a voice input
    rate:            1.05,
    pitch:           1.0,
    volume:          1.0,
    voiceName:       '',     // '' = browser default
    lang:            'en-US',
    wakeWordEnabled: false,
    wakeWord:        'hey orbit',
    wakeWordLang:    'en-US',
  },

  // --- Posting ---
  posting: {
    requireApprovalDefault: true,  // global default; per-post checkbox overrides
    insertDraftIntoBox: true,
  },

  // --- Notifications ---
  notifications: {
    enabled: true,
    newOpportunity: true,
    taskReminder: true,
    draftReady: true,
    researchComplete: true,
  },

  // --- UI ---
  ui: {
    theme: 'dark',
    compactCards: false,
  },
};

// IndexedDB schema
export const DB_NAME = 'orbit_db';
export const DB_VERSION = 1;
export const STORES = {
  POSTS:     'posts',       // analyzed reddit posts
  DRAFTS:    'drafts',
  TASKS:     'tasks',       // reminders / scheduled tasks
  MEMORY:    'memory',      // key-value facts about user
  HISTORY:   'history',     // action log
  RESEARCH:  'research',    // cached tavily results
  SESSIONS:  'sessions',    // chat sessions
};
