// ORBIT — Typed Script Errors
// Every error thrown inside the scripting engine is one of these subclasses.
// ThrowRegistry.wrapError() matches on constructor name to assign throwNumber + throwID.
//
// Number ranges:
//   1–9    Engine / interpreter (loops, operators, nesting, timeout)
//   10–19  Lex & parse errors (syntax)
//   20–29  Variable & scope errors
//   30–39  Navigation & browser adapter
//   40–49  Element interaction (click, type, drag, scroll, hover)
//   50–59  Data retrieval (get, getPos)
//   60–69  Dialog commands (alert, confirm, prompt)
//   70–79  AI / ask command
//   80–89  JS execution ($exec)
//   90–99  Assertion & control flow
//   100–109 Registry / command registration
//   10000   UnknownError — anything that didn't match a registered type

// ── 1–9  Engine / interpreter errors ─────────────────────────────────────────
export class TimeoutError extends Error {
  constructor(msg) { super(msg); this.name = 'TimeoutError'; }
}
export class NestingError extends Error {
  constructor(msg) { super(msg); this.name = 'NestingError'; }
}
export class RuntimeError extends Error {
  // General interpreter errors: bad operator, division by zero, null access, etc.
  constructor(msg) { super(msg); this.name = 'RuntimeError'; }
}
export class LoopLimitError extends Error {
  // while/until/repeat exceeded max iterations
  constructor(msg) { super(msg); this.name = 'LoopLimitError'; }
}
export class DivisionByZeroError extends Error {
  constructor(msg) { super(msg); this.name = 'DivisionByZeroError'; }
}
export class NullAccessError extends Error {
  // Accessing a property on null/undefined
  constructor(msg) { super(msg); this.name = 'NullAccessError'; }
}
export class ControlFlowError extends Error {
  // break/continue used outside a loop
  constructor(msg) { super(msg); this.name = 'ControlFlowError'; }
}

// ── 10–19  Lex & parse errors ─────────────────────────────────────────────────
export class LexError extends Error {
  constructor(msg, line, col) { super(msg); this.name = 'LexError'; this.line = line; this.col = col; }
}
export class ParseError extends Error {
  constructor(msg, line, col) { super(msg); this.name = 'ParseError'; this.line = line; this.col = col; }
}

// ── 20–29  Variable & command errors ─────────────────────────────────────────
export class UndefinedVariableError extends Error {
  constructor(msg) { super(msg); this.name = 'UndefinedVariableError'; }
}
export class UnknownCommandError extends Error {
  constructor(msg) { super(msg); this.name = 'UnknownCommandError'; }
}
export class CommandError extends Error {
  // Wraps any untyped error that escapes from a command execute() function
  constructor(msg) { super(msg); this.name = 'CommandError'; }
}

// ── 30–39  Navigation & browser errors ───────────────────────────────────────
export class NoBrowserError extends Error {
  // No browser adapter / no web page open
  constructor(msg) { super(msg); this.name = 'NoBrowserError'; }
}
export class NavigationError extends Error {
  // Bad URL or navigation failure
  constructor(msg) { super(msg); this.name = 'NavigationError'; }
}
export class NoTabError extends Error {
  // No accessible browser tab found
  constructor(msg) { super(msg); this.name = 'NoTabError'; }
}
export class BrowserCancelledError extends Error {
  // Browser operation aborted (signal / timeout)
  constructor(msg) { super(msg); this.name = 'BrowserCancelledError'; }
}
export class BrowserResponseError extends Error {
  // Content script returned an error payload
  constructor(msg) { super(msg); this.name = 'BrowserResponseError'; }
}

// ── 40–49  Element interaction errors ────────────────────────────────────────
export class ElementError extends Error {
  // Missing target, selector not found, etc.
  constructor(msg) { super(msg); this.name = 'ElementError'; }
}
export class DragError extends Error {
  constructor(msg) { super(msg); this.name = 'DragError'; }
}
export class ScrollError extends Error {
  constructor(msg) { super(msg); this.name = 'ScrollError'; }
}
export class TypeError extends Error {
  // type/fill command failures (distinct from JS TypeError)
  constructor(msg) { super(msg); this.name = 'TypeError'; }
}
export class HoverError extends Error {
  constructor(msg) { super(msg); this.name = 'HoverError'; }
}

// ── 50–59  Data retrieval errors ──────────────────────────────────────────────
export class GetError extends Error {
  constructor(msg) { super(msg); this.name = 'GetError'; }
}

// ── 60–69  Dialog errors ──────────────────────────────────────────────────────
export class DialogError extends Error {
  constructor(msg) { super(msg); this.name = 'DialogError'; }
}

// ── 70–79  AI / ask errors ────────────────────────────────────────────────────
export class AskError extends Error {
  constructor(msg) { super(msg); this.name = 'AskError'; }
}
export class ApiKeyError extends Error {
  constructor(msg) { super(msg); this.name = 'ApiKeyError'; }
}
export class ApiError extends Error {
  constructor(msg) { super(msg); this.name = 'ApiError'; }
}

// ── 80–89  JS execution errors ────────────────────────────────────────────────
export class ExecError extends Error {
  constructor(msg) { super(msg); this.name = 'ExecError'; }
}
export class NoJsRunnerError extends Error {
  constructor(msg) { super(msg); this.name = 'NoJsRunnerError'; }
}

// ── 90–99  Assertion & wait errors ───────────────────────────────────────────
export class AssertionError extends Error {
  constructor(msg) { super(msg); this.name = 'AssertionError'; }
}
export class WaitError extends Error {
  constructor(msg) { super(msg); this.name = 'WaitError'; }
}

// ── 100–109  Registry errors ──────────────────────────────────────────────────
export class RegistryError extends Error {
  constructor(msg) { super(msg); this.name = 'RegistryError'; }
}

// ── 10000  Fallback ───────────────────────────────────────────────────────────
export class UnknownError extends Error {
  // Assigned to any error whose constructor name has no registered entry.
  constructor(msg) { super(msg); this.name = 'UnknownError'; }
}

// ── Registry bootstrap ────────────────────────────────────────────────────────
export function registerBuiltinErrors(registry) {
  // Engine / interpreter
  registry.register(1,  'TimeoutError');
  registry.register(2,  'NestingError');
  registry.register(3,  'RuntimeError');
  registry.register(4,  'LoopLimitError');
  registry.register(5,  'DivisionByZeroError');
  registry.register(6,  'NullAccessError');
  registry.register(7,  'ControlFlowError');
  // Lex & parse
  registry.register(10, 'LexError');
  registry.register(11, 'ParseError');
  // Variable & command
  registry.register(20, 'UndefinedVariableError');
  registry.register(21, 'UnknownCommandError');
  registry.register(22, 'CommandError');
  // Navigation & browser
  registry.register(30, 'NoBrowserError');
  registry.register(31, 'NavigationError');
  registry.register(32, 'NoTabError');
  registry.register(33, 'BrowserCancelledError');
  registry.register(34, 'BrowserResponseError');
  // Element interaction
  registry.register(40, 'ElementError');
  registry.register(41, 'DragError');
  registry.register(42, 'ScrollError');
  registry.register(43, 'TypeError');
  registry.register(44, 'HoverError');
  // Data retrieval
  registry.register(50, 'GetError');
  // Dialogs
  registry.register(60, 'DialogError');
  // AI / ask
  registry.register(70, 'AskError');
  registry.register(71, 'ApiKeyError');
  registry.register(72, 'ApiError');
  // JS execution
  registry.register(80, 'ExecError');
  registry.register(81, 'NoJsRunnerError');
  // Assertion & wait
  registry.register(90, 'AssertionError');
  registry.register(91, 'WaitError');
  // Registry
  registry.register(100, 'RegistryError');
  // Fallback — always last
  registry.register(10000, 'UnknownError');
}
