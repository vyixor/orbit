// ORBIT — Orbit Script Parser
// Converts a token array into a typed Abstract Syntax Tree.
// Parsing and execution are fully separated — no side effects here.

import { TT } from './lexer.js';

export { ParseError } from './errors.js';

// ── Node constructors ────────────────────────────────────────────────────────
const N = {
  Program:            (body, loc)                  => ({ type: 'Program', body, ...loc }),
  BlockStatement:     (body, loc)                  => ({ type: 'BlockStatement', body, ...loc }),
  CommandCall:        (name, args, namedArgs, loc) => ({ type: 'CommandCall', name, args, namedArgs, ...loc }),
  VariableDeclaration:(name, init, loc)            => ({ type: 'VariableDeclaration', name, init, ...loc }),
  VariableReference:  (name, prop, loc)            => ({ type: 'VariableReference', name, prop, ...loc }),
  StringLiteral:      (value, loc)                 => ({ type: 'StringLiteral', value, ...loc }),
  NumberLiteral:      (value, loc)                 => ({ type: 'NumberLiteral', value, ...loc }),
  BooleanLiteral:     (value, loc)                 => ({ type: 'BooleanLiteral', value, ...loc }),
  NullLiteral:        (loc)                        => ({ type: 'NullLiteral', value: null, ...loc }),
  BinaryExpression:   (op, left, right, loc)       => ({ type: 'BinaryExpression', op, left, right, ...loc }),
  UnaryExpression:    (op, operand, loc)           => ({ type: 'UnaryExpression', op, operand, ...loc }),
  RunExpression:      (body, loc)                  => ({ type: 'RunExpression', body, ...loc }),
  RunJSExpression:    (code, loc)                  => ({ type: 'RunJSExpression', code, ...loc }),
  IfStatement:        (test, consequent, alternate, loc) => ({ type: 'IfStatement', test, consequent, alternate, ...loc }),
  WhileStatement:     (test, body, loc)            => ({ type: 'WhileStatement', test, body, ...loc }),
  UntilStatement:     (test, body, loc)            => ({ type: 'UntilStatement', test, body, ...loc }),
  RepeatStatement:    (count, body, loc)           => ({ type: 'RepeatStatement', count, body, ...loc }),
  BreakStatement:     (loc)                        => ({ type: 'BreakStatement', ...loc }),
  ContinueStatement:  (loc)                        => ({ type: 'ContinueStatement', ...loc }),
  MemberExpression:   (object, property, loc)      => ({ type: 'MemberExpression', object, property, ...loc }),
  SequenceExpression: (body, loc)                  => ({ type: 'SequenceExpression', body, ...loc }),
  // run{} onThrow{} onFinish{} — structured error handling
  // onThrow: null | { filter: {kind:'number'|'id', value: ASTNode} | null, body: BlockStatement }
  // onFinish: null | BlockStatement
  TryStatement:       (body, onThrow, onFinish, loc)  => ({ type: 'TryStatement', body, onThrow, onFinish, ...loc }),
  // name = expr  (reassignment — walks up scope chain to find existing binding)
  AssignmentStatement:(name, value, loc)              => ({ type: 'AssignmentStatement', name, value, ...loc }),
  // throw N "msg" or throw ErrorID "msg"
  ThrowStatement:     (filter, message, loc)          => ({ type: 'ThrowStatement', filter, message, ...loc }),
};

export function parse(tokens) {
  let pos = 0;

  function peek(offset = 0) { return tokens[pos + offset] || tokens[tokens.length - 1]; }
  function cur()    { return peek(0); }
  function check(type) { return cur().type === type; }
  function loc()    { const t = cur(); return { line: t.line, col: t.col }; }

  function advance() { const t = tokens[pos]; if (pos < tokens.length - 1) pos++; return t; }

  function expect(type, hint = '') {
    if (cur().type !== type) {
      const t = cur();
      throw new ParseError(`Expected ${type}${hint ? ' ' + hint : ''}, got ${t.type} (${JSON.stringify(t.value)})`, t.line, t.col);
    }
    return advance();
  }

  function eat(type) {
    if (cur().type === type) { advance(); return true; }
    return false;
  }

  // ── Program ─────────────────────────────────────────────────────────────
  function parseProgram() {
    const start = loc();
    const body = [];
    // Skip leading directive token
    if (check(TT.DIRECTIVE)) advance();
    while (!check(TT.EOF)) {
      eat(TT.SEMI);
      if (check(TT.EOF)) break;
      body.push(parseStatement());
    }
    return N.Program(body, start);
  }

  // ── Statement dispatch ───────────────────────────────────────────────────
  function parseStatement() {
    const t = cur();

    if (t.type === TT.VAR)      return parseVarDecl();
    if (t.type === TT.IF)       return parseIf();
    if (t.type === TT.WHILE)    return parseWhile();
    if (t.type === TT.UNTIL)    return parseUntil();
    if (t.type === TT.REPEAT)   return parseRepeat();
    if (t.type === TT.BREAK)    { advance(); eat(TT.SEMI); return N.BreakStatement(loc()); }
    if (t.type === TT.CONTINUE) { advance(); eat(TT.SEMI); return N.ContinueStatement(loc()); }

    // run { } — structured error handling block (NOT the same as $run())
    if (t.type === TT.RUN_BLOCK) return parseTryStatement();

    // throw N "message"  /  throw ErrorID "message"
    if (t.type === TT.THROW) return parseThrowStatement();

    // Bare assignment: name = expr  (no var — reassigns an existing binding)
    // Peek ahead: IDENT followed by EQ (but not EQEQ)
    if (t.type === TT.IDENT && peek(1).type === TT.EQ) return parseAssignment();

    // Command call (identifier at statement level)
    if (t.type === TT.IDENT) return parseCommandCall();

    throw new ParseError(`Unexpected token ${t.type} (${JSON.stringify(t.value)}) at statement level`, t.line, t.col);
  }

  // ── Block { ... } ────────────────────────────────────────────────────────
  function parseBlock() {
    const start = loc();
    expect(TT.LBRACE, 'to open block');
    const body = [];
    while (!check(TT.RBRACE) && !check(TT.EOF)) {
      eat(TT.SEMI);
      if (check(TT.RBRACE)) break;
      body.push(parseStatement());
    }
    expect(TT.RBRACE, 'to close block');
    return N.BlockStatement(body, start);
  }

  // ── Variable declaration ─────────────────────────────────────────────────
  function parseVarDecl() {
    const start = loc();
    expect(TT.VAR);
    const name = expect(TT.IDENT, 'variable name').value;
    expect(TT.EQ, 'after variable name');
    const init = parseExpression();
    eat(TT.SEMI);
    return N.VariableDeclaration(name, init, start);
  }

  // ── Command call (statement level) ───────────────────────────────────────
  // Reads: cmdName [args...] [--named value] ... ;
  function parseCommandCall() {
    const start = loc();
    const name = expect(TT.IDENT, 'command name').value;
    const args = [];
    const namedArgs = {};

    while (canStartArg()) {
      if (check(TT.NAMED_ARG)) {
        const argName = advance().value;
        // Named arg value: consume ONE atom.
        // Bare identifiers (like "text", "selector") are treated as string values here,
        // not as command names to execute.
        if (!check(TT.NAMED_ARG) && !check(TT.LBRACE) && !check(TT.RBRACE) &&
            !check(TT.SEMI) && !check(TT.EOF) && !check(TT.AND) && !check(TT.OR)) {
          if (check(TT.IDENT)) {
            // Bareword identifier → string literal
            const t = advance();
            namedArgs[argName] = N.StringLiteral(t.value, { line: t.line, col: t.col });
          } else {
            namedArgs[argName] = parseAtom();
          }
        } else {
          namedArgs[argName] = N.BooleanLiteral(true, loc());
        }
      } else if (check(TT.IDENT)) {
        // Bare identifier as positional arg — treat as string literal (bareword)
        const t = advance();
        args.push(N.StringLiteral(t.value, { line: t.line, col: t.col }));
      } else {
        args.push(parseAtom());
      }
    }

    eat(TT.SEMI);
    return N.CommandCall(name, args, namedArgs, start);
  }

  // Tokens that can start an argument in a command call
  function canStartArg() {
    const t = cur().type;
    return t === TT.STRING || t === TT.NUMBER || t === TT.BOOL || t === TT.NULL ||
           t === TT.VAR_REF || t === TT.NAMED_ARG || t === TT.RUN || t === TT.RUNJS ||
           t === TT.IDENT || t === TT.MINUS;
  }

  // ── Expression parser ─────────────────────────────────────────────────────
  // Entry for expressions (used in var = <expr>, conditions, nested args)
  function parseExpression() {
    return parseOr();
  }

  function parseOr() {
    let left = parseAnd();
    while (check(TT.OR)) {
      const op = advance().value;
      const right = parseAnd();
      left = N.BinaryExpression('or', left, right, { line: left.line, col: left.col });
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (check(TT.AND)) {
      advance();
      const right = parseNot();
      left = N.BinaryExpression('and', left, right, { line: left.line, col: left.col });
    }
    return left;
  }

  function parseNot() {
    if (check(TT.NOT)) {
      const start = loc(); advance();
      const operand = parseNot();
      return N.UnaryExpression('not', operand, start);
    }
    return parseComparison();
  }

  function parseComparison() {
    let left = parseAddSub();
    const CMP = new Set([TT.EQEQ, TT.NEQ, TT.LT, TT.GT, TT.LTE, TT.GTE]);
    while (CMP.has(cur().type)) {
      const op = advance().value;
      const right = parseAddSub();
      left = N.BinaryExpression(op, left, right, { line: left.line, col: left.col });
    }
    return left;
  }

  function parseAddSub() {
    let left = parseMulDiv();
    while (check(TT.PLUS) || check(TT.MINUS)) {
      const op = advance().value;
      const right = parseMulDiv();
      left = N.BinaryExpression(op, left, right, { line: left.line, col: left.col });
    }
    return left;
  }

  function parseMulDiv() {
    let left = parseUnaryMinus();
    while (check(TT.STAR) || check(TT.SLASH) || check(TT.PERCENT)) {
      const op = advance().value;
      const right = parseUnaryMinus();
      left = N.BinaryExpression(op, left, right, { line: left.line, col: left.col });
    }
    return left;
  }

  function parseUnaryMinus() {
    if (check(TT.MINUS)) {
      const start = loc(); advance();
      const operand = parseAtomWithMember();
      return N.UnaryExpression('-', operand, start);
    }
    return parseAtomWithMember();
  }

  function parseAtomWithMember() {
    let node = parseAtom();
    while (check(TT.DOT)) {
      const start = loc(); advance();
      const prop = expect(TT.IDENT, 'property name').value;
      node = N.MemberExpression(node, prop, start);
    }
    return node;
  }

  // ── Atom — the smallest indivisible expression ───────────────────────────
  function parseAtom() {
    const t = cur();

    if (t.type === TT.STRING)   { advance(); return N.StringLiteral(t.value, { line: t.line, col: t.col }); }
    if (t.type === TT.NUMBER)   { advance(); return N.NumberLiteral(t.value, { line: t.line, col: t.col }); }
    if (t.type === TT.BOOL)     { advance(); return N.BooleanLiteral(t.value, { line: t.line, col: t.col }); }
    if (t.type === TT.NULL)     { advance(); return N.NullLiteral({ line: t.line, col: t.col }); }
    if (t.type === TT.VAR_REF)  { advance(); return N.VariableReference(t.value.name, t.value.prop, { line: t.line, col: t.col }); }

    // $run(...)
    if (t.type === TT.RUN) {
      advance();
      return parseRunExpression({ line: t.line, col: t.col });
    }

    // (...)
    if (t.type === TT.RUNJS) {
      advance();
      return parseRunJSExpression({ line: t.line, col: t.col });
    }

    // Parenthesized expression
    if (t.type === TT.LPAREN) {
      advance();
      const expr = parseExpression();
      expect(TT.RPAREN, 'to close expression');
      return expr;
    }

    // Identifier used in expression context — treat as a command call with no args
    // (e.g. condition: if seeText "x" { ... })
    if (t.type === TT.IDENT) {
      return parseInlineCommandOrIdent();
    }

    throw new ParseError(`Expected expression, got ${t.type} (${JSON.stringify(t.value)})`, t.line, t.col);
  }

  // An identifier in expression context — could be a command call used as value
  function parseInlineCommandOrIdent() {
    const start = { line: cur().line, col: cur().col };
    const name = advance().value;
    const args = [];
    const namedArgs = {};

    // Greedily collect args, but stop before control-flow tokens
    while (canStartInlineArg()) {
      if (check(TT.NAMED_ARG)) {
        const argName = advance().value;
        // Named arg value in inline context: bare ident → string
        if (canStartInlineArg() && !check(TT.NAMED_ARG)) {
          if (check(TT.IDENT)) {
            const t = advance();
            namedArgs[argName] = N.StringLiteral(t.value, { line: t.line, col: t.col });
          } else {
            namedArgs[argName] = parseAtom();
          }
        } else {
          namedArgs[argName] = N.BooleanLiteral(true, loc());
        }
      } else {
        args.push(parseAtom());
      }
    }

    if (args.length === 0 && Object.keys(namedArgs).length === 0) {
      return N.StringLiteral(name, start); // bareword
    }
    return N.CommandCall(name, args, namedArgs, start);
  }

  function canStartInlineArg() {
    const t = cur().type;
    // Stop before: { } ; and or not (comparison ops handled by arithmetic parser above)
    if (t === TT.LBRACE || t === TT.RBRACE || t === TT.SEMI || t === TT.EOF) return false;
    if (t === TT.AND || t === TT.OR || t === TT.NOT) return false;
    if (t === TT.RPAREN || t === TT.RBRACKET || t === TT.COMMA) return false;
    if (t === TT.ELSE) return false;
    return canStartArg();
  }

  // ── $run( <body> ) ────────────────────────────────────────────────────────
  function parseRunExpression(start) {
    // Body is either: a sequence block, a single inline command, or a $run chain
    if (check(TT.SEQUENCE)) {
      // $run(sequence { ... })
      advance();
      const block = parseBlock();
      expect(TT.RPAREN, 'to close $run(sequence ...)');
      return N.RunExpression(N.SequenceExpression(block.body, start), start);
    }

    // Single command call inside $run(...)
    const innerStart = loc();
    const name = expect(TT.IDENT, 'command name inside $run(...)').value;
    const args = [];
    const namedArgs = {};
    while (!check(TT.RPAREN) && !check(TT.EOF)) {
      if (check(TT.NAMED_ARG)) {
        const argName = advance().value;
        if (!check(TT.RPAREN) && !check(TT.NAMED_ARG)) {
          namedArgs[argName] = parseAtom();
        } else {
          namedArgs[argName] = N.BooleanLiteral(true, loc());
        }
      } else {
        args.push(parseAtom());
      }
    }
    expect(TT.RPAREN, 'to close $run(...)');
    return N.RunExpression(N.CommandCall(name, args, namedArgs, innerStart), start);
  }

  // ── $exec( <string_expr> ) ────────────────────────────────────────────────
  function parseRunJSExpression(start) {
    const code = parseAtom();
    expect(TT.RPAREN, 'to close (...)');
    return N.RunJSExpression(code, start);
  }

  // ── Control flow ──────────────────────────────────────────────────────────
  function parseIf() {
    const start = loc();
    expect(TT.IF);
    const test = parseCondition();
    const consequent = parseBlock();
    let alternate = null;
    if (check(TT.ELSE)) {
      advance();
      if (check(TT.IF)) {
        alternate = parseIf(); // else if
      } else {
        alternate = parseBlock();
      }
    }
    return N.IfStatement(test, consequent, alternate, start);
  }

  function parseWhile() {
    const start = loc();
    expect(TT.WHILE);
    const test = parseCondition();
    const body = parseBlock();
    return N.WhileStatement(test, body, start);
  }

  function parseUntil() {
    const start = loc();
    expect(TT.UNTIL);
    const test = parseCondition();
    const body = parseBlock();
    return N.UntilStatement(test, body, start);
  }

  function parseRepeat() {
    const start = loc();
    expect(TT.REPEAT);
    const count = parseAtom();
    const body = parseBlock();
    return N.RepeatStatement(count, body, start);
  }

  // A condition expression — like parseExpression but with command-call support
  function parseCondition() {
    return parseExpression();
  }

  // ── throw N "message"  /  throw ErrorID "message" ────────────────────────
  // Raises a typed OrbitThrow from user script.
  // throw 40 "Element not found";             — by number
  // throw ElementError "Button missing";      — by registered ID name
  // throw 200 "custom msg";                   — user-registered custom code
  // The error is catchable by onThrow (unless it matches a fatal code,
  // which _isFatalError() in the interpreter will re-enforce).
  function parseThrowStatement() {
    const start = loc();
    expect(TT.THROW, '"throw" keyword');

    // Code position — four accepted forms:
    //   throw 40 "msg"               — number literal    → kind:'number'
    //   throw ElementError "msg"     — bare identifier   → kind:'id' (string literal)
    //   throw {$throwNumber} "msg"   — VAR_REF number    → kind:'number' (eval at runtime)
    //   throw {$throwID} "msg"       — VAR_REF string    → kind:'id'    (eval at runtime)
    //
    // When a VAR_REF is used, the interpreter checks at runtime whether the resolved
    // value is a number (→ number lookup) or a string (→ id lookup).
    let filter;
    if (check(TT.NUMBER)) {
      const t = advance();
      filter = { kind: 'number', value: N.NumberLiteral(t.value, { line: t.line, col: t.col }) };
    } else if (check(TT.IDENT)) {
      // Bare identifier — always a string literal (error ID name), never a variable lookup.
      // For variable values use {$varName} syntax instead.
      const t = advance();
      filter = { kind: 'id', value: N.StringLiteral(t.value, { line: t.line, col: t.col }) };
    } else if (check(TT.VAR_REF)) {
      // {$var} — resolved at runtime; interpreter will detect number vs string
      const t = advance();
      filter = { kind: 'dynamic', value: N.VariableReference(t.value.name, t.value.prop, { line: t.line, col: t.col }) };
    } else {
      const t = cur();
      throw new ParseError(
        'throw expects a number, a registered error ID, or a {$variable}: ' +
        'e.g. throw 40 "msg", throw ElementError "msg", throw {$throwNumber} "rethrown"',
        t.line, t.col
      );
    }

    // Optional message — any expression (string interpolation works normally)
    const message = isAtom() ? parseAtom() : N.StringLiteral('', start);
    eat(TT.SEMI);
    return N.ThrowStatement(filter, message, start);
  }

  // ── name = expr  (bare reassignment — no var) ────────────────────────────
  // Walks up the scope chain to find an existing binding and mutates it.
  // If no binding exists in any parent scope, throws UndefinedVariableError.
  // This is how you update a var declared in an outer scope from inside
  // an onThrow{} or onFinish{} block.
  function parseAssignment() {
    const start = loc();
    const name = advance().value;   // IDENT
    advance();                       // EQ
    const value = parseExpression();
    eat(TT.SEMI);
    return N.AssignmentStatement(name, value, start);
  }

  // Returns true if the current token can start an atom (used for optional message in throw)
  function isAtom() {
    const t = cur().type;
    return t === TT.STRING || t === TT.NUMBER || t === TT.BOOL || t === TT.NULL ||
           t === TT.VAR_REF || t === TT.LPAREN || t === TT.IDENT;
  }

  // ── run { } onThrow { } onFinish { } ─────────────────────────────────────
  //
  // run { ... }                       — try body
  // run { ... } onThrow { ... }       — catch any error
  // run { ... } onThrow.throwNumber(N) { ... }  — catch only error with that number
  // run { ... } onThrow.throwID(name) { ... }   — catch only error with that id
  // run { ... } onFinish { ... }      — always runs (with or without onThrow)
  // run { ... } onThrow { ... } onFinish { ... } — all three
  //
  // Important: `run` here is the bare keyword (no $). $run() is unchanged and
  // is handled entirely separately in parseAtom() as a RunExpression.
  //
  // Inside an onThrow block two implicit local vars are available:
  //   throwNumber  — integer error code  (0 = unknown / unregistered)
  //   throwID      — string error name   (JS error class name by default)
  function parseTryStatement() {
    const start = loc();
    expect(TT.RUN_BLOCK, '"run" keyword');
    const body = parseBlock();          // must be { } — no paren form here

    // Optional onThrow clause — exactly ONE is allowed per run{} block.
    // Multiple onThrow clauses would require precedence rules; instead, nest
    // run{} blocks to handle different error types at different levels.
    let onThrow = null;
    if (check(TT.ON_THROW) || check(TT.THROW_NUMBER) || check(TT.THROW_ID)) {
      const throwStart = loc();
      let filter = null;

      if (check(TT.THROW_NUMBER)) {
        advance(); // consume THROW_NUMBER (lexer already ate "onThrow.throwNumber(")
        const value = parseAtom();
        expect(TT.RPAREN, 'to close throwNumber(...)');
        filter = { kind: 'number', value };
      } else if (check(TT.THROW_ID)) {
        advance(); // consume THROW_ID (lexer already ate "onThrow.throwID(")
        // Bare identifier is always treated as a string literal — NOT a variable lookup.
        // To filter dynamically, use $exec or nest a run{} with a plain onThrow{}.
        // e.g.  throwID(NavigationError)       — matches the string "NavigationError"
        //        throwID("NavigationError")     — identical, quotes are optional
        //        throwID({$myVar})              — DOES NOT WORK: {$...} is for strings, not here
        let value;
        if (check(TT.IDENT)) {
          const t = advance();
          value = N.StringLiteral(t.value, { line: t.line, col: t.col });
        } else {
          value = parseAtom(); // allows quoted string: throwID("NavigationError")
        }
        expect(TT.RPAREN, 'to close throwID(...)');
        filter = { kind: 'id', value };
      } else {
        advance(); // consume plain ON_THROW token
      }

      const throwBody = parseBlock();
      onThrow = { filter, body: throwBody, ...throwStart };

      // Reject a second onThrow clause — only one is allowed per run{} block.
      if (check(TT.ON_THROW) || check(TT.THROW_NUMBER) || check(TT.THROW_ID)) {
        const t = peek();
        throw new ParseError(
          'Only one onThrow clause is allowed per run{} block. ' +
          'Use nested run{} blocks to handle different error types.',
          t.line, t.col
        );
      }
    }

    // Optional onFinish clause — filters (onFinish.throwNumber / onFinish.throwID) are
    // not supported. onFinish always runs unconditionally. A parse error is thrown here
    // rather than letting the dot be parsed as property access and failing strangely later.
    if (check(TT.ON_FINISH)) {
      advance();
      // Detect the footgun: onFinish.throwNumber(...) or onFinish.throwID(...)
      if (check(TT.DOT)) {
        const t = peek();
        throw new ParseError(
          'onFinish does not support filters — it always runs unconditionally. ' +
          'Remove the .throwNumber() or .throwID() qualifier.',
          t.line, t.col
        );
      }
      const onFinish = parseBlock();
      return N.TryStatement(body, onThrow, onFinish, start);
    }

    return N.TryStatement(body, onThrow, null, start);
  }

  return parseProgram();
}
