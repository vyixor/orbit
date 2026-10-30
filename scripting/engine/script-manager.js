// ORBIT — Script Manager
// Top-level orchestrator. Detects language, runs Orbit Script or JS,
// manages execution lifecycle, and provides a clean API for the editor UI.

import { tokenize, LexError } from './lexer.js';
import { parse, ParseError }   from './parser.js';
import { Interpreter, BreakSignal, ContinueSignal, OrbitThrow, ThrowRegistry } from './interpreter.js';
import { registerBuiltinErrors, NoJsRunnerError } from './errors.js';
import { ScriptRuntime, CancelledError } from './runtime.js';
import { runInSandbox } from '../runjs-sandbox.js';

function getSandboxRunner() { return runInSandbox; }

export const LANG = Object.freeze({ JS: 'js', OS: 'os', AUTO: 'auto' });

// ── Language detection ────────────────────────────────────────────────────────
export function detectLanguage(src, hint = LANG.AUTO) {
  const stripped = src.replace(/^\uFEFF/, '').trimStart();
  const directiveMatch = stripped.match(/^"use (js|obt)"\s*;?\s*(\r?\n|$)/i);
  if (directiveMatch) {
    const d = directiveMatch[1].toLowerCase();
    return d === 'obt' ? LANG.OS : d; // "use obt" → OBT interpreter (LANG.OS path)
  }
  if (hint !== LANG.AUTO) return hint;
  return LANG.OS; // default
}

export function stripDirective(src) {
  return src.replace(/^\uFEFF/, '').replace(/^\s*"use (js|os)"\s*;?\s*(\r?\n)?/i, '');
}

// ── Active run tracker (one run at a time per manager instance) ───────────────
export class ScriptManager {
  constructor({ registry, browserAdapter, orbitBridge, jsRunner, chatServices = null, settings = {}, throwRegistry = null }) {
    this.registry        = registry;
    this.browserAdapter  = browserAdapter;
    this.orbitBridge     = orbitBridge;
    this.jsRunner        = jsRunner;
    this.chatServices    = chatServices;
    this.settings        = settings;
    if (!throwRegistry) {
      throwRegistry = new ThrowRegistry();
      registerBuiltinErrors(throwRegistry);
    }
    this.throwRegistry = throwRegistry;
    this._activeRuntime  = null;
  }

  // ── Run a script ──────────────────────────────────────────────────────────
  async run(src, { lang = LANG.AUTO, onLog = null, execId = null } = {}) {
    // Cancel any previous run first
    this.stop();

    const language = detectLanguage(src, lang);
    const cleanSrc = stripDirective(src);

    const sandboxRunner = getSandboxRunner();

    const runtime = new ScriptRuntime({
      executionId:    execId || `run_${Date.now()}`,
      registry:       this.registry,
      browserAdapter: this.browserAdapter,
      orbitBridge:    this.orbitBridge,
      jsRunner:       this.jsRunner,
      sandboxRunner:  sandboxRunner,
      chatServices:   this.chatServices,
      maxIterations:  this.settings.maxLoopIterations || 1000,
      maxNestDepth:   this.settings.maxNestDepth || 32,
      timeoutMs:      this.settings.totalTimeoutMs || 60000,
      logFn:          onLog || (() => {}),
    });
    this._activeRuntime = runtime;

    try {
      if (language === LANG.JS) {
        return await this._runJS(cleanSrc, runtime);
      } else {
        return await this._runOS(cleanSrc, runtime);
      }
    } finally {
      if (this._activeRuntime === runtime) this._activeRuntime = null;
    }
  }

  // ── Stop current execution ────────────────────────────────────────────────
  stop() {
    if (this._activeRuntime) {
      this._activeRuntime.cancel();
      this._activeRuntime = null;
    }
  }

  get isRunning() { return this._activeRuntime != null; }

  // ── Orbit Script execution ────────────────────────────────────────────────
  async _runOS(src, runtime) {
    // Phase 1: Lex
    let tokens;
    try { tokens = tokenize(src); }
    catch (e) {
      if (e instanceof LexError) throw new ScriptError(e.message, 'lex', e.line, e.col);
      throw e;
    }

    // Phase 2: Parse
    let ast;
    try { ast = parse(tokens); }
    catch (e) {
      if (e instanceof ParseError) throw new ScriptError(e.message, 'parse', e.line, e.col);
      throw e;
    }

    // Phase 3: Execute
    const interpreter = new Interpreter(runtime, this.throwRegistry);
    const env = interpreter.createRootEnv();
    try {
      return await interpreter.exec(ast, env);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      if (e instanceof ScriptError) throw e;
      // Wrap in a ScriptError for consistent surfacing
      throw new ScriptError(e.message, 'runtime', e.line, e.col, e);
    }
  }

  // ── JavaScript execution ──────────────────────────────────────────────────
  async _runJS(src, runtime) {
    if (!this.jsRunner) throw new NoJsRunnerError('JavaScript runner is not available');
    try {
      return await this.jsRunner.executeScript(src, runtime);
    } catch (e) {
      if (e instanceof CancelledError) throw e;
      throw new ScriptError(`JavaScript error: ${e.message}`, 'js');
    }
  }

  // ── Validate (parse-only, no execute) ─────────────────────────────────────
  validate(src, lang = LANG.AUTO) {
    const language = detectLanguage(src, lang);
    if (language === LANG.JS) return []; // No static validation for JS here
    const cleanSrc = stripDirective(src);
    const errors = [];
    try {
      const tokens = tokenize(cleanSrc);
      parse(tokens);
    } catch (e) {
      errors.push({ message: e.message, line: e.line ?? 0, col: e.col ?? 0, phase: e.phase ?? 'syntax' });
    }
    return errors;
  }
}

// Re-export so consumers only need one import
export { OrbitThrow, ThrowRegistry };

// ── ScriptError ───────────────────────────────────────────────────────────────
export class ScriptError extends Error {
  constructor(message, phase = 'runtime', line = 0, col = 0, cause = null) {
    super(message);
    this.phase = phase;
    this.line = line;
    this.col  = col;
    if (cause) this.cause = cause;
  }
}
