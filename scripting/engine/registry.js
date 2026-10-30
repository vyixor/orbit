// ORBIT — Command Registry
// The single source of truth for all Orbit Script commands.
// Adding a new command never requires touching the lexer, parser, or interpreter.

export { RegistryError } from './errors.js';

export class CommandRegistry {
  constructor() {
    this._commands = new Map();   // name → CommandDef
    this._aliases  = new Map();   // alias → canonical name
  }

  // ── Registration ─────────────────────────────────────────────────────────
  register(def) {
    if (!def.name || typeof def.name !== 'string') throw new RegistryError('Command must have a name');
    if (typeof def.execute !== 'function') throw new RegistryError(`Command "${def.name}" must have an execute function`);

    if (this._commands.has(def.name)) throw new RegistryError(`Command "${def.name}" already registered`);
    this._commands.set(def.name, def);

    for (const alias of (def.aliases || [])) {
      if (this._aliases.has(alias) || this._commands.has(alias)) {
        throw new RegistryError(`Alias "${alias}" for "${def.name}" collides with an existing name`);
      }
      this._aliases.set(alias, def.name);
    }
    return this;
  }

  // ── Retrieval ─────────────────────────────────────────────────────────────
  get(name) {
    if (this._commands.has(name)) return this._commands.get(name);
    const canonical = this._aliases.get(name);
    if (canonical) return this._commands.get(canonical);
    return null;
  }

  has(name) { return this.get(name) != null; }

  // ── Fuzzy suggestion for typos ────────────────────────────────────────────
  getSuggestion(name) {
    const all = this.allNames();
    const lower = name.toLowerCase();
    const close = all.filter(n => n.startsWith(lower.slice(0, 3)) || this._editDistance(n, lower) <= 2);
    return close.length ? `Did you mean: ${close.slice(0,3).join(', ')}?` : '';
  }

  _editDistance(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => j === 0 ? i : i === 0 ? j : 0));
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
    return dp[m][n];
  }

  // ── Listing ────────────────────────────────────────────────────────────────
  allNames()    { return [...this._commands.keys()]; }
  allAliases()  { return [...this._aliases.keys()]; }
  allDefs()     { return [...this._commands.values()]; }

  // ── Autocomplete metadata ──────────────────────────────────────────────────
  autocomplete(prefix = '') {
    const lower = prefix.toLowerCase();
    return this.allDefs()
      .filter(d => d.name.toLowerCase().startsWith(lower))
      .map(d => ({
        name: d.name,
        aliases: d.aliases || [],
        description: d.description || '',
        usage: d.usage || '',
        args: d.args || [],
      }));
  }

  // ── Custom command management (user-defined) ──────────────────────────────
  registerCustom(def) {
    // Custom commands may not override protected built-ins
    if (def.builtin) throw new RegistryError('Cannot register built-in via registerCustom');
    this.register({ ...def, custom: true });
  }

  removeCustom(name) {
    const def = this._commands.get(name);
    if (!def) return false;
    if (def.builtin) throw new RegistryError(`Cannot remove built-in command "${name}"`);
    this._commands.delete(name);
    for (const [alias, target] of this._aliases) {
      if (target === name) this._aliases.delete(alias);
    }
    return true;
  }

  listCustom() { return this.allDefs().filter(d => d.custom); }
}
