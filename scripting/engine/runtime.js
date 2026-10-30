// ORBIT — Script Runtime
// Per-execution context. Manages cancellation, timeout, command dispatch,
// logging, and execution ID isolation.

import {
  TimeoutError, NestingError, UnknownCommandError, CommandError, ExecError, NoJsRunnerError,
} from './errors.js';

export { TimeoutError, NestingError, UnknownCommandError, CommandError, ExecError, NoJsRunnerError };

export class CancelledError extends Error {
  constructor() { super('Script cancelled'); this.cancelled = true; }
}

export class ScriptRuntime {
  constructor(options = {}) {
    this.executionId = options.executionId || `run_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    this.maxIterations = options.maxIterations || 1000;
    this.maxNestDepth  = options.maxNestDepth  || 64;
    this.timeoutMs     = options.timeoutMs     || 30000; // 30s default
    this.nestDepth     = 0;
    this._cancelled    = false;
    this._registry       = options.registry;        // CommandRegistry
    this._browserAdapter = options.browserAdapter;  // BrowserAdapter
    this._orbitBridge    = options.orbitBridge;     // OrbitBridge
    this._jsRunner       = options.jsRunner;        // JSRunner (fallback)
    this._sandboxRunner  = options.sandboxRunner;   // runInSandbox (preferred)
    this._chatServices   = options.chatServices;    // { chat, research, formatResearchContext, runAgentTask }
    this._logFn          = options.logFn || (() => {});
    this._startTime      = Date.now();
    this._abortCtrl      = new AbortController();
    this._signal         = this._abortCtrl.signal;
  }

  get signal() { return this._signal; }

  // ── Cancellation ─────────────────────────────────────────────────────────
  cancel() {
    this._cancelled = true;
    this._abortCtrl.abort();
    this.log('info', 'Script cancelled');
  }

  checkCancel() {
    if (this._cancelled || this._signal.aborted) {
      throw new CancelledError();
    }
    const elapsed = Date.now() - this._startTime;
    if (elapsed > this.timeoutMs) {
      throw new TimeoutError(`Script timed out after ${this.timeoutMs}ms`);
    }
  }

  checkNestDepth(blockType = 'block') {
    if (this.nestDepth >= this.maxNestDepth) {
      throw new NestingError(
        `Nesting depth ${this.nestDepth + 1} exceeds limit ${this.maxNestDepth} at ${blockType} — flatten your logic or raise maxNestDepth`
      );
    }
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  log(level, message, data = {}) {
    this._logFn({ level, message, data, ts: Date.now(), execId: this.executionId });
  }

  // ── Command dispatch ──────────────────────────────────────────────────────
  async runCommand(name, args, namedArgs, node) {
    const cmd = this._registry?.get(name);
    if (!cmd) {
      throw new UnknownCommandError(`Unknown command: "${name}" — ${this._registry?.getSuggestion(name) || 'no suggestions'}`);
    }

    // Validate args
    if (cmd.validate) cmd.validate(args, namedArgs);

    const t0 = Date.now();
    this.log('cmd', `${name}(${args.map(a => JSON.stringify(a)).join(', ')})`, namedArgs);

    try {
      const ctx = this._makeCommandCtx(node);
      const result = await cmd.execute(ctx, args, namedArgs);
      const ms = Date.now() - t0;
      this.log('result', `${name} → ${JSON.stringify(result)} (${ms}ms)`);
      return result ?? null;
    } catch (e) {
      const msg = e.message || String(e);
      this.log('error', `${name} failed: ${msg}`);
      // Re-throw typed errors as-is so their throwID/throwNumber survive
      if (e.name && e.name !== 'Error') throw e;
      throw new CommandError(`Command "${name}" failed: ${msg}`);
    }
  }

  _makeCommandCtx(node) {
    return {
      runtime:      this,
      signal:       this._signal,
      browser:      this._browserAdapter,
      orbit:        this._orbitBridge,
      js:           this._jsRunner,
      chatServices: this._chatServices || null,
      log:          (msg) => this.log('cmd-detail', msg),
      location:     { line: node?.line ?? 0, col: node?.col ?? 0 },
    };
  }

  // ── JS runner delegation ──────────────────────────────────────────────────
  async runJS(code, node, args = null) {
    this.log('js', `$exec: ${String(code).slice(0, 80)}`);
    try {
      // Prefer sandbox runner (works on all pages, no CSP issues)
      if (this._sandboxRunner) {
        const result = await this._sandboxRunner(
          String(code), true,
          (log) => this.log(log.level, log.text),
          args || null
        );
        return result;
      }
      // Fallback to injected runner
      if (this._jsRunner) return await this._jsRunner.execute(code, this._signal);
      throw new NoJsRunnerError('No JS runner available');
    } catch (e) {
      if (e instanceof NoJsRunnerError) throw e;
      throw new ExecError(`$exec failed: ${e.message}`);
    }
  }
}
