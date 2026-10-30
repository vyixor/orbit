# ORBIT

An AI-powered Chrome browser companion that lives in your side panel. Chat naturally, automate browser tasks with scripts, run JavaScript logic, and interrogate any page — all from a friendly floating assistant.

## Quick Start

1. Open `icons/generate_icons.html` in Chrome to generate the icon files
2. Go to `chrome://extensions/` → Developer mode → Load unpacked → select this folder
3. Click the ORBIT icon to open the side panel
4. Enter your Groq API key in Settings

## Features

- **Chat** — Talk to an AI that can read pages, click things, fill forms, and navigate
- **OBT Script** — Write browser automation in a readable, shell-like language
- **Structured error handling** — `run{}` / `onThrow{}` / `onFinish{}` with typed error codes
- **`$exec()`** — Run JavaScript expressions in a secure sandboxed iframe
- **`ask`** — Query the AI from inside a script; supports page reading and agent mode
- **`alert` / `confirm` / `prompt`** — Pause a script and interact with the user via dialogs
- **Browser Agent** — AI-driven multi-step browser automation with paged page reading
- **Floating bot** — Animated companion with speech bubbles, expressions, and mouth sync
- **Voice (TTS)** — ORBIT speaks replies using the browser's built-in text-to-speech
- **Memory** — ORBIT remembers facts across chat sessions (chat only)
- **Research** — Tavily-powered web search built into chat

## Privacy

- No cloud backend — everything runs locally inside Chrome
- API keys stored in `chrome.storage.local` only
- No tracking, no data collection

See `ORBIT_DOCS.md` for full documentation.

## Script Quick Reference

```
"use obt";

# Navigate and interact
navigate "https://example.com";
wait 2;
click "Sign In";
focus --type selector "input[name='email']";
type "user@example.com";
press Enter;

# Read page data
var title = $run(get --type text --target selector "h1");
var count = $run(get --type count --target selector ".item");
say "Found {$count} items on: {$title}";

# JavaScript logic in a secure sandbox
var today = $exec("new Date().toLocaleDateString()");
var upper = $exec("'hello world'.toUpperCase()");
# Pass page values safely as args (never concatenate into code)
var n = $exec("return parseFloat(price.replace('$',''))", { price: {$raw} });

# Ask the AI from inside a script
var answer  = $run(ask "What is the capital of France?");
var summary = $run(ask "Summarise this page" --page);
var result  = $run(ask "Find the price of the first product" --agent);
say {$answer};

# User dialogs
alert "Backup complete.";
var ok   = $run(confirm "Delete all items?");
var name = $run(prompt "What is your name?");

# Control the bot
happyFace;
rollOrbit;
say "Done!";
```

## Variables & Reassignment Quick Reference

```
var count = 0;         # declare — always required first
count = count + 1;     # bare reassignment — updates the outer binding (no var)
                       # var count = 1 inside a block would shadow, not update
```

`var` always creates a new binding in the current block's scope. Bare `name = value` walks up the scope chain to mutate an existing binding. Assigning to an undeclared name throws `UndefinedVariableError` (#20).

## Throwing Errors Quick Reference

```
throw 40 "Element not found";              # by number literal
throw ElementError "Missing button";       # by registered ID (bare ident = string literal)
throw {$throwNumber} "re-raised";          # by variable — number or string detected at runtime
throw {$throwID} "re-raised by ID";        # by variable ID string
throw 200 "Item {$itemId} failed";         # message interpolation works normally
```

Fatal codes (#1 #2 #4 #7 #33) cannot be thrown from user script — raises `RuntimeError` (#3) instead.
`throw` is a statement — `$run(throw ...)` is a parse error.
Unregistered numbers preserve the code; unregistered ID strings lose both (become `UnknownError`/10000).

## Error Handling Quick Reference

OBT uses `run{}` / `onThrow{}` / `onFinish{}` for structured error handling.
These are **statement blocks** — completely separate from `$run()` which captures return values.

```
"use obt";

# Catch any error
run {
    click "#submit";
}
onThrow {
    say "Failed: {$throwID} (code {$throwNumber})";
}
onFinish {
    say "Always runs";
}

# Catch by error name
run {
    navigate "https://bad-url";
}
onThrow.throwID(NavigationError) {
    say "Bad URL";
}

# Catch by error number
run {
    click "#missing";
}
onThrow.throwNumber(40) {
    say "Element not found";
}
```

### Rules
- Each `run{}` accepts exactly **one** `onThrow` clause. Use nested `run{}` blocks for multiple error types.
- Fatal errors (#1 #2 #4 #7 #33) bypass `onThrow` unconditionally — they cannot be caught.
- `throwNumber`/`throwID` are only in scope inside `onThrow{}`, not `onFinish{}`.
- `onFinish` does not support filters — it always runs unconditionally.

### Built-in Error Codes

| # | ID | Fatal? | When |
|---|----|----|---|
| 1 | `TimeoutError` | **yes** | Script timed out |
| 2 | `NestingError` | **yes** | Nesting depth exceeded (default 64) |
| 3 | `RuntimeError` | no | Bad operator or unknown AST node |
| 4 | `LoopLimitError` | **yes** | Loop hit max iterations (default 1000) |
| 5 | `DivisionByZeroError` | no | Division by zero |
| 6 | `NullAccessError` | no | Property access on null |
| 7 | `ControlFlowError` | **yes** | `break`/`continue` outside a loop |
| 10 | `LexError` | pre-exec | Invalid character or syntax |
| 11 | `ParseError` | pre-exec | Unexpected token or two `onThrow` clauses |
| 20 | `UndefinedVariableError` | no | Variable not declared |
| 21 | `UnknownCommandError` | no | Command not found |
| 22 | `CommandError` | no | Command threw a plain untyped `Error` |
| 30 | `NoBrowserError` | no | Browser adapter not initialised |
| 31 | `NavigationError` | no | Invalid URL |
| 32 | `NoTabError` | no | No accessible tab open |
| 33 | `BrowserCancelledError` | **yes** | ■ Stop pressed |
| 34 | `BrowserResponseError` | no | Content script returned error payload |
| 40 | `ElementError` | no | Element not found |
| 41 | `DragError` | no | Invalid drag coordinates |
| 42 | `ScrollError` | no | Scroll failure |
| 43 | `TypeError` | no | `type`/`fill` failure (not JS TypeError) |
| 44 | `HoverError` | no | Hover failure |
| 50 | `GetError` | no | get/getPos failure |
| 60 | `DialogError` | no | Dialog not available |
| 70 | `AskError` | no | AI ask failure |
| 71 | `ApiKeyError` | no | No API key |
| 72 | `ApiError` | no | API returned an error |
| 80 | `ExecError` | no | $exec JS error |
| 81 | `NoJsRunnerError` | no | No JS runner |
| 90 | `AssertionError` | no | assert failed |
| 91 | `WaitError` | no | Invalid wait value |
| 100 | `RegistryError` | no | Bad command registration |
| **10000** | **`UnknownError`** | no | **Anything unregistered — log {$throwID} to debug** |

**Fatal errors** (#1, #2, #4, #7, #33) bypass all `onThrow` clauses. `LexError`/`ParseError` (pre-exec) fire before any script runs. Custom codes 101–9999 reserved for extensions; ≥ 10001 free.

## Files

```
background/worker.js           — Service worker: API routing, browser control
content/orbit-bot.js           — Floating companion (animations, TTS, speech bubbles)
content/browser-agent.js       — DOM automation + paged page chunk reading
content/page-reader.js         — Page text extraction
scripting/engine/errors.js     — All typed error classes + ThrowRegistry bootstrap
scripting/engine/lexer.js      — Tokeniser
scripting/engine/parser.js     — AST parser
scripting/engine/interpreter.js — AST evaluator + execTryStatement (run/onThrow/onFinish)
scripting/engine/runtime.js    — Per-run context: cancellation, timeout, command dispatch
scripting/engine/script-manager.js — Script orchestration, ThrowRegistry wiring
scripting/engine/registry.js   — Command registry
scripting/commands/builtin.js  — All built-in OBT commands
scripting/browser-adapter.js   — Chrome message bridge for page commands
scripting/js-runner.js         — $exec() tab injection
scripting/sandbox.html         — Sandboxed eval page for $exec()
scripting/runjs-sandbox.js     — $exec() iframe wiring
services/voice.js              — TTS (browser speechSynthesis)
services/ai.js                 — Groq chat API
services/agent.js              — Browser automation agent with paged reading
services/research.js           — Tavily search
services/memory.js             — Persistent memory store
sidepanel/                     — Side panel UI (app.js, index.html, style.css)
sidepanel/script-tab.js        — Script editor, AI generation, console
lib/config.js                  — Configuration defaults
```
