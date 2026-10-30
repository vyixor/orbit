# ORBIT — Complete Documentation

> Version 18 · "use obt";

ORBIT is a Chrome extension that puts an AI-powered browser companion in your side panel. It can chat, automate browser tasks, run custom scripts, and interrogate any page — all from a friendly floating assistant.

---

## Table of Contents

1. [Installation](#installation)
2. [Architecture & Privacy](#architecture--privacy)
3. [API Key Storage & Security](#api-key-storage--security)
4. [What Gets Sent to Groq](#what-gets-sent-to-groq)
5. [Chat Mode](#chat-mode)
6. [Script Tab](#script-tab)
7. [The "use obt"; Directive](#the-use-obt-directive)
8. [OBT Script Language Reference](#obt-script-language-reference)
9. [Expression Grammar](#expression-grammar)
10. [Built-in Command Reference](#built-in-command-reference)
11. [String Utilities](#string-utilities)
12. [Dialog Commands](#dialog-commands)
13. [AI Commands — ask](#ai-commands--ask)
14. [Dynamic Execution — $run() and $exec()](#dynamic-execution--run-and-exec)
15. [Orbit Bot Commands](#orbit-bot-commands)
16. [Control Flow](#control-flow)
17. [Variables & Reassignment](#variables--reassignment)
18. [Throwing Errors from Script — throw](#throwing-errors-from-script--throw)
19. [Structured Error Handling — run{} onThrow{} onFinish{}](#structured-error-handling--run-onthrow-onfinish)
20. [Error Code Reference](#error-code-reference)
21. [Errors & Failure Modes](#errors--failure-modes)
22. [Tab Targeting & Limitations](#tab-targeting--limitations)
23. [Voice (TTS)](#voice-tts)
24. [Memory (Chat Only)](#memory-chat-only)
25. [Browser Agent — Paged Reading](#browser-agent--paged-reading)
26. [Settings](#settings)
27. [Permissions](#permissions)
28. [Saved Scripts](#saved-scripts)
29. [Example Scripts](#example-scripts)
30. [Tips & Tricks](#tips--tricks)

---

## Installation

1. Open `icons/generate_icons.html` in Chrome — it downloads icon files automatically. Move them to `icons/`.
2. Go to `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select this folder.
3. Pin the ORBIT icon from the Extensions toolbar.
4. Click it to open the side panel.
5. Go to **Settings** and paste your Groq API key.

---

## Architecture & Privacy

ORBIT runs entirely inside Chrome. No cloud backend, no relay server, no data collection.

```
┌─────────────────────────────────────────────────────────┐
│  Chrome Browser                                         │
│                                                         │
│  ┌──────────────┐    ┌─────────────────────────────┐   │
│  │  Side Panel  │◄───│  Background Service Worker  │   │
│  │  (app.js)    │    │  (worker.js)                │   │
│  └──────┬───────┘    └────────────┬────────────────┘   │
│         │                         │                     │
│         ▼                         ▼                     │
│  ┌──────────────┐    ┌───────────────────────────┐     │
│  │ OBT Engine   │    │  Content Scripts          │     │
│  │ sandbox.html │    │  orbit-bot.js             │     │
│  │ ($exec)      │    │  browser-agent.js         │     │
│  └──────────────┘    │  page-reader.js           │     │
│                       └───────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
         │                         │
         ▼                         ▼
   ┌───────────┐           ┌─────────────┐
   │ Groq API  │           │ Tavily API  │
   └───────────┘           └─────────────┘
```

| Component | Runs in | Can access |
|-----------|---------|------------|
| Side panel (app.js) | Extension page | UI, chrome.storage, messages |
| Background worker | Service worker | All Chrome APIs |
| OBT engine | Inside side panel | Extension APIs via worker |
| sandbox.html | Sandboxed iframe | eval(), Math, JSON, Date — no DOM |
| Content scripts | Inside web pages | Page DOM |

---

## API Key Storage & Security

Your Groq and Tavily API keys are stored in **`chrome.storage.local`** only — private to ORBIT, never uploaded, cleared on uninstall. They are read at call time inside the background service worker and sent only to their respective API endpoints (`api.groq.com`, `api.tavily.com`).

---

## What Gets Sent to Groq

**Sent:** your chat message, conversation history, system prompt (if configured), current page text (only when you explicitly ask ORBIT to read the page), memory snippets (only when ORBIT retrieves a relevant one), Reddit post data (only when you scan Reddit).

**Never sent:** your browsing history, pages you haven't asked about, your saved scripts, anything from other tabs, your API keys (they are request headers, not message content).

---

## Chat Mode

Switch to the **Chat** tab and type naturally. ORBIT detects intent automatically.

| What you say | What happens |
|---|---|
| `go to github.com` | Navigates the current tab |
| `click the Sign In button` | Browser agent clicks it |
| `fill the search box with "orbit"` | Agent types in the field |
| `summarize this page` | Reads and summarises the current tab |
| `search the web for AI news` | Tavily research, then answers |
| `scan Reddit` | Opens Reddit, scans posts matching your profile, shows results in the Inbox tab |
| `remember that my timezone is UTC+1` | Saves to persistent memory |
| `what do you know about me?` | Retrieves relevant memories |

When the agent gets stuck mid-task it asks you a question in chat. Type `retry`, `skip`, `stop`, or just describe what to do next.

---

## Script Tab

Click the **Script** tab. The editor, console, AI generator, and script library are all here.

**Keyboard shortcuts:** `Ctrl+Enter` / `Cmd+Enter` to run, `Escape` to stop.

**AI generator:** type a description in the AI box at the bottom and hit **AI**. The generated script is inserted into the editor — review it before running. The directive guard ensures the first line is always correct `"use obt";` regardless of what the AI produced.

---

## The "use obt"; Directive

Every OBT script must start with exactly:

```
"use obt";
```

Rules:
- Must be the first non-empty line
- Must have double quotes and a trailing semicolon
- `"use js";` switches to JavaScript mode (different — see [$exec vs use js](#exec-vs-use-js))

The New Script button and AI generator add this automatically. If the AI produces a malformed directive (`obt;`, `use obt;`, `"use obt"` without semicolon, or omits it entirely), the directive guard corrects it before inserting the code.

---

## OBT Script Language Reference

### Basic syntax

One statement per line, or separate with `;`. Blocks use `{ }`. Comments start with `#` or `//`.

```
"use obt";

navigate "https://example.com";
wait 2;
# This is a comment
say "Page loaded";
```

### Strings

```
say "Double quoted";
say 'Single quoted';
say "Escaped \"quotes\"";
```

### Numbers and booleans

```
wait 2.5;
var active = true;
var count  = 42;
var none   = null;
```

---

## Expression Grammar

Full operator reference — everything the OBT expression evaluator supports:

| Operator | Types | Example | Notes |
|----------|-------|---------|-------|
| `+` | number+number → number | `3 + 4` → `7` | |
| `+` | anything+anything → string | `"a" + {$n}` | If either side is not a number — `"5" + 3` → `"53"`, not `8` |
| `-` `*` `/` `%` | number | `10 / 4` → `2.5` | Division by zero throws `DivisionByZeroError` (#5) |
| `==` | any | `{$x} == 5` | Loose equality (like JS `==`) |
| `!=` | any | `{$x} != null` | |
| `<` `>` `<=` `>=` | number / string | `{$n} >= 10` | |
| `and` | any → **bool** | `seeText "A" and seeText "B"` | Short-circuits; always returns `true`/`false`, not the operand value (unlike JS `&&`) |
| `or` | any → **bool** | `seeText "A" or seeText "B"` | Short-circuits; always returns `true`/`false`, not the operand value (unlike JS `\|\|`) |
| `not` | any | `not seeText "Error"` | Prefix unary |
| `-` (unary) | number | `var neg = -{$n}` | Prefix unary |

**Truthiness:** `false`, `null`, `0`, `""`, and `[]` are falsy. Everything else is truthy.

**Interpolation:** `{$varName}` embeds a variable anywhere in a string or expression — inside quoted strings or as a standalone value. `{$obj.prop}` accesses one level of property. Interpolation is resolved at runtime so every `{$var}` in a string always reflects the current value of that variable.

**No `===`:** use `==`. Loose equality is intentional for OBT's duck-typed values.

---

## Built-in Command Reference

### Navigation

```
navigate "https://example.com";   # aliases: goto, open
wait 2;                            # seconds (decimals ok)
```

### Scrolling

```
scrollDown 1;   # 1 = one viewport height
scrollUp 0.5;
```

### Clicking

On no match: **throws** `ElementError` (#40) after a 3-second retry window.

```
click "Continue";
click --type text "Sign in";
click --type id "submit-btn";
click --type selector "button.primary";
rightClick "Options";              # aliases: right-click, contextClick
```

### Focus and typing

```
focus "Search";
focus --type selector "input[name='q']";
type "Hello world";
type "text" speed 0.05;           # seconds per char
press Enter;                       # also: Escape, Tab, Control+L, Shift+Home …
```

### Drag

```
drag 500 300 "Draggable item";
drag 500 300 --type selector ".handle";
```

Coordinates are **viewport** pixels (0,0 = top-left of the visible window).

### Page text inspection

```
seeText "Dashboard";       # returns true/false — never throws
textContain "error";       # partial match, case-insensitive
findText "Continue";       # see below
```

`findText` returns `{ found: true, text: string, tag: string, truncated: bool }` when a match is found, or `{ found: false }` when not. `text` is the element's text content **truncated to 200 characters** — if the element's text is longer, `truncated` is `true`. `tag` is the HTML tag name in lowercase.

> **200-char cap:** if you are matching against a long paragraph, the text returned may be cut off. Use `seeText` or `textContain` for existence checks on long text; use `findText` when you need the tag name or a short snippet.

```
var r = $run(findText "Continue");
if {$r.found} {
    say "Found in a {$r.tag}: {$r.text}";
} else {
    say "Not found";
}
```

Both `seeText` and `textContain` are **case-insensitive**.

### Data retrieval — `get`

On no match: `count` returns `0`; `exists` returns `false`; all others **throw** `GetError` (#50).
`text` on an empty element returns `""` (empty string), not `null`.

```
get --type text      --target selector "h1"
get --type value     --target selector "input[name='q']"
get --type count     --target selector ".item"    # 0 if none
get --type exists    --target selector "#modal"   # true/false, never throws
get --type visible   --target selector ".banner"  # true/false
get --type attribute --target selector "a" --attribute "href"
get --type href      --target selector "a.home"
get --type innerHTML --target selector ".card"
```

### Element position — `getPos`

Returns `{ x, y, width, height, centerX, centerY }` in **document** coordinates (includes scroll offset). On no match: **throws** `GetError` (#50).

```
var pos = $run(getPos --type selector "button");
say "Button is at document position {$pos.x}, {$pos.y}";
```

### Debug

```
log "hello";            # aliases: print, debug
log {$myVar};
assert {$found} "Expected element to exist";   # throws AssertionError (#90) if falsy
```

---

## String Utilities

All string utilities are used inside `$run()`.

| Command | Signature | Case-sensitive? | Notes |
|---------|-----------|----------------|-------|
| `split` | `split delim str` | yes | returns array |
| `join` | `join delim array` | — | returns string |
| `length` | `length value` | — | works on string or array |
| `trim` | `trim str` | — | strips whitespace |
| `lowercase` | `lowercase str` | — | |
| `uppercase` | `uppercase str` | — | |
| `replace` | `replace find replacement str` | yes | replaces all occurrences |
| `contains` | `contains needle haystack` | **no** | case-insensitive |

**`replace` argument order:** `find` first, then `replacement`, then the `str` to modify.
```
var result = $run(replace "old" "new" "old value, old thing");
# → "new value, new thing"
```

**`contains` is case-insensitive:**
```
var found = $run(contains "orbit" "ORBIT automation");  # → true
```

---

## Dialog Commands

These pause the script and show a styled overlay in the side panel. The user must respond before the script continues.

### `alert`
Shows a message and waits for OK. Returns `null`.
```
alert "Backup complete.";
```

### `confirm`
Shows a Yes/No dialog. Returns `true` (Yes) or `false` (No/Cancel).
```
var ok = $run(confirm "Delete all items?");
if {$ok} {
    say "Deleting…";
} else {
    say "Cancelled.";
}
```

### `prompt`
Shows a text input. Returns the string the user typed, or `null` if they click Cancel.
```
var name = $run(prompt "What is your name?");
if {$name} {
    say "Hello, {$name}!";
} else {
    say "No name entered.";
}
```

Enter submits, Escape cancels.

---

## AI Commands — ask

`ask` calls ORBIT's AI from inside a script and returns the text response as a string. It is stateless — no memory read/write, no chat history, no UI side effects.

```
var answer = $run(ask "What is the boiling point of water?");
say {$answer};
```

**`--page`** reads the current tab and passes its text as context:
```
navigate "https://en.wikipedia.org/wiki/JavaScript";
wait 2;
var info = $run(ask "Give me three key facts" --page);
log {$info};
```

**`--agent`** runs the full browser agent and returns its final DONE message:
```
var result = $run(ask "Find the population of France on Wikipedia" --agent);
say {$result};
```

**Failure modes:**
- If the agent fails, times out, or is stopped → **throws** `AskError` (#70) with a descriptive message.
- If `--page` cannot read the tab → **throws** `AskError` (#70) with the reason.
- If no Groq API key is set → **throws** `ApiKeyError` (#71) immediately.
- If the Groq API returns an error response → **throws** `ApiError` (#72).

| Feature | ask | Full chat |
|---------|-----|-----------|
| Same AI model | ✓ | ✓ |
| Auto Tavily research | ✓ | ✓ |
| `--page` | ✓ | ✓ |
| `--agent` | ✓ | ✓ |
| Memory | ✗ | ✓ |
| Chat history | ✗ | ✓ |
| UI side effects | ✗ | ✓ |
| Return value | string | — |

---

## Dynamic Execution — $run() and $exec()

### $run()

Executes any OBT command and returns its value. Return value is always the last expression in the command.

```
var title = $run(get --type text --target selector "h1");
var found = $run(seeText "Continue");        # true/false
var ok    = $run(confirm "Ready?");          # true/false
var name  = $run(prompt "Your name:");       # string/null
var ans   = $run(ask "What is 2+2?");        # string
```

`$run(sequence { ... })` returns the last evaluated expression. `sequence{}` can be nested inside `run{}`, `if{}`, loops, and other blocks. Note: `throw` is a statement and **cannot** appear inside `$run()` — use it at statement level only:
```
var result = $run(sequence {
    wait 1;
    get --type text --target selector "h1";   # last expression = return value
});

# sequence inside run{} — perfectly valid
run {
    var title = $run(sequence {
        wait 1;
        get --type text --target selector "h1";
    });
    say {$title};
}
onThrow {
    say "Failed: {$throwID}";
}
```

### $exec()

Runs JavaScript in ORBIT's **sandboxed iframe** (`scripting/sandbox.html`). Chrome grants sandboxed pages a relaxed CSP so `eval()` is permitted — the only MV3-compliant way to run user code. Has full JavaScript but **no DOM access**.

```
var result = $exec("Math.round(3.7)");
var today  = $exec("new Date().toLocaleDateString('en-US')");
var upper  = $exec("'hello world'.toUpperCase()");
var data   = $exec("JSON.parse('{\"count\":5}').count");
```

**Multi-line — `return` required:**
```
var avg = $exec("
    const a = [1, 2, 3, 4, 5];
    return a.reduce((s, x) => s + x, 0) / a.length;
");
```

**`console.log` streams to the script console:**
```
$exec("console.log('debug:', 42); return 'done'");
```

#### Safe args — avoid string concatenation

**Never** build `$exec` code by concatenating page-derived values:
```
# ✗ FOOTGUN
var n = $exec("parseFloat('" + {$price} + "')");
```

Instead, pass values as named args — the second argument is an object literal:
```
# ✓ SAFE — variable value
var n = $exec("return parseFloat(price.replace('$',''))", { price: {$price} });

# ✓ SAFE — hard-coded values work too, no interpolation required
var n = $exec("return count * factor", { count: 5, factor: 1.2 });

# ✓ SAFE — mix of literal and variable
var n = $exec("return val.toFixed(digits)", { val: {$raw}, digits: 2 });
```

The object literal syntax `{ key: value }` is available **only** inside `$exec()` as its args parameter. It is not a general OBT value type — you cannot assign `var obj = { a: 1 }` in OBT script.

#### $exec vs "use js"

`$exec()` runs in the **sandboxed iframe** (no DOM, pure JS logic). `"use js";` mode runs via `chrome.scripting.executeScript` in an **isolated world inside the active tab** — it has DOM access but no page globals. Use `$exec` for computation; use `"use js";` for raw DOM work.

---

## Orbit Bot Commands

### Expressions
```
happyFace;   sadFace;   frownFace;
```

### Eyes / mouth
```
closeOrbitEyes;   openOrbitEyes;
openMouth;        closeMouth;
```

### Animations
```
shakeOrbit;   rollOrbit;   cry;   laugh;
```
Aliases: `shake` = `shakeOrbit`, `roll` = `rollOrbit`.

### Movement
```
move 100 50;    # viewport coordinates (0,0 = top-left)
look 0;         # up    look 90;  # right
look 180;       # down  look 270; # left
```

### Show / hide
```
hide;   showBot;   # aliases: show, showOrbit
```

### Speech
```
say "Hello, I am Orbit";
say --voice 2 "With a different voice";
voiceList;   # prints all available TTS voices to console
```

**`say` blocks** until speech ends. The block is backed by the actual `utter.onend` event, with a safety timeout based on text length.

---

## Control Flow

```
if seeText "Dashboard" {
    say "Logged in";
} else if not seeText "Dashboard" {
    say "Not there yet";
} else {
    say "Not logged in";
}

until seeText "Dashboard" { wait 1; }
while seeText "Loading"   { wait 1; }

repeat 5 {
    scrollDown 1;
    wait 0.5;
}

repeat 20 {
    scrollDown 1;
    if seeText "Load more" { click "Load more"; }
    if seeText "End"       { break; }
}
```

### break and continue

`break` exits the current loop immediately. `continue` skips the rest of the current iteration and moves to the next one. Both work inside `while`, `until`, and `repeat`.

```
repeat 10 {
    var exists = $run(get --type exists --target selector ".item");
    if not {$exists} { continue; }   # skip iterations where .item is absent
    click ".item";
    if seeText "Done" { break; }     # stop as soon as we see "Done"
}
```

Using `break` or `continue` outside a loop throws `ControlFlowError` (#7) — this is always a script bug. `ControlFlowError` is a fatal error and cannot be caught by `onThrow`.

All loops check for cancellation on every iteration. Hitting ■ Stop ends the loop promptly.

---

## Variables & Reassignment

### Declaring variables

All variables must be declared with `var` before use:

```
var count = 0;
var name  = "Orbit";
var found = false;
var data  = null;
```

### Scope rules

`var` always creates a new binding **in the current block's scope**. A `var` inside `if{}`, `while{}`, `onThrow{}`, or any other block does not affect a variable of the same name in an outer scope:

```
var x = 1;
if true {
    var x = 99;   # new binding — shadows outer x inside this block only
}
# x is still 1 here
```

### Reassignment without var

To mutate a variable declared in an outer scope, use bare assignment — `name = value` with no `var`:

```
var count = 0;
repeat 5 {
    count = count + 1;   # updates the outer count — no var
}
say "Count: {$count}";   # → "Count: 5"
```

The variable **must already exist** (declared with `var` in an enclosing scope). Assigning to an undeclared name throws `UndefinedVariableError` (#20):

```
# ✗ throws UndefinedVariableError — myVar was never declared
myVar = 42;

# ✓ correct
var myVar = 0;
myVar = 42;
```

Bare reassignment walks up the scope chain to find the nearest existing binding — the same way JavaScript `let` works (but OBT has no `const`).

### Reassignment across block boundaries

This is the key use case — updating a variable from inside `onThrow{}` so `onFinish{}` can read it:

```
var lastError = null;
run {
    click "#submit";
}
onThrow {
    lastError = {$throwID};   # bare reassignment — updates outer lastError
}
onFinish {
    if {$lastError} {
        say "Finished with error: {$lastError}";
    } else {
        say "Finished successfully";
    }
}
```

## Throwing Errors from Script — throw

User scripts can raise typed errors deliberately using `throw`. This is useful for input validation, bailing on a business condition, or signalling a specific error type to a caller's `onThrow` handler.

### Syntax

```
throw N "message";              # throw by number — literal integer
throw ErrorID "message";        # throw by registered ID — bare identifier
throw {$throwNumber} "message"; # throw by variable value — number or string
throw {$throwID} "message";     # throw by variable value — string ID
```

The code position accepts a number literal, a bare identifier (treated as an error ID string, never a variable lookup), or a `{$var}` interpolation. When `{$var}` is used, the runtime checks the value at execution time: if it is a number (or a numeric string like `"40"`), it is treated as a `throwNumber` lookup; otherwise it is treated as a `throwID` string lookup.

### Examples

```
# Throw by number
throw 40 "Button not found — check the selector";

# Throw by registered ID name (bare identifier, not quoted)
throw ElementError "No submit button on this page";

# Throw a custom registered code
throw 200 "Business rule violated: cart is empty";

# Throw with no message
throw AssertionError;

# Catch it in an outer run{} block
run {
    var qty = $run(get --type text --target selector ".qty");
    if {$qty} == "0" {
        throw 200 "Cart is empty";
    }
    click "#checkout";
}
onThrow.throwNumber(200) {
    say "Cannot check out: {$throwID}";
}
onThrow.throwID(ElementError) {
    say "Page element missing";
}
```

### Re-raise inside onThrow{}

`throw` works inside `onThrow{}` — this is how you re-raise an error for a caller to handle, or replace it with a different typed error:

```
run {
    run {
        click "#submit";
    }
    onThrow {
        log "Inner caught: {$throwID} (#{$throwNumber})";
        throw {$throwNumber} "re-raised by inner handler";  # re-raise same code
    }
}
onThrow {
    say "Outer sees: {$throwID}";   # catches the re-raised error
}
```

### Message interpolation

String interpolation works normally in the message — `{$var}` is expanded at runtime:

```
var itemId = $run(get --type text --target selector ".item-id");
throw 200 "Item {$itemId} failed validation";

# Inside onThrow the captured vars are available too
onThrow {
    throw {$throwNumber} "Rethrown from handler: expected success but got {$throwID}";
}
```

### throw at top level

`throw` without any enclosing `run{}` block terminates the script with the thrown error logged to the console — the same as any unhandled error:

```
"use obt";
var qty = $run(get --type text --target selector ".qty");
if {$qty} == "0" {
    throw 200 "Cart is empty";   # terminates the script
}
```

### throw is a statement, not a command

`throw` cannot appear inside `$run()` — it is a statement, not a command. `$run(throw 40 "x")` is a parse error. Use `throw` at statement level only.

### Unregistered code asymmetry

- `throw 5000 "msg"` (unregistered number) → `throwNumber = 5000`, `throwID = "UnknownError"`  
  `onThrow.throwNumber(5000)` **will** catch it because the number is preserved.
- `throw NotRegistered "msg"` (unregistered ID string) → `throwNumber = 10000`, `throwID = "UnknownError"`  
  Both the original ID and number are lost. `onThrow.throwID(NotRegistered)` will **not** catch it.  
  `onThrow.throwID(UnknownError)` **will** catch it — which means a bare `onThrow{}` watching for `"UnknownError"` as engine bugs will also catch user-thrown unregistered IDs. Use `{$throwNumber}` to distinguish them.

If you need a custom catchable ID, register it first:
```javascript
// In your extension setup:
scriptManager.throwRegistry.register(200, 'CartError');
```
Then `throw CartError "msg"` produces `throwNumber = 200`, `throwID = "CartError"` — fully round-trippable.

### Rules

- **Fatal error codes cannot be thrown from user script.** Attempting to throw `TimeoutError` (#1), `NestingError` (#2), `LoopLimitError` (#4), `ControlFlowError` (#7), or `BrowserCancelledError` (#33) raises `RuntimeError` (#3) instead.
- A thrown error is catchable by any enclosing `run{} onThrow{}` block, just like a command error. If uncaught, it terminates the script.
- The message is optional — `throw ElementError;` is valid and the message defaults to the error ID string (e.g. `"ElementError"`).

## Structured Error Handling — run{} onThrow{} onFinish{}

OBT's structured error handling uses three keywords — `run`, `onThrow`, and `onFinish` — that work together like try/catch/finally but fit naturally into OBT's syntax.

> **`run{}` vs `$run()`** — completely different things.
> `$run(command ...)` executes a command and **returns its value**. Unchanged, always worked this way.
> `run { ... }` (no `$`, uses `{}`) is a **statement block** with optional error-handling clauses.
> `run{}` is a statement — it cannot be assigned (`var x = run{...}` is not valid) and cannot be
> passed to `$run()`. Use `$run(sequence { ... })` if you need a block that returns a value.

### Basic usage

```
run {
    click "#submit";
    wait 1;
}
```

A bare `run { }` with no clauses runs the body and propagates any error exactly as if the block wasn't there. It becomes useful once you add `onThrow` or `onFinish`.

### Catching errors — onThrow

```
run {
    click "#submit";
}
onThrow {
    say "Something went wrong: {$throwID}";
    log "Error code: {$throwNumber}";
}
```

Inside `onThrow { }` two variables are automatically in scope:

| Variable | Type | Value |
|----------|------|-------|
| `throwNumber` | number | Numeric error code — see [Error Code Reference](#error-code-reference) |
| `throwID` | string | Error class name (e.g. `"ElementError"`, `"NavigationError"`) |

`throwNumber` and `throwID` are scoped **only to the `onThrow` block**. They are not available in `onFinish{}` and are not defined after the `run{}` block exits.

To pass the error ID into `onFinish{}`, declare a variable with `var` **before** the `run{}` block, then reassign it (without `var`) inside `onThrow{}`:

```
var lastErr = null;
run {
    click "#submit";
}
onThrow {
    lastErr = {$throwID};   # reassignment — no var — updates the outer binding
}
onFinish {
    say "Finished. Error (if any): {$lastErr}";
}
```

**`var` inside a block always creates a new binding in that block's scope and does not affect outer variables.** To mutate an outer variable, use bare reassignment (`name = value` with no `var`). The variable must already exist (declared with `var` in an enclosing scope); assigning to an undeclared name throws `UndefinedVariableError` (#20).

The script continues normally after the `onThrow` block — the error is considered handled.

**If `onThrow{}` itself throws:** the body's original error (A) is logged to the console, and the `onThrow` error (B) propagates as the new pending error. `onFinish{}` still runs before B escapes. B is a new, fully typed error with its own `throwNumber` and `throwID`.

### Only one onThrow clause per run{}

Each `run{}` block accepts exactly **one** `onThrow` clause. Having two `onThrow` clauses on the same `run{}` is a **parse error**. To handle different error types differently, use nested `run{}` blocks:

```
# ✗ Parse error — two onThrow clauses on the same run{}
run {
    click "#btn";
}
onThrow.throwID(ElementError) { say "not found"; }
onThrow.throwID(NavigationError) { say "bad url"; }   # ERROR

# ✓ Correct — nested run{} blocks
run {
    run {
        navigate "https://bad-url";
    }
    onThrow.throwID(NavigationError) {
        say "Bad URL — skipping";
    }
    click "#btn";
}
onThrow.throwID(ElementError) {
    say "Button not found";
}
```

### Filtering by error number

```
run {
    click "#risky-button";
}
onThrow.throwNumber(40) {
    say "Element not found";
}
```

`onThrow.throwNumber(N)` only catches errors whose `throwNumber` equals `N`. Errors with a different number are **not caught** and still propagate.

### Filtering by error ID

```
run {
    navigate "https://bad-url";
}
onThrow.throwID(NavigationError) {
    say "Navigation failed — {$throwID}";
}
```

`onThrow.throwID(name)` only catches errors whose `throwID` matches the given name — **exact, case-sensitive match**. Bare identifiers like `NavigationError` are always treated as **string literals** — they are never evaluated as variable references. Quotes are optional:

```
onThrow.throwID("NavigationError") { ... }   # identical to throwID(NavigationError)
```

Dynamic filtering based on a variable is **not supported**:

```
var myErr = "NavigationError";
onThrow.throwID(myErr) { ... }   # ✗ does NOT match NavigationError — matches the literal "myErr"
```

If you need to branch on error type dynamically, read `{$throwID}` inside a plain `onThrow{}` and use `if`:

```
run {
    navigate "https://bad-url";
}
onThrow {
    if {$throwID} == "NavigationError" {
        say "Bad URL";
    }
    if {$throwID} == "ElementError" {
        say "Not found";
    }
}
```

### Always-run cleanup — onFinish

```
run {
    navigate "https://example.com";
    click "#start";
}
onThrow {
    say "Failed: {$throwID}";
}
onFinish {
    say "Done — cleanup here";
}
```

`onFinish { }` runs **whether the body succeeded or threw**, like `finally` in JavaScript. It runs even without an `onThrow` clause:

```
run {
    click "#download";
}
onFinish {
    say "Download attempt finished";
}
```

**`throwNumber` and `throwID` are NOT in scope inside `onFinish{}`** — by the time `onFinish` runs, the error has already been handled (or is pending propagation). If you need to log the error in cleanup, declare a variable before the `run{}` and use bare reassignment (no `var`) inside `onThrow{}`:

```
var lastErr = null;
run {
    click "#submit";
}
onThrow {
    lastErr = {$throwID};   # bare reassignment — updates the outer var, not a new binding
}
onFinish {
    say "Finished. Last error: {$lastErr}";
}
```

**`onFinish` does not support filters.** `onFinish.throwNumber(N)` is a parse error — `onFinish` always runs unconditionally.

**If `onFinish{}` itself throws:** when the body also threw an error, the original body error is preserved and re-thrown; the `onFinish` error is logged to the console (as `#N ID: …`) but does not replace the original. When only `onFinish` throws (body succeeded), that error propagates normally.

**Cancellation inside `onFinish{}`:** if the user presses ■ Stop while `onFinish{}` is running, `BrowserCancelledError` is re-raised immediately from inside `onFinish` — the rest of the `onFinish` block is skipped. There is no grace period. If you need guaranteed cleanup regardless of cancellation, use `$exec()` with pure JS logic (which does not check the cancellation flag).

### Combining all three

```
run {
    navigate "https://example.com";
    var title = $run(get --type text --target selector "h1");
    say {$title};
}
onThrow.throwNumber(32) {
    say "No tab open — please open a web page first";
}
onFinish {
    say "Script block complete";
}
```

### What happens when a filter doesn't match

If you use `onThrow.throwNumber(N)` or `onThrow.throwID(name)` and the actual error has a different code/id, the error **is not caught** — it propagates up exactly as if there were no `onThrow` clause. `onFinish` still runs before the error escapes.

### Nesting run{} blocks

```
run {
    run {
        click "#risky";
    }
    onThrow {
        say "Inner error: {$throwID} — trying fallback";
        click "#fallback";
    }
    say "continuing outer block";
}
onThrow {
    say "Outer error: {$throwID}";
}
onFinish {
    say "All done";
}
```

### Summary table

| Clause | Required | Runs when |
|--------|----------|-----------| 
| `run { }` | yes | Always — this is the body |
| `onThrow { }` | no | Body threw any catchable error |
| `onThrow.throwNumber(N) { }` | no | Body threw a catchable error with that number |
| `onThrow.throwID(name) { }` | no | Body threw a catchable error with that name |
| `onFinish { }` | no | Always, after body and after onThrow (if any) |

### Fatal errors — cannot be caught

Some errors are **engine-level guards** that bypass all `onThrow` clauses unconditionally and terminate the script immediately. No user code can intercept them:

| Error | # | Why it must be fatal |
|-------|---|----------------------|
| `BrowserCancelledError` | 33 | ■ Stop pressed — user intent to halt; catching it would make Stop unreliable |
| `TimeoutError` | 1 | Script time limit exceeded — catching it defeats the timeout guard |
| `LoopLimitError` | 4 | Iteration guard — catching it inside the loop body would allow infinite loops |
| `NestingError` | 2 | Nesting depth guard — catching it would allow arbitrarily deep recursion |
| `ControlFlowError` | 7 | `break`/`continue` outside a loop — always a script bug, not a runtime condition |

`onFinish{}` still runs after a fatal error before the script terminates.

`LexError` (#10) and `ParseError` (#11) happen **before execution begins** — no `run{}` block is active when they fire, so they can never be caught regardless.

```
# ✗ This does NOT work — BrowserCancelledError bypasses onThrow
run {
    repeat 1000 { click "Next"; wait 1; }
}
onThrow {
    say "Caught!";   # never reached when user presses ■ Stop
}

# ✗ This does NOT work — TimeoutError bypasses onThrow
run {
    repeat 1000 { navigate "https://example.com"; wait 2; }
}
onThrow.throwNumber(1) {
    say "Timed out";  # never reached
}
```

---

## Error Code Reference

Every error thrown inside OBT has a numeric `throwNumber` and a string `throwID`. Use these in `onThrow.throwNumber()` and `onThrow.throwID()` filters, or read them from `{$throwNumber}` and `{$throwID}` inside an `onThrow` block.

### Engine errors (1–9)

Errors marked **fatal** bypass all `onThrow` clauses and terminate the script unconditionally.

| # | ID | Fatal? | When |
|---|----|----|---|
| 1 | `TimeoutError` | **yes** | Script exceeded the configured time limit |
| 2 | `NestingError` | **yes** | Block nesting exceeded the depth limit (default: 64). Error message includes the current depth and block type that exceeded it (e.g. `"depth 65 exceeds limit 64 at while"`) |
| 3 | `RuntimeError` | no | Unknown AST node, unrecognised operator, or attempted `throw` of a fatal error code from user script |
| 4 | `LoopLimitError` | **yes** | `while`/`until`/`repeat` hit max iterations (default: 1000) |
| 5 | `DivisionByZeroError` | no | Division by zero in an expression |
| 6 | `NullAccessError` | no | Property access on a null or undefined value |
| 7 | `ControlFlowError` | **yes** | `break` or `continue` used outside a loop |

### Lex & parse errors (10–19)

These fire **before execution begins**. No `run{}` block is executing when they occur, so they can never be caught by `onThrow` regardless of whether they are marked fatal.

| # | ID | Fatal? | When |
|---|----|----|---|
| 10 | `LexError` | pre-exec | Invalid character or malformed `{$` token |
| 11 | `ParseError` | pre-exec | Unexpected token, invalid grammar, or two `onThrow` clauses on one `run{}` |

### Variable & command errors (20–29)

| # | ID | Fatal? | When |
|---|----|----|---|
| 20 | `UndefinedVariableError` | no | `{$varName}` that was never declared with `var` |
| 21 | `UnknownCommandError` | no | Command name not found in the registry |
| 22 | `CommandError` | no | A command's internal code threw a plain `new Error()` with no typed subclass. Commands that throw a typed error (e.g. `ElementError`) pass it through directly; `CommandError` only wraps truly untyped failures |

### Navigation & browser errors (30–39)

**`NoBrowserError` (#30) vs `NoTabError` (#32):** `NoBrowserError` fires when the browser adapter object itself is not available — this means the extension context is broken or the command is being called somewhere the adapter was never initialised. `NoTabError` fires when the adapter exists but cannot find a usable tab to send the command to (all open tabs are `chrome://` pages, the PDF viewer, or the Web Store). In practice: if you have a normal web page open and a script fails, it is almost always `NoTabError`.

| # | ID | Fatal? | When |
|---|----|----|---|
| 30 | `NoBrowserError` | no | Browser adapter object not initialised — extension context broken |
| 31 | `NavigationError` | no | URL is invalid or cannot be parsed |
| 32 | `NoTabError` | no | Adapter exists but no accessible browser tab found |
| 33 | `BrowserCancelledError` | **yes** | ■ Stop pressed or browser operation explicitly aborted |
| 34 | `BrowserResponseError` | no | Content script returned an error payload |

### Element interaction errors (40–49)

| # | ID | Fatal? | When |
|---|----|----|---|
| 40 | `ElementError` | no | Target selector/text not found after retry window, or target argument missing |
| 41 | `DragError` | no | Invalid drag coordinates |
| 42 | `ScrollError` | no | Scroll command failure |
| 43 | `TypeError` | no | `type`/`fill` command failure. **Note:** this is OBT's `TypeError` for the `type` command — it is unrelated to JavaScript's built-in `TypeError`. A JS `TypeError` thrown inside `$exec()` would surface as `ExecError` (#80). |
| 44 | `HoverError` | no | Hover command failure |

### Data retrieval errors (50–59)

| # | ID | Fatal? | When |
|---|----|----|---|
| 50 | `GetError` | no | `get` or `getPos` could not find or read the target element. `get --type count` and `get --type exists` never throw — they return `0` / `false` instead. |

### Dialog errors (60–69)

| # | ID | Fatal? | When |
|---|----|----|---|
| 60 | `DialogError` | no | `alert`/`confirm`/`prompt` not available in this context |

### AI / ask errors (70–79)

| # | ID | Fatal? | When |
|---|----|----|---|
| 70 | `AskError` | no | General `ask` failure — bad prompt, agent error, unreadable page |
| 71 | `ApiKeyError` | no | No Groq API key configured |
| 72 | `ApiError` | no | Groq API returned an HTTP error |

### JS execution errors (80–89)

| # | ID | Fatal? | When |
|---|----|----|---|
| 80 | `ExecError` | no | `$exec` code threw a JavaScript error |
| 81 | `NoJsRunnerError` | no | JS runner not available |

### Assertion & wait errors (90–99)

| # | ID | Fatal? | When |
|---|----|----|---|
| 90 | `AssertionError` | no | `assert` — the value was falsy |
| 91 | `WaitError` | no | `wait` was given an invalid (non-numeric or negative) value |

### Registry errors (100–109)

| # | ID | Fatal? | When |
|---|----|----|---|
| 100 | `RegistryError` | no | Bad command registration (duplicate name, missing fields) |

### Fallback (10000)

| # | ID | Fatal? | When |
|---|----|----|---|
| 10000 | `UnknownError` | no | Any error whose constructor name is not registered — a JS bug, a third-party error, or an unhandled engine path. If you catch `UnknownError` in an `onThrow{}`, always log `{$throwID}` and consider what caused it — catching bare `onThrow{}` without checking `{$throwID}` can silently swallow bugs. |

**`CommandError` (#22) vs `UnknownError` (#10000):** when a command's `execute()` function throws, the engine checks whether the thrown error is a typed subclass (e.g. `ElementError`, `GetError`). If it is, that error passes through unchanged. If it is a plain `new Error("message")` with no subclass, it is wrapped as `CommandError` (#22). `UnknownError` (#10000) is only assigned when the error's constructor name does not appear in the registry at all — for example, a third-party library throwing its own error class.

### Registering custom error codes

Developers integrating with the OBT engine can register their own codes. Codes 101–9999 are reserved for extensions; codes ≥ 10001 are free for any use.

```javascript
// In your extension setup code:
scriptManager.throwRegistry.register(200, 'MyCustomError');
```

Then in OBT script:

```
onThrow.throwNumber(200) {
    say "Custom error caught: {$throwID}";
}
```

---

## Errors & Failure Modes

| Situation | Error | Fatal? |
|-----------|-------|--------|
| `click "X"` — element not found after ~3s retry | `ElementError` (#40) | no |
| `get --type text` — element not found | `GetError` (#50) | no |
| `get --type count` — nothing matches | Returns `0` — never throws | — |
| `get --type exists` — nothing matches | Returns `false` — never throws | — |
| `get --type text` — element exists but is empty | Returns `""` — never throws | — |
| `assert {$val} "msg"` — value is falsy | `AssertionError` (#90) | no |
| Loop hits max iterations | `LoopLimitError` (#4) | **yes** |
| Script exceeds total timeout | `TimeoutError` (#1) | **yes** |
| `$exec` code throws | `ExecError` (#80) | no |
| `ask --agent` — agent fails or times out | `AskError` (#70) | no |
| `ask --page` — page unreadable | `AskError` (#70) | no |
| No Groq API key | `ApiKeyError` (#71) | no |
| No open web page / no accessible tab | `NoTabError` (#32) | no |
| ■ Stop pressed | `BrowserCancelledError` (#33) | **yes** — bypasses all `onThrow` clauses |
| Unknown command name | `UnknownCommandError` (#21) with suggestions | no |
| Undefined variable `{$x}` | `UndefinedVariableError` (#20) | no |
| Division by zero | `DivisionByZeroError` (#5) | no |
| `break`/`continue` outside a loop | `ControlFlowError` (#7) | **yes** |
| Nesting depth exceeded (default 64) | `NestingError` (#2) | **yes** |

Additional failure modes:

| Command | On failure |
|---------|-----------|
| `navigate "bad"` | Throws `NavigationError` (#31) immediately if URL cannot be parsed |
| `navigate "https://…"` | Succeeds once navigation is sent — does not wait for page load; use `until seeText` or `wait` after |
| `focus "X"` | Throws `ElementError` (#40) if element not found after retry window |
| `rightClick "X"` | Throws `ElementError` (#40) if element not found |
| `drag x y "X"` | Throws `ElementError` (#40) if element not found; `DragError` (#41) for invalid coordinates |

Unhandled errors stop the script at the failing line. The console shows `#throwNumber throwID: message` plus line number and timestamp. Use `run { } onThrow { }` blocks for structured recovery (see [Structured Error Handling](#structured-error-handling--run-onthrow-onfinish)), or **pre-check with `get --type exists`** before actions that might fail:

```
var hasBtn = $run(get --type exists --target selector "#accept");
if {$hasBtn} { click --type selector "#accept"; }
```

---

## Tab Targeting & Limitations

**Which tab does a script act on?** The `lastFocusedWindow`'s active tab, excluding `chrome://` and `chrome-extension://` URLs. This is resolved at the time each command runs — if the user switches tabs mid-script, the next command acts on the new active tab.

**To pin a script to a specific tab:** not currently supported. Work around it by calling `navigate` at the start of your script.

**Pages that cannot be automated:**

| Page type | Reason |
|-----------|--------|
| `chrome://` pages | Chrome blocks content scripts on internal pages |
| Chrome Web Store | Blocked by Chrome policy |
| Extension pages (`chrome-extension://`) | Blocked by Chrome policy |
| PDFs opened in Chrome's built-in viewer | No DOM to inject into |
| Cross-origin iframes | Script runs in the top frame only |
| Pages with strict CSP | Content script injects but cannot message back |

If ORBIT cannot access the current tab, commands that need the page throw `NoTabError` (#32).

**Concurrency:**
- **Two scripts** cannot run simultaneously — clicking ▶ Run while a script is running is silently ignored.
- **Chat while a script runs** — processed normally; they do not share state.
- **Script while chat is responding** — runs immediately. If both make Groq calls simultaneously you may hit rate limits sooner.
- **Variable state** is not shared between separate script runs (each run gets a fresh environment).

---

## Voice (TTS)

ORBIT uses the browser's built-in `speechSynthesis` API. No network request, no API key.

**Settings → Voice (TTS):** enable/disable, voice picker, speed, pitch, volume, test button.

**In scripts:**
```
say "Hello, I am Orbit";          # blocks until speech ends
say --voice 2 "Different voice";  # pick by index from voiceList
voiceList;                         # prints voices to console
```

**Bubble sync:** the speech bubble appears when audio begins (`utter.onstart`) and disappears when it ends (`utter.onend`).

**Chrome stall fix:** `speechSynthesis.resume()` is called every 10 seconds while speaking to prevent Chrome's known stall bug on inactive extension pages.

Microphone input is not supported — Chrome blocks `SpeechRecognition` in extension pages.

---

## Memory (Chat Only)

Memory is a chat-only feature. You cannot read or write memories from scripts.

In chat, ORBIT remembers facts automatically when you tell it things:
- *"Remember that my timezone is UTC+1"*
- *"My name is Alex"*
- *"I prefer Python over JavaScript"*

ORBIT retrieves relevant memories automatically when they are useful. You can ask *"what do you know about me?"* to see stored facts.

Memory is stored in `chrome.storage.local` and never uploaded.

---

## Browser Agent — Paged Reading

The browser agent reads long pages using a **paged chunk system** instead of blind scrolling.

When the agent needs to read page content it calls `READ_CHUNK N`. The content script:
1. Walks the visible DOM and extracts all readable text
2. Splits it into ~1 800-character chunks
3. Scrolls the browser to that position (so you can watch what ORBIT is reading)
4. Returns the chunk with a status header: `Currently reading chunk 3 of 10 · Already read: 1, 2`

The agent can jump to any chunk, go next/prev, or re-read a chunk (the DOM is re-walked fresh each time so dynamic content is always current).

### Chunk Notes

The agent can save short notes while reading using `"note":"text"` in its JSON response. Notes persist across all chunk reads for the task, so data found in chunk 2 is available when reading chunk 8.

Notes are size-guarded: when total characters exceed **Max chunk note size** (Settings → Agent), the oldest note is evicted.

---

## Settings

### API Keys
| Setting | Description |
|---------|-------------|
| Groq API Key | Your Groq key (`gsk_…`). Stored locally. |
| Groq Model | Model ID for all AI calls. Default: `openai/gpt-oss-20b`. |
| Tavily API Key | Your Tavily key (`tvly-…`). Used for web research. |

### Script
| Setting | Default | Description |
|---------|---------|-------------|
| Script timeout | 300s | How long a script can run. Max 3 600s (1 hour). |
| Max loop iterations | 1 000 | Maximum iterations per while/repeat loop before `LoopLimitError`. |

### Agent
| Setting | Default | Description |
|---------|---------|-------------|
| Rate Caution | Normal | Random delay before each agent AI call. Low = 1–3s, Normal = 4–8s, High = 9–16s. |
| Max chunk note size | 800 chars | Total characters in agent notes before oldest is evicted. |

### Groq 429 / Rate Limit Behavior

| Call site | On 429 |
|-----------|--------|
| **Agent** (`ask --agent`) | Exponential back-off with jitter, up to 4 retries, max 30s wait. |
| **Chat** | No automatic retry — throws `ApiError` (#72) immediately. |
| **`ask` (non-agent)** | No automatic retry — throws `ApiError` (#72) as a script error. |

### Research
| Setting | Default | Description |
|---------|---------|-------------|
| Search depth | basic | `basic` or `advanced` Tavily depth. |
| Max results | 5 | Results per research query. |
| Auto-trigger research | off | Automatically run Tavily when AI signals it needs search. |

### Voice (TTS)
| Setting | Default | Description |
|---------|---------|-------------|
| Enable ORBIT voice | on | Whether ORBIT speaks replies. |
| Voice | Browser default | TTS voice. |
| Speed | 1.05× | Speaking rate (0.5–2.0). |
| Pitch | 1.0 | Pitch (0.5–2.0). |
| Volume | 1.0 | Volume (0–1.0). |

---

## Permissions

| Permission | Why |
|-----------|-----|
| `storage` | Saves settings, scripts, memory, and chat history locally |
| `activeTab` | Reads the current tab's URL and title |
| `scripting` | Injects content scripts and executes automation |
| `tabs` | Queries tab list to find the active web page |
| `sidePanel` | Displays the ORBIT side panel |
| `alarms` | Scheduled daily reminders |
| `notifications` | Desktop notifications for Reddit scan results and reminders |
| `<all_urls>` | Injects content scripts on any website |

No microphone permission is declared. No remote code is loaded.

---

## Saved Scripts

Scripts are saved in `chrome.storage.local` and persist between browser sessions.

- **New** — blank script with `"use obt";`
- **Rename** — give it a meaningful name
- **Duplicate** — copy to make a variant
- **Delete** — permanent, no undo

---

## Example Scripts

### A: Basic page inspection
```
"use obt";
var title = $run(get --type text --target selector "h1");
var links = $run(get --type count --target selector "a");
say "Title: {$title}";
say "Links: {$links}";
happyFace;
```

### B: Wait for content to load
```
"use obt";
navigate "https://example.com";
until seeText "Example Domain" { wait 1; }
say "Page is ready";
```

### C: Form fill and submit
```
"use obt";
focus --type selector "input[name='q']";
type "browser automation";
press Enter;
wait 2;
if seeText "results" {
    say "Search complete";
} else {
    say "No results found"; frownFace;
}
```

### D: Safe numeric extraction with $exec args
```
"use obt";
var raw     = $run(get --type text --target selector ".price");
var trimmed = $run(trim {$raw});
var numeric = $exec("return parseFloat(price.replace('$','').replace(',',''))", { price: {$trimmed} });
say "Price: {$trimmed} → numeric: {$numeric}";
```

### E: User dialog flow
```
"use obt";
var site = $run(prompt "Which site should I visit?");
if {$site} {
    var ok = $run(confirm "Visit {$site}?");
    if {$ok} {
        navigate {$site};
        wait 2;
        var title = $run(get --type text --target selector "h1");
        alert "Page title: {$title}";
    } else {
        alert "Cancelled.";
    }
} else {
    alert "No site entered.";
}
```

### F: Basic error handling
```
"use obt";
run {
    click "#submit";
    wait 2;
}
onThrow {
    say "Something went wrong: {$throwID}";
    log "Error code: {$throwNumber}";
}
onFinish {
    say "Attempt complete";
}
```

### G: Filter by error type — nested run{} for multiple catches
```
"use obt";
# Each run{} accepts exactly ONE onThrow clause.
# Use nested run{} to handle different error types at different levels.
run {
    run {
        navigate "https://example.com";
    }
    onThrow.throwID(NavigationError) {
        say "Bad URL — check the address";
    }
    click "#missing-button";
}
onThrow.throwID(ElementError) {
    say "Could not find the button — skipping";
}
onFinish {
    say "Done either way";
}
```

### H: Filter by error number
```
"use obt";
run {
    click "#risky";
}
onThrow.throwNumber(40) {
    say "Element not found (code 40)";
}
```

### I: Nested error handling
```
"use obt";
run {
    run {
        click "#primary-button";
    }
    onThrow.throwID(ElementError) {
        say "Primary not found, trying fallback";
        click "#fallback-button";
    }
    say "Button clicked";
}
onThrow {
    say "Both buttons failed: {$throwID}";
}
onFinish {
    say "All done";
}
```

### J: $ask for quick answers
```
"use obt";
var answer = $run(ask "What is the boiling point of water in Celsius?");
say {$answer};
```

### K: $ask with page context
```
"use obt";
navigate "https://en.wikipedia.org/wiki/Python_(programming_language)";
wait 2;
var summary = $run(ask "Give me three key facts about this topic" --page);
log {$summary};
say "Done";
```

### L: Bot personality sequence
```
"use obt";
say "Starting automation";
rollOrbit;
wait 0.5;
navigate "https://example.com";
until seeText "Example Domain" { wait 1; }
say "We are here!";
laugh;
```

### M: Scroll until target found
```
"use obt";
repeat 30 {
    if seeText "Load more" { click "Load more"; wait 1; }
    if seeText "End of results" { break; }
    scrollDown 1;
    wait 0.4;
}
say "Done scrolling";
```

---

## Tips & Tricks

**Raise the script timeout** if agent tasks time out (Settings → Script → Script timeout). Default is 5 minutes; set to 10–20 minutes for complex tasks.

**Rate Caution** controls agent pacing. On the free Groq plan use `Normal` (4–8s) or `High` (9–16s).

**Use $exec args for page data:**
```
var n = $exec("return parseFloat(price.replace('$',''))", { price: {$price} });
```

**Check existence before clicking:**
```
var hasCookieBanner = $run(get --type exists --target selector "#cookie-banner");
if {$hasCookieBanner} { click --type selector "#cookie-banner button"; }
```

**`say` blocks execution** — the next line runs only after speech ends.

**`{$var}` works inside strings** — interpolation is resolved at runtime:
```
say "The error was: {$throwID} (code {$throwNumber})";
```

**Use throwID for readable handlers, throwNumber for precise ones:**
```
onThrow.throwID(ElementError) { ... }     # readable — catches by name
onThrow.throwNumber(40) { ... }           # precise — same thing, by number
```

**`onFinish` is your cleanup guarantee** — it always runs, even if the body or `onThrow` threw. `throwNumber` and `throwID` are not in scope inside `onFinish{}` — declare a variable before the `run{}` and use bare reassignment (no `var`) in `onThrow{}` to capture them:
```
var lastErr = null;
run {
    click "#submit";
}
onThrow {
    lastErr = {$throwID};   # no var — updates the outer binding
}
onFinish {
    say "Finished. Error (if any): {$lastErr}";
}
```

**Handled errors still print to the console** — catching an error with `onThrow{}` does not suppress the `#40 ElementError: …` line in the script log. This is intentional so you can always see what happened while debugging.

**assert vs throw — when to use each:**
- `assert {$x} "msg"` → always `AssertionError` (#90). Use for internal invariants that should never fail in correct code — the code is always #90 and always stops the current block.
- `throw ElementError "msg"` → specific, catchable typed code. Use when the caller needs to distinguish error types via `onThrow.throwID` / `onThrow.throwNumber`, or when you want to re-raise with a different type.

**Be careful catching bare `onThrow{}`** — a plain `onThrow{}` with no filter catches everything including bugs. Always log `{$throwID}` so you can see what you caught. If `{$throwID}` is `"UnknownError"` (#10000), that is almost certainly a bug — consider re-throwing or alerting rather than silently continuing:
```
run {
    click "#submit";
}
onThrow {
    log "Caught: {$throwID} (#{$throwNumber})";
    if {$throwID} == "UnknownError" {
        alert "Unexpected internal error — please report this";
    }
}
```

**Nesting depth limit is 64** — any nested block counts toward this limit: `run{}`, `if{}`, `while{}`, `until{}`, `repeat{}`, and `onThrow{}`/`onFinish{}` bodies. The counter increments on every block entry and decrements on exit, so `if{} inside while{} inside run{}` counts as depth 3. If you hit `NestingError` (#2), flatten your logic or raise the limit by passing `maxNestDepth` when constructing the runtime (developer option — not in the Settings UI).

**split/join for lists:**
```
var colors = $run(split "," "red,green,blue");
var joined = $run(join " and " {$colors});
say {$joined};   # "red and green and blue"
```
