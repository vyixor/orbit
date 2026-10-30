// ORBIT — Orbit Script Lexer
// Converts OS source code into a flat array of typed tokens.
// Preserves source positions (line, col) for error reporting.

export const TT = Object.freeze({
  // Literals
  STRING:    'STRING',
  NUMBER:    'NUMBER',
  BOOL:      'BOOL',
  NULL:      'NULL',
  // Names
  IDENT:     'IDENT',
  VAR_REF:   'VAR_REF',    // {$name} or {$name.prop}
  INTERP:    'INTERP',     // interpolation marker start
  NAMED_ARG: 'NAMED_ARG',  // --foo
  // Keywords
  VAR:       'VAR',
  IF:        'IF',
  ELSE:      'ELSE',
  WHILE:     'WHILE',
  UNTIL:     'UNTIL',
  REPEAT:    'REPEAT',
  BREAK:     'BREAK',
  CONTINUE:  'CONTINUE',
  SEQUENCE:  'SEQUENCE',
  // Structured error-handling keywords (run{} / onThrow{} / onFinish{} / throw)
  THROW:        'THROW',        // throw N "msg"  or  throw ErrorID "msg"
  RUN_BLOCK:    'RUN_BLOCK',    // bare `run` keyword followed by {
  ON_THROW:     'ON_THROW',     // onThrow
  ON_FINISH:    'ON_FINISH',    // onFinish
  THROW_NUMBER: 'THROW_NUMBER', // onThrow.throwNumber(  — lexer eats the dot+name+paren
  THROW_ID:     'THROW_ID',     // onThrow.throwID(      — same
  // Punctuation
  SEMI:      'SEMI',
  COMMA:     'COMMA',
  LBRACE:    'LBRACE',
  RBRACE:    'RBRACE',
  LPAREN:    'LPAREN',
  RPAREN:    'RPAREN',
  LBRACKET:  'LBRACKET',
  RBRACKET:  'RBRACKET',
  // Operators
  EQ:        'EQ',      // =
  EQEQ:      'EQEQ',   // ==
  NEQ:       'NEQ',    // !=
  LT:        'LT',
  GT:        'GT',
  LTE:       'LTE',
  GTE:       'GTE',
  PLUS:      'PLUS',
  MINUS:     'MINUS',
  STAR:      'STAR',
  SLASH:     'SLASH',
  PERCENT:   'PERCENT',
  AND:       'AND',
  OR:        'OR',
  NOT:       'NOT',
  DOT:       'DOT',
  // Special expressions
  RUN:       'RUN',     // $run(
  RUNJS:     'RUNJS',   // $exec(
  // Directive
  DIRECTIVE: 'DIRECTIVE',
  // Meta
  EOF:       'EOF',
});

const KEYWORDS = new Set(['var', 'if', 'else', 'while', 'until', 'repeat', 'break', 'continue', 'sequence', 'null', 'true', 'false', 'and', 'or', 'not', 'run', 'onThrow', 'onFinish', 'throw']);

export { LexError } from './errors.js';

export function tokenize(src) {
  const tokens = [];
  let pos = 0, line = 1, col = 1;

  function peek(offset = 0) { return src[pos + offset]; }
  function advance() {
    const ch = src[pos++];
    if (ch === '\n') { line++; col = 1; } else { col++; }
    return ch;
  }
  function here() { return { line, col }; }
  function tok(type, value, loc) { return { type, value, line: loc.line, col: loc.col }; }

  // ── Skip whitespace and comments ─────────────────────────────────────────
  function skipWS() {
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { advance(); continue; }
      // Line comment # or //
      if (ch === '#' || (ch === '/' && src[pos+1] === '/')) {
        while (pos < src.length && src[pos] !== '\n') advance();
        continue;
      }
      break;
    }
  }

  // ── Read a quoted string (single/double, or triple for multiline) ────────
  function readString(quote) {
    const loc = here();
    // Triple-quote: """...""" or '''...'''  (multiline, like Python)
    if (src[pos] === quote && src[pos+1] === quote && src[pos+2] === quote) {
      advance(); advance(); advance(); // consume opening triple
      let val = '';
      while (pos < src.length) {
        if (src[pos] === quote && src[pos+1] === quote && src[pos+2] === quote) {
          advance(); advance(); advance(); break; // consume closing triple
        }
        if (src[pos] === '\\') {
          advance();
          const esc = advance();
          switch (esc) {
            case 'n':  val += '\n'; break;
            case 't':  val += '\t'; break;
            case '\\': val += '\\'; break;
            default:   val += '\\' + esc;
          }
        } else {
          const ch = src[pos];
          if (ch === '\n') { line++; col = 1; pos++; } else { col++; pos++; }
          val += ch;
        }
      }
      return tok(TT.STRING, val, loc);
    }
    advance(); // consume opening single/double quote
    let val = '';
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === '\\') {
        advance();
        const esc = advance();
        switch (esc) {
          case 'n': val += '\n'; break;
          case 't': val += '\t'; break;
          case 'r': val += '\r'; break;
          case '"': val += '"'; break;
          case "'": val += "'"; break;
          case '\\': val += '\\'; break;
          case '{': val += '{'; break;
          default: val += '\\' + esc;
        }
      } else if (ch === quote) {
        advance(); break;
      } else {
        val += ch; advance();
      }
    }
    return tok(TT.STRING, val, loc);
  }

  // ── Read a number ────────────────────────────────────────────────────────
  function readNumber() {
    const loc = here();
    let val = '';
    if (src[pos] === '-') { val += advance(); }
    while (pos < src.length && /[0-9]/.test(src[pos])) val += advance();
    if (src[pos] === '.' && /[0-9]/.test(src[pos+1])) {
      val += advance();
      while (pos < src.length && /[0-9]/.test(src[pos])) val += advance();
    }
    return tok(TT.NUMBER, parseFloat(val), loc);
  }

  // ── Read an identifier or keyword ────────────────────────────────────────
  function readIdent() {
    const loc = here();
    let val = '';
    while (pos < src.length && /[\w]/.test(src[pos])) val += advance();
    // Map keywords
    switch (val) {
      case 'var':      return tok(TT.VAR,      val, loc);
      case 'if':       return tok(TT.IF,       val, loc);
      case 'else':     return tok(TT.ELSE,     val, loc);
      case 'while':    return tok(TT.WHILE,    val, loc);
      case 'until':    return tok(TT.UNTIL,    val, loc);
      case 'repeat':   return tok(TT.REPEAT,   val, loc);
      case 'break':    return tok(TT.BREAK,    val, loc);
      case 'continue': return tok(TT.CONTINUE, val, loc);
      case 'sequence': return tok(TT.SEQUENCE, val, loc);
      // Error-handling block keywords
      // Note: bare `run` (no $) is the block form; $run( is lexed via the $ branch above
      case 'throw': return tok(TT.THROW, val, loc);
      case 'run': return tok(TT.RUN_BLOCK, val, loc);
      case 'onThrow': {
        // Peek ahead (read-only) to detect onThrow.throwNumber( or onThrow.throwID(
        // If matched, advance the real lexer position past dot+name+paren and
        // emit a single THROW_NUMBER / THROW_ID token.
        // Otherwise emit a plain ON_THROW token (e.g. followed by {).
        let p = pos;
        while (p < src.length && (src[p] === ' ' || src[p] === '\t')) p++;
        if (src[p] === '.') {
          p++; // past the dot
          const nameStart = p;
          while (p < src.length && /[\w]/.test(src[p])) p++;
          const sub = src.slice(nameStart, p);
          if (sub === 'throwNumber' || sub === 'throwID') {
            // Advance the real lexer cursor to p (past dot + sub-identifier)
            while (pos < p) advance();
            // consume optional whitespace then '('
            while (pos < src.length && src[pos] === ' ') advance();
            if (pos < src.length && src[pos] === '(') advance();
            return tok(sub === 'throwNumber' ? TT.THROW_NUMBER : TT.THROW_ID, sub, loc);
          }
        }
        return tok(TT.ON_THROW, val, loc);
      }
      case 'onFinish': return tok(TT.ON_FINISH, val, loc);
      case 'true':     return tok(TT.BOOL,     true, loc);
      case 'false':    return tok(TT.BOOL,     false, loc);
      case 'null':     return tok(TT.NULL,     null, loc);
      case 'and':      return tok(TT.AND,      val, loc);
      case 'or':       return tok(TT.OR,       val, loc);
      case 'not':      return tok(TT.NOT,      val, loc);
      default:         return tok(TT.IDENT,    val, loc);
    }
  }

  // ── Read {$varRef} interpolation token ──────────────────────────────────
  function readVarRef() {
    const loc = here();
    advance(); // {
    advance(); // $
    let name = '';
    while (pos < src.length && /[\w]/.test(src[pos])) name += advance();
    let prop = null;
    if (src[pos] === '.') {
      advance();
      prop = '';
      while (pos < src.length && /[\w]/.test(src[pos])) prop += advance();
    }
    if (src[pos] !== '}') throw new LexError('Expected } to close variable reference', line, col);
    advance(); // }
    return tok(TT.VAR_REF, { name, prop }, loc);
  }

  // ── Main tokenizer loop ──────────────────────────────────────────────────
  // Strip BOM
  if (src.charCodeAt(0) === 0xFEFF) pos++;

  // Check for directive at the top and consume it so the main loop never
  // re-tokenises it as a STRING (which would cause a parse error).
  const directiveMatch = src.replace(/^\uFEFF/, '').match(/^(\s*"use (?:js|obt)"\s*;?)/i);
  if (directiveMatch) {
    const inner = directiveMatch[1].match(/"use (js|obt)"/i);
    const loc = { line: 1, col: 1 };
    tokens.push(tok(TT.DIRECTIVE, inner[1].toLowerCase(), loc));
    pos += directiveMatch[1].length; // skip past the directive in the source
  }

  while (pos < src.length) {
    skipWS();
    if (pos >= src.length) break;

    const ch = src[pos];
    const loc = here();

    // Directive strings — skip if already captured
    if (ch === '"' && src.slice(pos).match(/^"use (js|os)"\s*;?/i)) {
      let tmp = '';
      while (pos < src.length && src[pos] !== '\n') tmp += advance();
      // Already handled above — skip
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'") { tokens.push(readString(ch)); continue; }

    // {$varRef}
    if (ch === '{' && src[pos+1] === '$') { tokens.push(readVarRef()); continue; }

    // $run( / $exec(
    if (ch === '$') {
      advance();
      if (src.slice(pos, pos+4) === 'exec') {
        for (let i = 0; i < 4; i++) advance();
        // consume optional whitespace and (
        while (pos < src.length && src[pos] === ' ') advance();
        if (src[pos] === '(') advance();
        tokens.push(tok(TT.RUNJS, '$exec', loc));
        continue;
      } else if (src.slice(pos, pos+3) === 'run') {
        for (let i = 0; i < 3; i++) advance();
        while (pos < src.length && src[pos] === ' ') advance();
        if (src[pos] === '(') advance();
        tokens.push(tok(TT.RUN, '$run', loc));
        continue;
      } else {
        throw new LexError('Unknown $ expression', line, col);
      }
    }

    // Negative numbers
    if (ch === '-' && /[0-9]/.test(src[pos+1])) { tokens.push(readNumber()); continue; }

    // Numbers
    if (/[0-9]/.test(ch)) { tokens.push(readNumber()); continue; }

    // Named args --foo
    if (ch === '-' && src[pos+1] === '-') {
      advance(); advance();
      let name = '';
      while (pos < src.length && /[\w-]/.test(src[pos])) name += advance();
      tokens.push(tok(TT.NAMED_ARG, name, loc));
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(ch)) { tokens.push(readIdent()); continue; }

    // Operators and punctuation
    switch (ch) {
      case ';': advance(); tokens.push(tok(TT.SEMI,     ';', loc)); break;
      case ',': advance(); tokens.push(tok(TT.COMMA,    ',', loc)); break;
      case '{': advance(); tokens.push(tok(TT.LBRACE,   '{', loc)); break;
      case '}': advance(); tokens.push(tok(TT.RBRACE,   '}', loc)); break;
      case '(': advance(); tokens.push(tok(TT.LPAREN,   '(', loc)); break;
      case ')': advance(); tokens.push(tok(TT.RPAREN,   ')', loc)); break;
      case '[': advance(); tokens.push(tok(TT.LBRACKET, '[', loc)); break;
      case ']': advance(); tokens.push(tok(TT.RBRACKET, ']', loc)); break;
      case '.': advance(); tokens.push(tok(TT.DOT,      '.', loc)); break;
      case '+': advance(); tokens.push(tok(TT.PLUS,     '+', loc)); break;
      case '*': advance(); tokens.push(tok(TT.STAR,     '*', loc)); break;
      case '/': advance(); tokens.push(tok(TT.SLASH,    '/', loc)); break;
      case '%': advance(); tokens.push(tok(TT.PERCENT,  '%', loc)); break;
      case '=':
        advance();
        if (src[pos] === '=') { advance(); tokens.push(tok(TT.EQEQ, '==', loc)); }
        else tokens.push(tok(TT.EQ, '=', loc));
        break;
      case '!':
        advance();
        if (src[pos] === '=') { advance(); tokens.push(tok(TT.NEQ, '!=', loc)); }
        else throw new LexError(`Unexpected '!'; did you mean '!=' or 'not'?`, line, col);
        break;
      case '<':
        advance();
        if (src[pos] === '=') { advance(); tokens.push(tok(TT.LTE, '<=', loc)); }
        else tokens.push(tok(TT.LT, '<', loc));
        break;
      case '>':
        advance();
        if (src[pos] === '=') { advance(); tokens.push(tok(TT.GTE, '>=', loc)); }
        else tokens.push(tok(TT.GT, '>', loc));
        break;
      default:
        throw new LexError(`Unexpected character '${ch}'`, line, col);
    }
  }

  tokens.push(tok(TT.EOF, null, here()));
  return tokens;
}
