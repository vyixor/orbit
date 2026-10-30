// ORBIT — Orbit Script Interpreter
// Walks the AST produced by the parser and evaluates each node.
// All execution is async. Variables are scoped. Commands go through the registry.

import { CancelledError, TimeoutError, NestingError } from './runtime.js';
import {
  UndefinedVariableError, RuntimeError,
  LoopLimitError, DivisionByZeroError, NullAccessError, ControlFlowError,
} from './errors.js';

// Re-export so existing callers that import RuntimeError from interpreter.js still work
export { RuntimeError } from './errors.js';

export class BreakSignal   { constructor() { this.type = 'break'; } }
export class ContinueSignal { constructor() { this.type = 'continue'; } }
export class CancelSignal   { constructor() { this.type = 'cancel'; } }

// ── OrbitThrow — every error inside a run{} block becomes one of these ───────
// throwNumber is an integer code (0 = unknown/unregistered).
// throwID     is a string name  (defaults to the JS error constructor name).
export class OrbitThrow extends Error {
  constructor(msg, throwNumber = 0, throwID = 'RuntimeError', cause = null) {
    super(msg);
    this.name        = 'OrbitThrow';
    this.throwNumber = throwNumber;
    this.throwID     = throwID;
    if (cause) this.cause = cause;
  }
}

// ── ThrowRegistry — maps numeric codes ↔ string IDs ─────────────────────────
// Pre-register known error codes with register(number, id).
// wrapError() converts any raw JS Error into an OrbitThrow using the registry.
export class ThrowRegistry {
  constructor() {
    this._byNumber = new Map();
    this._byID     = new Map();
  }
  register(number, id) {
    this._byNumber.set(number, id);
    this._byID.set(id, number);
  }
  idForNumber(n)  { return this._byNumber.get(n) ?? null; }
  numberForID(id) { return this._byID.get(id) ?? null; }
  // Wraps any JS error into an OrbitThrow. Already-wrapped errors pass through.
  wrapError(err) {
    if (err instanceof OrbitThrow) return err;
    const id  = err.constructor?.name ?? 'UnknownError';
    // If the constructor name is plain 'Error' or not in the registry, use UnknownError/10000
    const num = this._byID.get(id) ?? this._byID.get('UnknownError') ?? 10000;
    const resolvedId = this._byID.has(id) ? id : 'UnknownError';
    return new OrbitThrow(err.message, num, resolvedId, err);
  }
}

// ── Environment (variable scope) ────────────────────────────────────────────
class Environment {
  constructor(parent = null) {
    this._vars = new Map();
    this._parent = parent;
  }
  get(name) {
    if (this._vars.has(name)) return this._vars.get(name);
    if (this._parent) return this._parent.get(name);
    throw new UndefinedVariableError(`Undefined variable: ${name}`);
  }
  set(name, value) {
    // Walk up to find existing binding, else set here
    if (this._vars.has(name)) { this._vars.set(name, value); return; }
    if (this._parent && this._parent.has(name)) { this._parent.set(name, value); return; }
    this._vars.set(name, value);
  }
  define(name, value) { this._vars.set(name, value); }
  has(name) {
    if (this._vars.has(name)) return true;
    if (this._parent) return this._parent.has(name);
    return false;
  }
}

// ── Interpreter ──────────────────────────────────────────────────────────────
export class Interpreter {
  constructor(runtime, throwRegistry = null) {
    this.rt       = runtime;
    this.throwReg = throwRegistry ?? new ThrowRegistry();
  }

  async exec(node, env) {
    this.rt.checkCancel();

    switch (node.type) {
      case 'Program':            return this.execProgram(node, env);
      case 'BlockStatement':     return this.execBlock(node, env, 'block');
      case 'VariableDeclaration':return this.execVarDecl(node, env);
      case 'CommandCall':        return this.execCommandCall(node, env);
      case 'IfStatement':        return this.execIf(node, env);
      case 'WhileStatement':     return this.execWhile(node, env);
      case 'UntilStatement':     return this.execUntil(node, env);
      case 'RepeatStatement':    return this.execRepeat(node, env);
      case 'BreakStatement':      return new BreakSignal();
      case 'ContinueStatement':   return new ContinueSignal();
      case 'TryStatement':        return this.execTryStatement(node, env);
      case 'AssignmentStatement': return this.execAssignment(node, env);
      case 'ThrowStatement':      return this.execThrowStatement(node, env);
      default:
        // If it's a value-producing node, evaluate it
        return this.evalExpr(node, env);
    }
  }

  // ── name = expr  (bare reassignment — no var) ───────────────────────────
  // env.set() walks up the scope chain to find an existing binding.
  // If the variable was never declared with var, throws UndefinedVariableError.
  async execAssignment(node, env) {
    if (!env.has(node.name)) {
      throw new UndefinedVariableError(
        `Cannot assign to undeclared variable "${node.name}". Declare it first with: var ${node.name} = ...`
      );
    }
    const value = await this.evalExpr(node.value, env);
    env.set(node.name, value);
    this.rt.log('var', `${node.name} = ${JSON.stringify(value)}`);
    return value;
  }

  // ── throw N "message"  /  throw ErrorID "message" ───────────────────────
  // Raises an OrbitThrow with the given number or ID.
  // The registry is consulted to fill in the missing half (number→id or id→number).
  // Fatal error codes (#1 #2 #4 #7 #33) cannot be raised by user script — they are
  // reserved for the engine. Attempting to throw them raises a RuntimeError instead.
  async execThrowStatement(node, env) {
    const FATAL_NUMBERS = new Set([1, 2, 4, 7, 33]);
    const FATAL_IDS     = new Set(['TimeoutError', 'NestingError', 'LoopLimitError', 'ControlFlowError', 'BrowserCancelledError']);

    const msgVal  = await this.evalExpr(node.message, env);
    const message = String(msgVal ?? '');

    let throwNumber, throwID;

    if (node.filter.kind === 'number') {
      throwNumber = Number(await this.evalExpr(node.filter.value, env));
      throwID     = this.throwReg.idForNumber(throwNumber) ?? 'UnknownError';
    } else if (node.filter.kind === 'id') {
      throwID     = String(await this.evalExpr(node.filter.value, env));
      throwNumber = this.throwReg.numberForID(throwID) ?? 10000;
    } else {
      // 'dynamic' — {$var} in the code position; detect number vs string at runtime
      const raw = await this.evalExpr(node.filter.value, env);
      if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) {
        throwNumber = Number(raw);
        throwID     = this.throwReg.idForNumber(throwNumber) ?? 'UnknownError';
      } else {
        throwID     = String(raw);
        throwNumber = this.throwReg.numberForID(throwID) ?? 10000;
      }
    }

    if (FATAL_NUMBERS.has(throwNumber) || FATAL_IDS.has(throwID)) {
      throw new RuntimeError(
        `Cannot throw fatal error "${throwID}" (#${throwNumber}) from user script — ` +
        'fatal error codes are reserved for the engine.'
      );
    }

    throw new OrbitThrow(message || `${throwID} thrown by script`, throwNumber, throwID);
  }

  // ── run{} onThrow{} onFinish{} ───────────────────────────────────────────
  // Returns true for errors that must terminate the script unconditionally.
  // These bypass all onThrow clauses and cannot be caught by user code.
  _isFatalError(err) {
    return (
      err instanceof CancelledError  ||  // ■ Stop pressed
      err instanceof TimeoutError    ||  // script time limit exceeded
      err instanceof NestingError    ||  // nesting depth guard
      err instanceof LoopLimitError  ||  // iteration guard
      err instanceof ControlFlowError    // break/continue outside loop
    );
  }

  async execTryStatement(node, env) {
    const { body, onThrow, onFinish } = node;
    let result = null;
    // pendingThrow: an error that was not caught (no clause, filter mismatch, or fatal).
    // Held here so onFinish can still run before it propagates.
    let pendingThrow = null;
    // originalThrow: set when the body threw and onThrow handled it, but then onFinish
    // also threw. We log the onFinish error but preserve and re-throw the original.
    let originalThrow = null;

    try {
      result = await this.execBlock(body, env, 'run body');
    } catch (rawErr) {
      // Fatal errors bypass everything and terminate immediately.
      if (this._isFatalError(rawErr)) throw rawErr;

      const orbitErr = this.throwReg.wrapError(rawErr);

      if (onThrow) {
        // Check filter
        let matches = true;
        if (onThrow.filter) {
          const expected = await this.evalExpr(onThrow.filter.value, env);
          if (onThrow.filter.kind === 'number') {
            matches = orbitErr.throwNumber === Number(expected);
          } else { // 'id'
            matches = orbitErr.throwID === String(expected);
          }
        }

        if (matches) {
          // throwNumber / throwID are scoped to the onThrow block only.
          // They are NOT defined in onFinish.
          const handlerEnv = new Environment(env);
          handlerEnv.define('throwNumber', orbitErr.throwNumber);
          handlerEnv.define('throwID',     orbitErr.throwID);
          this.rt.log('throw', `#${orbitErr.throwNumber} ${orbitErr.throwID}: ${orbitErr.message}`);
          result = await this._execBlockInEnv(onThrow.body, handlerEnv);
          // Error handled. If onFinish now throws, we track this as the original.
          originalThrow = null; // no pending error at this point
        } else {
          // Filter didn't match — error propagates (after onFinish)
          pendingThrow = orbitErr;
        }
      } else {
        // No onThrow clause — error propagates (after onFinish)
        pendingThrow = orbitErr;
      }
    } finally {
      // onFinish always runs — even when the body succeeded.
      // throwNumber / throwID from the body error are NOT in scope here.
      if (onFinish) {
        try {
          await this.execBlock(onFinish, env, 'onFinish');
        } catch (finishErr) {
          // Fatal errors in onFinish still terminate immediately.
          if (this._isFatalError(finishErr)) throw finishErr;
          const wrappedFinishErr = this.throwReg.wrapError(finishErr);
          if (pendingThrow) {
            // Body threw, onThrow didn't catch it, onFinish also threw.
            // Log the onFinish error but preserve the original body error.
            this.rt.log('throw', `onFinish also threw #${wrappedFinishErr.throwNumber} ${wrappedFinishErr.throwID}: ${wrappedFinishErr.message} (original error preserved)`);
            // pendingThrow stays as-is — original error propagates
          } else {
            // Body succeeded (or onThrow handled it) but onFinish threw.
            // The onFinish error becomes the propagating error.
            pendingThrow = wrappedFinishErr;
          }
        }
      }
    }

    if (pendingThrow) throw pendingThrow;
    return result;
  }

  // Run a BlockStatement using a caller-supplied env (skips the child-env creation
  // that execBlock does — used when we've already built the env, e.g. handler env).
  async _execBlockInEnv(node, env, blockType = 'onThrow') {
    this.rt.checkNestDepth(blockType);
    this.rt.nestDepth++;
    let last = null;
    try {
      for (const stmt of node.body) {
        this.rt.checkCancel();
        const r = await this.exec(stmt, env);
        if (r instanceof BreakSignal || r instanceof ContinueSignal) return r;
        last = r;
      }
    } finally {
      this.rt.nestDepth--;
    }
    return last;
  }

  async execProgram(node, env) {
    let last = null;
    for (const stmt of node.body) {
      this.rt.checkCancel();
      const result = await this.exec(stmt, env);
      if (result instanceof BreakSignal || result instanceof ContinueSignal) {
        throw new ControlFlowError('break/continue outside loop');
      }
      last = result;
    }
    return last;
  }

  async execBlock(node, env, blockType = 'block') {
    this.rt.checkNestDepth(blockType);
    this.rt.nestDepth++;
    const blockEnv = new Environment(env);
    let last = null;
    try {
      for (const stmt of node.body) {
        this.rt.checkCancel();
        const result = await this.exec(stmt, blockEnv);
        if (result instanceof BreakSignal || result instanceof ContinueSignal) {
          return result; // propagate to loop handler
        }
        last = result;
      }
    } finally {
      this.rt.nestDepth--;
    }
    return last;
  }

  async execVarDecl(node, env) {
    const value = await this.evalExpr(node.init, env);
    env.define(node.name, value);
    this.rt.log('var', `${node.name} = ${JSON.stringify(value)}`);
    return value;
  }

  async execCommandCall(node, env) {
    const args = [];
    for (const a of node.args) args.push(await this.evalExpr(a, env));
    const namedArgs = {};
    for (const [k, v] of Object.entries(node.namedArgs)) {
      namedArgs[k] = await this.evalExpr(v, env);
    }
    return this.rt.runCommand(node.name, args, namedArgs, node);
  }

  async execIf(node, env) {
    const test = await this.evalExpr(node.test, env);
    if (this.isTruthy(test)) {
      return this.execBlock(node.consequent, env, 'if');
    } else if (node.alternate) {
      if (node.alternate.type === 'IfStatement') {
        return this.execIf(node.alternate, env);
      }
      return this.execBlock(node.alternate, env, 'else');
    }
    return null;
  }

  async execWhile(node, env) {
    let iter = 0;
    while (true) {
      this.rt.checkCancel();
      if (++iter > this.rt.maxIterations) {
        throw new LoopLimitError(`while loop exceeded ${this.rt.maxIterations} iterations`);
      }
      const test = await this.evalExpr(node.test, env);
      if (!this.isTruthy(test)) break;
      const result = await this.execBlock(node.body, env, 'while');
      if (result instanceof BreakSignal) break;
      // ContinueSignal: just restart loop
    }
    return null;
  }

  async execUntil(node, env) {
    let iter = 0;
    while (true) {
      this.rt.checkCancel();
      if (++iter > this.rt.maxIterations) {
        throw new LoopLimitError(`until loop exceeded ${this.rt.maxIterations} iterations`);
      }
      const test = await this.evalExpr(node.test, env);
      if (this.isTruthy(test)) break;
      const result = await this.execBlock(node.body, env, 'until');
      if (result instanceof BreakSignal) break;
    }
    return null;
  }

  async execRepeat(node, env) {
    const count = await this.evalExpr(node.count, env);
    if (typeof count !== 'number' || count < 0) {
      throw new LoopLimitError(`repeat count must be a non-negative number, got ${count}`);
    }
    const n = Math.min(Math.floor(count), this.rt.maxIterations);
    for (let i = 0; i < n; i++) {
      this.rt.checkCancel();
      const result = await this.execBlock(node.body, env, 'repeat');
      if (result instanceof BreakSignal) break;
    }
    return null;
  }

  // ── Expression evaluator ─────────────────────────────────────────────────
  async evalExpr(node, env) {
    this.rt.checkCancel();

    switch (node.type) {
      case 'StringLiteral':  return this._interpolate(node.value, env);
      case 'NumberLiteral':  return node.value;
      case 'BooleanLiteral': return node.value;
      case 'NullLiteral':    return null;

      case 'VariableReference': {
        const val = env.get(node.name);
        if (node.prop != null) {
          if (val == null) throw new NullAccessError(`Cannot access .${node.prop} on null`);
          return val[node.prop] ?? null;
        }
        return val;
      }

      case 'MemberExpression': {
        const obj = await this.evalExpr(node.object, env);
        if (obj == null) throw new NullAccessError(`Cannot access .${node.property} on null`);
        return obj[node.property] ?? null;
      }

      case 'BinaryExpression': return this.evalBinary(node, env);
      case 'UnaryExpression':  return this.evalUnary(node, env);

      case 'CommandCall':      return this.execCommandCall(node, env);

      case 'RunExpression': {
        this.rt.checkNestDepth('$run()');
        this.rt.nestDepth++;
        try {
          const body = node.body;
          if (body.type === 'SequenceExpression') {
            let last = null;
            const seqEnv = new Environment(env);
            for (const stmt of body.body) {
              last = await this.exec(stmt, seqEnv);
            }
            return last;
          }
          return this.exec(body, env);
        } finally {
          this.rt.nestDepth--;
        }
      }

      case 'RunJSExpression': {
        const code = await this.evalExpr(node.code, env);
        // Evaluate args object if present: $exec("code", { key: {$var} })
        let args = null;
        if (node.args) {
          args = {};
          for (const [k, v] of Object.entries(node.args)) {
            args[k] = await this.evalExpr(v, env);
          }
        }
        return this.rt.runJS(code, node, args);
      }

      case 'SequenceExpression': {
        let last = null;
        for (const stmt of node.body) last = await this.exec(stmt, env);
        return last;
      }

      default:
        throw new RuntimeError(`Cannot evaluate node type: ${node.type}`);
    }
  }

  async evalBinary(node, env) {
    const { op } = node;
    // Short-circuit for 'and' / 'or'
    if (op === 'and') {
      const left = await this.evalExpr(node.left, env);
      if (!this.isTruthy(left)) return false;
      return this.isTruthy(await this.evalExpr(node.right, env));
    }
    if (op === 'or') {
      const left = await this.evalExpr(node.left, env);
      if (this.isTruthy(left)) return true;
      return this.isTruthy(await this.evalExpr(node.right, env));
    }

    const left  = await this.evalExpr(node.left, env);
    const right = await this.evalExpr(node.right, env);

    switch (op) {
      case '+':  return (typeof left === 'number' && typeof right === 'number') ? left + right : String(left) + String(right);
      case '-':  return left - right;
      case '*':  return left * right;
      case '/':  if (right === 0) throw new DivisionByZeroError('Division by zero'); return left / right;
      case '%':  return left % right;
      case '==': return left == right; // intentional loose
      case '!=': return left != right;
      case '<':  return left < right;
      case '>':  return left > right;
      case '<=': return left <= right;
      case '>=': return left >= right;
      default:   throw new RuntimeError(`Unknown operator: ${op}`);
    }
  }

  async evalUnary(node, env) {
    const val = await this.evalExpr(node.operand, env);
    switch (node.op) {
      case 'not': return !this.isTruthy(val);
      case '-':   return -val;
      default:    throw new RuntimeError(`Unknown unary op: ${node.op}`);
    }
  }

  // Expand {$varName} and {$varName.prop} inside a string value at runtime.
  // Unresolvable references are left as-is (safe fallback, matches existing behaviour
  // where vars outside strings silently fail with an env error).
  _interpolate(str, env) {
    if (!str.includes('{$')) return str; // fast path — no interpolation needed
    return str.replace(/\{\$(\w+)(?:\.(\w+))?\}/g, (match, name, prop) => {
      try {
        const val = env.get(name);
        if (prop != null) {
          if (val == null) return match;
          const sub = val[prop];
          return sub == null ? '' : String(sub);
        }
        return val == null ? '' : String(val);
      } catch (_) {
        return match; // variable not defined — leave placeholder intact
      }
    });
  }

  isTruthy(val) {
    if (val === null || val === undefined || val === false) return false;
    if (val === 0 || val === '') return false;
    if (Array.isArray(val) && val.length === 0) return false;
    return true;
  }

  // ── Create root environment ───────────────────────────────────────────────
  createRootEnv() { return new Environment(null); }
}
