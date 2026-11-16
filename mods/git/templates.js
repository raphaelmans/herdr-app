// Lazygit custom-command templates. Parse the complete input before executing
// injected functions. This module has no shell, filesystem, or dynamic-code API.
const BUILTINS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'and', 'or', 'not', 'index', 'len', 'printf', 'print', 'println', 'quote', 'runCommand']);
const COLOR_NAMES = new Set(['default', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'bold', 'underline']);
const SPACE = /[ \t\r\n]/;
const ID_START = /[\p{L}_]/u, ID_PART = /[\p{L}\p{N}_]/u;

export class TemplateError extends Error {
  constructor(message, source, offset) {
    const prefix = source.slice(0, offset), line = prefix.split('\n').length;
    const column = [...prefix.slice(prefix.lastIndexOf('\n') + 1)].length + 1;
    super(`${message} at line ${line}, column ${column}`);
    this.name = 'TemplateError'; this.offset = offset; this.line = line; this.column = column;
  }
}

function segments(source, fail) {
  const result = []; let cursor = 0, trimNext = false;
  while (cursor < source.length) {
    const start = source.indexOf('{{', cursor);
    let text = source.slice(cursor, start < 0 ? source.length : start);
    if (trimNext) text = text.replace(/^[ \t\r\n]+/, '');
    trimNext = false;
    if (start < 0) { if (text) result.push({kind:'text', value:text, pos:cursor}); break; }
    let at = start + 2;
    if (source[at] === '-' && SPACE.test(source[at + 1] ?? '')) { text = text.replace(/[ \t\r\n]+$/, ''); at++; }
    if (text) result.push({kind:'text', value:text, pos:cursor});
    const contentStart = at;
    while (SPACE.test(source[at] ?? '')) at++;
    if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      if (end < 0) fail('Unclosed template comment', at);
      at = end + 2;
      while (SPACE.test(source[at] ?? '')) at++;
      if (source.startsWith('-}}', at) && SPACE.test(source[at - 1] ?? '')) { trimNext = true; at++; }
      if (!source.startsWith('}}', at)) fail('A comment must occupy its whole template action', at);
      cursor = at + 2; continue;
    }
    let quote = '', end = -1;
    for (at = contentStart; at < source.length; at++) {
      const ch = source[at];
      if (quote) {
        if (ch === '\\' && quote !== '`') at++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (source.startsWith('}}', at)) { end = at; break; }
    }
    if (end < 0) fail('Unclosed template action', start);
    let contentEnd = end;
    if (source[end - 1] === '-' && SPACE.test(source[end - 2] ?? '')) { contentEnd--; trimNext = true; }
    result.push({kind:'action', value:source.slice(contentStart, contentEnd), pos:contentStart});
    cursor = end + 2;
  }
  return result;
}

function lex(text, offset, fail) {
  const tokens = []; let at = 0;
  const add = (type, value, start, extra = {}) => tokens.push({type, value, pos:offset + start, end:offset + at, ...extra});
  const identifier = () => {
    const start = at, first = String.fromCodePoint(text.codePointAt(at) ?? 0);
    if (!ID_START.test(first)) fail('Expected an identifier', offset + at);
    at += first.length;
    while (at < text.length) {
      const next = String.fromCodePoint(text.codePointAt(at));
      if (!ID_PART.test(next)) break;
      at += next.length;
    }
    return text.slice(start, at);
  };
  const path = () => {
    const parts = [];
    while (text[at] === '.') { at++; parts.push(identifier()); }
    return parts;
  };
  while (at < text.length) {
    const ch = text[at], start = at;
    if (SPACE.test(ch)) { at++; continue; }
    if ('|(),='.includes(ch)) { at++; add(ch, ch, start); continue; }
    if (text.startsWith(':=', at)) { at += 2; add(':=', ':=', start); continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; at++; let value = '', closed = false; const chunks = [];
      while (at < text.length) {
        let c = text[at++];
        if (c === quote) { closed = true; break; }
        if (quote === '`') { if (c !== '\r') value += c; continue; }
        if (c === '\n' || c === '\r') fail('Newline in a quoted literal', offset + at - 1);
        if (c !== '\\') { value += c; continue; }
        const escapePos = at - 1; c = text[at++];
        const escapes = {a:'\x07', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t', v:'\x0b', '\\':'\\'};
        if (Object.hasOwn(escapes, c)) { value += escapes[c]; continue; }
        if (c === quote) { value += c; continue; }
        let digits, radix;
        if (c === 'x' || c === 'u' || c === 'U') {
          const count = c === 'x' ? 2 : c === 'u' ? 4 : 8;
          digits = text.slice(at, at + count); radix = 16;
          if (digits.length !== count || !/^[0-9a-f]+$/i.test(digits)) fail('Invalid hexadecimal escape', offset + escapePos);
          at += count;
        } else if (/[0-7]/.test(c ?? '')) {
          digits = c + text.slice(at, at + 2); radix = 8;
          if (!/^[0-7]{3}$/.test(digits)) fail('Invalid octal escape', offset + escapePos);
          at += 2;
        } else fail(`Unsupported escape \\${c ?? ''}`, offset + escapePos);
        const point = parseInt(digits, radix);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) || (radix === 8 && point > 255)) fail('Invalid character escape', offset + escapePos);
        if (quote === '"' && (c === 'x' || radix === 8)) { chunks.push(value, point); value = ''; }
        else value += String.fromCodePoint(point);
      }
      if (!closed) fail('Unclosed quoted literal', offset + start);
      if (chunks.length) { chunks.push(value); value = decodeBytes(chunks.flatMap((chunk) => typeof chunk === 'string' ? bytes(chunk) : [chunk]), fail, offset + start); }
      if (quote === "'") {
        if ([...value].length !== 1) fail('A rune literal must contain one character', offset + start);
        value = value.codePointAt(0);
      }
      add('literal', value, start); continue;
    }
    if (ch === '$') {
      at++; const name = at < text.length && ID_START.test(String.fromCodePoint(text.codePointAt(at))) ? '$' + identifier() : '$';
      const parts = path(); add('variable', name, start, {parts}); continue;
    }
    if (ch === '.' && !/[0-9]/.test(text[at + 1] ?? '')) {
      at++;
      const parts = at < text.length && ID_START.test(String.fromCodePoint(text.codePointAt(at))) ? [identifier(), ...path()] : [];
      add('path', '.', start, {parts}); continue;
    }
    if (/[+\-0-9.]/.test(ch)) {
      while (at < text.length && !SPACE.test(text[at]) && !'|(),='.includes(text[at])) at++;
      const literal = text.slice(start, at), digits = literal.replace(/_/g, '');
      if (literal.includes('_')) {
        const body = literal.replace(/^[+-]/, ''), base = /^0([xXbBoO])/.exec(body)?.[1]?.toLowerCase();
        const digit = base === 'x' ? /[0-9a-fA-F]/ : base === 'b' ? /[01]/ : base === 'o' ? /[0-7]/ : /[0-9]/;
        for (let i = 0; i < body.length; i++) if (body[i] === '_' &&
          (!digit.test(body[i + 1] ?? '') || !(digit.test(body[i - 1] ?? '') || (base && i === 2)))) fail('Invalid numeric separator', offset + start + i);
      }
      let value;
      if (/^[+-]?0[xX][\da-fA-F]+$/.test(digits)) value = parseInt(digits.replace(/^([+-]?)0[xX]/, '$1'), 16);
      else if (/^[+-]?0[bB][01]+$/.test(digits)) value = parseInt(digits.replace(/^([+-]?)0[bB]/, '$1'), 2);
      else if (/^[+-]?0[oO][0-7]+$/.test(digits)) value = parseInt(digits.replace(/^([+-]?)0[oO]/, '$1'), 8);
      else if (/^[+-]?0[0-7]+$/.test(digits)) value = parseInt(digits, 8);
      else if (/^[+-]?0\d+$/.test(digits)) fail('Invalid octal integer literal', offset + start);
      else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(digits)) value = Number(digits);
      else fail(`Unsupported numeric literal ${literal}`, offset + start);
      if (!Number.isFinite(value) || (Number.isInteger(value) && Math.abs(value) > Number.MAX_SAFE_INTEGER)) fail('Numeric literal is outside the supported exact range', offset + start);
      add('literal', value, start); continue;
    }
    if (ID_START.test(String.fromCodePoint(text.codePointAt(at)))) {
      const value = identifier();
      if (value === 'true' || value === 'false' || value === 'nil') add('literal', value === 'nil' ? null : value === 'true', start);
      else add('name', value, start);
      continue;
    }
    fail(`Unsupported template syntax ${ch}`, offset + at);
  }
  return tokens;
}

function parsePipeline(tokens, scope, functions, fail, maxVars = 1) {
  let at = 0;
  const parse = (nested = false) => {
    const pos = tokens[at]?.pos ?? tokens.at(-1)?.end ?? 0;
    const vars = []; let assignment = '';
    let probe = at;
    while (tokens[probe]?.type === 'variable' && !tokens[probe].parts.length) {
      vars.push(tokens[probe]); probe++;
      if (tokens[probe]?.type !== ',') break;
      probe++;
    }
    if (vars.length && [':=', '='].includes(tokens[probe]?.type)) {
      if (vars.length > (nested ? 1 : maxVars)) fail('Variable declaration is not supported here', pos);
      assignment = tokens[probe].type; at = probe + 1;
      const names = new Set();
      for (const token of vars) {
        if (token.value === '$') fail('Reassigning the root variable is not supported', token.pos);
        if (names.has(token.value)) fail('Duplicate variable declaration', token.pos);
        names.add(token.value);
        if (assignment === '=' && !scope.has(token.value)) fail(`Undefined variable ${token.value}`, token.pos);
      }
    } else vars.length = 0;
    const commands = [];
    while (true) {
      const args = [];
      while (at < tokens.length && tokens[at].type !== '|' && tokens[at].type !== ')') {
        const token = tokens[at++]; let atom;
        if (token.type === '(') {
          const pipeline = parse(true);
          if (tokens[at]?.type !== ')') fail('Unclosed parenthesized pipeline', token.pos);
          const end = tokens[at++].end;
          atom = {kind:'pipeline', pipeline, pos:token.pos};
          if (tokens[at]?.type === 'path' && tokens[at].pos === end && tokens[at].parts.length) {
            const chain = tokens[at++]; atom = {kind:'access', base:atom, parts:chain.parts, pos:chain.pos};
          }
        } else if (token.type === 'variable') {
          if (!scope.has(token.value)) fail(`Undefined variable ${token.value}`, token.pos);
          atom = {kind:'variable', name:token.value, parts:token.parts, pos:token.pos};
        } else if (token.type === 'path') atom = {kind:'path', parts:token.parts, pos:token.pos};
        else if (token.type === 'literal') atom = {kind:'literal', value:token.value, pos:token.pos};
        else if (token.type === 'name') {
          if (!functions.has(token.value)) fail(`Unsupported template function ${token.value}`, token.pos);
          atom = {kind:'function', name:token.value, pos:token.pos};
        } else fail(`Unexpected token ${token.value}`, token.pos);
        args.push(atom);
      }
      if (!args.length) fail('Empty template pipeline', tokens[at]?.pos ?? pos);
      if (args[0].kind === 'literal' && args[0].value === null) fail('nil is not a command', args[0].pos);
      if (args[0].kind !== 'function' && (args.length > 1 || commands.length)) fail('Only functions may accept template arguments or pipeline input', args[0].pos);
      commands.push({args, pos:args[0].pos});
      if (tokens[at]?.type !== '|') break;
      at++;
    }
    if (!commands.length) fail('Empty template pipeline', pos);
    if (assignment === ':=') for (const token of vars) scope.add(token.value);
    return {commands, vars:vars.map((token) => token.value), assignment, pos};
  };
  const pipeline = parse();
  if (at !== tokens.length) fail(`Unexpected token ${tokens[at].value}`, tokens[at].pos);
  return pipeline;
}

function compile(source, functions, fail) {
  const parts = segments(source, fail).map((part) => part.kind === 'text' ? part : {...part, tokens:lex(part.value, part.pos, fail)});
  const block = (start, scope) => {
    const nodes = []; let at = start;
    while (at < parts.length) {
      const part = parts[at];
      if (part.kind === 'text') { nodes.push(part); at++; continue; }
      const first = part.tokens[0];
      if (!first) fail('Empty template action', part.pos);
      if (first.type === 'name' && (first.value === 'else' || first.value === 'end')) {
        if (first.value === 'end' && part.tokens.length !== 1) fail('Unexpected arguments after end', first.pos);
        return {nodes, at, stop:part};
      }
      if (first.type === 'name' && ['if', 'with', 'range'].includes(first.value)) {
        const parsed = control(first.value, part.tokens.slice(1), first.pos, at + 1, scope);
        nodes.push(parsed.node); at = parsed.at; continue;
      }
      nodes.push({kind:'action', pipeline:parsePipeline(part.tokens, scope, functions, fail), pos:first.pos}); at++;
    }
    return {nodes, at, stop:null};
  };
  const control = (kind, tokens, pos, start, parentScope) => {
    if (!tokens.length) fail(`${kind} needs a pipeline`, pos);
    const scope = new Set(parentScope), pipeline = parsePipeline(tokens, scope, functions, fail, kind === 'range' ? 2 : 1);
    const body = block(start, new Set(scope));
    if (!body.stop) fail(`Missing end for ${kind}`, pos);
    let otherwise = [], at = body.at + 1;
    if (body.stop.tokens[0].value === 'else') {
      const tail = body.stop.tokens.slice(1);
      if (tail.length) {
        if (tail[0].type !== 'name' || !['if', 'with'].includes(tail[0].value)) fail('Only else if or else with pipelines are supported', tail[0].pos);
        const chain = control(tail[0].value, tail.slice(1), tail[0].pos, at, scope);
        otherwise = [chain.node]; at = chain.at;
      } else {
        const rest = block(at, new Set(scope));
        if (!rest.stop || rest.stop.tokens[0].value !== 'end') fail(`Missing end for ${kind}`, pos);
        otherwise = rest.nodes; at = rest.at + 1;
      }
    }
    return {node:{kind, pipeline, body:body.nodes, otherwise, pos}, at};
  };
  const parsed = block(0, new Set(['$']));
  if (parsed.stop) fail(`Unexpected ${parsed.stop.tokens[0].value}`, parsed.stop.pos);
  return parsed.nodes;
}

function bytes(text) {
  const output = [];
  for (const char of text) {
    let point = char.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
    if (point < 0x80) output.push(point);
    else if (point < 0x800) output.push(0xc0 | point >> 6, 0x80 | point & 63);
    else if (point < 0x10000) output.push(0xe0 | point >> 12, 0x80 | point >> 6 & 63, 0x80 | point & 63);
    else output.push(0xf0 | point >> 18, 0x80 | point >> 12 & 63, 0x80 | point >> 6 & 63, 0x80 | point & 63);
  }
  return output;
}

function decodeBytes(input, fail, pos) {
  let text = '';
  for (let at = 0; at < input.length;) {
    const first = input[at++];
    if (first < 0x80) { text += String.fromCodePoint(first); continue; }
    const count = first >= 0xc2 && first <= 0xdf ? 1 : first >= 0xe0 && first <= 0xef ? 2 : first >= 0xf0 && first <= 0xf4 ? 3 : 0;
    if (!count || at + count > input.length) fail('Non-UTF-8 byte string literals are not supported', pos);
    let code = first & (count === 1 ? 31 : count === 2 ? 15 : 7);
    for (let i = 0; i < count; i++) {
      const part = input[at++];
      if ((part & 0xc0) !== 0x80) fail('Non-UTF-8 byte string literals are not supported', pos);
      code = code << 6 | part & 63;
    }
    if (code < (count === 1 ? 0x80 : count === 2 ? 0x800 : 0x10000) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('Non-UTF-8 byte string literals are not supported', pos);
    text += String.fromCodePoint(code);
  }
  return text;
}

function compareStrings(a, b) {
  const left = [...a], right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i].codePointAt(0) - right[i].codePointAt(0);
  }
  return left.length - right.length;
}

function pairs(value, fail, pos) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((item, index) => [index, item]);
  if (value instanceof Map) {
    const entries = [...value.entries()];
    if (entries.some(([key]) => !['string', 'number', 'boolean'].includes(typeof key))) fail('Unsupported map key type', pos);
    return entries.sort(([a], [b]) => typeof a === 'string' && typeof b === 'string' ? compareStrings(a, b) : a < b ? -1 : a > b ? 1 : 0);
  }
  if (typeof value === 'object') return Object.keys(value).sort(compareStrings).map((key) => [key, property(value, key, fail, pos)]);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value <= 100000) return Array.from({length:Math.max(0, value)}, (_, index) => [index, index]);
  fail('range needs an array, map, or bounded integer', pos);
}

function property(value, key, fail, pos, missingKey = 'error') {
  // Go's default missing-key mode propagates an invalid map value through
  // further field access; a real nil value still fails when dereferenced.
  if (value === undefined && missingKey === 'default') return undefined;
  if (value == null) fail(`Cannot read ${key} from nil`, pos);
  if (value instanceof Map) {
    if (!value.has(key)) { if (missingKey === 'default') return undefined; fail(`Missing map key ${key}`, pos); }
    return value.get(key);
  }
  if (typeof value !== 'object' || Array.isArray(value)) fail(`Cannot read field ${key} from this value`, pos);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) { if (missingKey === 'default') return undefined; fail(`Missing field or map key ${key}`, pos); }
  if (!Object.hasOwn(descriptor, 'value')) fail('Accessor properties are not supported in templates', pos);
  return descriptor.value;
}

function truth(value) {
  if (value == null || value === false || value === 0 || value === 0n || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function display(value, fail, pos, literalNil = false, seen = new Set()) {
  if (value == null) return literalNil ? '<nil>' : '<no value>';
  if (typeof value === 'function' || typeof value === 'symbol') fail('Function and symbol values are not supported', pos);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) fail('Cyclic template data cannot be printed', pos);
  const next = new Set(seen); next.add(value);
  if (Array.isArray(value)) return '[' + value.map((item) => display(item, fail, pos, true, next)).join(' ') + ']';
  return 'map[' + pairs(value, fail, pos).map(([key, item]) => `${key}:${display(item, fail, pos, true, next)}`).join(' ') + ']';
}

function sprint(values, fail, pos, newline = false) {
  let output = '';
  for (let i = 0; i < values.length; i++) {
    if (i && (newline || (typeof values[i - 1] !== 'string' && typeof values[i] !== 'string'))) output += ' ';
    output += display(values[i], fail, pos, true);
  }
  return output + (newline ? '\n' : '');
}

function quoted(value, ascii = false) {
  let result = '"';
  for (const char of value) {
    const code = char.codePointAt(0), escapes = {'"':'\\"', '\\':'\\\\', '\n':'\\n', '\r':'\\r', '\t':'\\t', '\b':'\\b', '\f':'\\f', '\x07':'\\a', '\x0b':'\\v'};
    if (Object.hasOwn(escapes, char)) result += escapes[char];
    else if (code < 32 || code === 127) result += '\\x' + code.toString(16).padStart(2, '0');
    else if ((ascii && code > 127) || code === 0x2028 || code === 0x2029) result += (code <= 0xffff ? '\\u' : '\\U') + code.toString(16).padStart(code <= 0xffff ? 4 : 8, '0');
    else result += char;
  }
  return result + '"';
}

function printf(format, values, fail, pos) {
  if (typeof format !== 'string') fail('printf needs a format string', pos);
  let result = '', next = 0;
  const used = new Set();
  const take = (index = next++) => {
    if (index < 0 || index >= values.length) fail('printf is missing an argument', pos);
    used.add(index); return values[index];
  };
  for (let at = 0; at < format.length;) {
    if (format[at] !== '%') { result += format[at++]; continue; }
    at++;
    if (format[at] === '%') { result += '%'; at++; continue; }
    let flags = '';
    while ('+-# 0'.includes(format[at] ?? '\0')) flags += format[at++];
    let index = null;
    const argumentIndex = () => {
      if (format[at] !== '[') return null;
      const start = ++at; while (/\d/.test(format[at] ?? '')) at++;
      if (start === at || format[at++] !== ']') fail('Unsupported printf argument index', pos);
      const parsed = Number(format.slice(start, at - 1)) - 1;
      if (parsed < 0) fail('printf argument indexes start at one', pos);
      return parsed;
    };
    index = argumentIndex(); if (index !== null) next = index;
    let width = '';
    if (format[at] === '*') { width = take(); at++; index = null; }
    else while (/\d/.test(format[at] ?? '')) width += format[at++];
    let precision = null;
    if (format[at] === '.') {
      at++; precision = ''; const selected = argumentIndex(); if (selected !== null) next = selected;
      if (format[at] === '*') { precision = take(); at++; }
      else while (/\d/.test(format[at] ?? '')) precision += format[at++];
    }
    const selected = argumentIndex(); if (selected !== null) next = selected;
    const verb = format[at++], value = take();
    width = Number(width || 0); precision = precision === null ? null : Number(precision || 0);
    if (!Number.isInteger(width) || Math.abs(width) > 100000 || (precision !== null && (!Number.isInteger(precision) || precision < 0 || precision > 100))) fail('Unsupported printf width or precision', pos);
    if (width < 0) { width = -width; flags += '-'; }
    let text, numericPrefix = '', integer = false;
    if (verb === 'v') {
      if (flags.includes('#') || precision !== null) fail('Go-syntax or precision formatting for %v is not supported', pos);
      text = display(value, fail, pos, true);
    } else if (verb === 's' || verb === 'q') {
      if (typeof value !== 'string') fail(`printf %${verb} needs a string`, pos);
      text = precision === null ? value : [...value].slice(0, precision).join('');
      if (verb === 'q') text = flags.includes('#') && !/[`\x00-\x08\x0a-\x1f\x7f]/.test(text) ? '`' + text + '`' : quoted(text, flags.includes('+'));
    } else if (verb === 't') {
      if (typeof value !== 'boolean') fail('printf %t needs a boolean', pos);
      text = String(value);
    } else if (['d', 'b', 'o', 'O', 'x', 'X', 'c'].includes(verb)) {
      if (typeof value === 'string' && (verb === 'x' || verb === 'X')) {
        const octets = bytes(value).slice(0, precision ?? Infinity);
        text = octets.map((byte) => byte.toString(16).padStart(2, '0')).join(flags.includes(' ') ? ' ' : '');
        if (flags.includes('#')) text = '0x' + text;
      } else {
        if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value))) fail(`printf %${verb} needs an exact integer`, pos);
        if (verb === 'c') {
          const code = Number(value); text = code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
        } else {
          integer = true;
          const negative = value < 0, magnitude = negative ? -value : value;
          const radix = verb === 'd' ? 10 : verb === 'b' ? 2 : verb === 'o' || verb === 'O' ? 8 : 16;
          text = magnitude.toString(radix).padStart(precision ?? 0, '0');
          numericPrefix = verb === 'O' ? '0o' : flags.includes('#') ? ({b:'0b', o:text.startsWith('0') ? '' : '0', x:'0x', X:'0X'}[verb] ?? '') : '';
          text = precision === 0 && magnitude == 0 ? '' : (negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + numericPrefix + text;
        }
      }
      if (verb === 'X') text = text.toUpperCase();
    } else if (['f', 'F', 'e', 'E', 'g', 'G'].includes(verb)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`printf %${verb} needs a finite number`, pos);
      const decimals = precision ?? (verb.toLowerCase() === 'g' && !flags.includes('#') ? null : 6);
      if (verb.toLowerCase() === 'f') text = value.toFixed(decimals);
      else if (verb.toLowerCase() === 'e') text = value.toExponential(decimals);
      else {
        const exponent = value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value))), significant = Math.max(1, decimals ?? 6);
        if (exponent < -4 || exponent >= significant) text = decimals === null ? value.toExponential() : value.toExponential(significant - 1);
        else text = decimals === null ? String(value) : value.toFixed(Math.min(100, Math.max(0, significant - 1 - exponent)));
      }
      if (verb.toLowerCase() === 'g' && text.includes('.') && !flags.includes('#')) text = text.replace(/(\.\d*?[1-9])0+(e|$)/i, '$1$2').replace(/\.0*(e|$)/i, '$1');
      if (flags.includes('#') && !text.includes('.')) text = text.replace(/(e|$)/i, '.$1');
      text = text.replace(/e([+-])(\d)$/, 'e$10$2');
      if (value >= 0 && flags.includes('+')) text = '+' + text;
      else if (value >= 0 && flags.includes(' ')) text = ' ' + text;
      if (verb === verb.toUpperCase()) text = text.toUpperCase();
    } else fail(`Unsupported printf verb %${verb ?? ''}`, pos);
    const zeroPad = flags.includes('0') && !(integer && precision !== null);
    const padding = Math.max(0, width - [...text].length + (zeroPad && integer && numericPrefix !== '0' ? numericPrefix.length : 0));
    if (flags.includes('-')) text += ' '.repeat(padding);
    else if (zeroPad) {
      const prefix = /^[+\- ]?(?:0[xXob])?/.exec(text)[0];
      text = prefix + '0'.repeat(padding) + text.slice(prefix.length);
    } else text = ' '.repeat(padding) + text;
    result += text;
  }
  if (used.size < values.length) fail('printf has unused arguments', pos);
  return result;
}

class Scope {
  constructor(parent = null) { this.parent = parent; this.values = new Map(); }
  owner(name) { return this.values.has(name) ? this : this.parent?.owner(name); }
  get(name) { return this.owner(name)?.values.get(name); }
  set(name, value, declare = false) { (declare ? this : this.owner(name) ?? this).values.set(name, value); }
}

function parseTemplate(text, colors, allowCommands) {
  if (typeof text !== 'string') throw new TypeError('Template must be text');
  const fail = (message, pos) => { throw new TemplateError(message, text, pos); };
  const functions = new Set(BUILTINS);
  if (!allowCommands) { functions.delete('quote'); functions.delete('runCommand'); }
  for (const name of Object.keys(colors)) if (COLOR_NAMES.has(name) && typeof colors[name] === 'function') functions.add(name);
  return {nodes:compile(text, functions, fail), fail};
}

// A parse-only entry point lets menu generation validate both formats even
// when a command returns no lines, just as Go template.Parse does upstream.
export function validateTemplate(text, {colors = {}, allowCommands = true} = {}) {
  parseTemplate(text, colors, allowCommands);
}

export async function renderTemplate(text, data, {quote, runCommand, colors = {}, missingKey = 'error', mapZeroValue = null, allowCommands = true} = {}) {
  if (!['error', 'default'].includes(missingKey)) throw new TypeError('missingKey must be error or default');
  const {nodes, fail} = parseTemplate(text, colors, allowCommands);
  const scope = new Scope(); scope.set('$', data, true);
  const access = (value, parts, pos) => { for (const part of parts) value = property(value, part, fail, pos, missingKey); return value; };
  const count = (name, args, min, max = min, pos) => { if (args.length < min || args.length > max) fail(`${name} expects ${min === max ? min : `${min} or more`} arguments`, pos); };
  const invoke = async (name, args, pos) => {
    if (name === 'quote' || name === 'runCommand' || COLOR_NAMES.has(name)) {
      if (!COLOR_NAMES.has(name)) { count(name, args, 1, 1, pos); if (typeof args[0] !== 'string') fail(`${name} needs a string`, pos); }
      const fn = name === 'quote' ? quote : name === 'runCommand' ? runCommand : colors[name];
      if (typeof fn !== 'function') fail(`${name} requires an injected implementation`, pos);
      let value;
      try { value = await fn(COLOR_NAMES.has(name) ? sprint(args, fail, pos) : args[0]); }
      catch (error) { fail(`${name} failed: ${error?.message ?? error}`, pos); }
      if (typeof value !== 'string') fail(`${name} must return text`, pos);
      if (name === 'runCommand') {
        value = value.replace(/[\r\n]+$/, '');
        // This is upstream custom.go's actual check: embedded LF alone passes.
        if (value.includes('\r\n')) fail('runCommand output contains newlines', pos);
      }
      return value;
    }
    if (name === 'print' || name === 'println') return sprint(args, fail, pos, name === 'println');
    if (name === 'printf') { count(name, args, 1, Infinity, pos); return printf(args[0], args.slice(1), fail, pos); }
    if (name === 'not') { count(name, args, 1, 1, pos); return !truth(args[0]); }
    if (name === 'len') {
      count(name, args, 1, 1, pos); const value = args[0];
      if (typeof value === 'string') return bytes(value).length;
      if (Array.isArray(value)) return value.length;
      if (value instanceof Map) return value.size;
      if (value && typeof value === 'object') return Object.keys(value).length;
      fail('len needs a string, array, or map', pos);
    }
    if (name === 'index') {
      count(name, args, 1, Infinity, pos); let value = args[0];
      for (const key of args.slice(1)) {
        if (Array.isArray(value) || typeof value === 'string') {
          const list = typeof value === 'string' ? bytes(value) : value;
          if (!Number.isInteger(key) || key < 0 || key >= list.length) fail('index is outside the value', pos);
          value = list[key];
        } else if (value instanceof Map) value = value.has(key) ? value.get(key) : mapZeroValue;
        else if (value && typeof value === 'object' && typeof key === 'string') value = Object.hasOwn(value, key) ? property(value, key, fail, pos) : mapZeroValue;
        else fail('index needs an array, string, or map with a matching key type', pos);
      }
      return value;
    }
    count(name, args, 2, name === 'eq' ? Infinity : 2, pos);
    const equal = (a, b) => {
      if (a == null || b == null) return a == null && b == null;
      if (typeof a !== typeof b) fail('Cannot compare values of different types', pos);
      if (typeof a === 'object' || typeof a === 'function') fail('Comparing arrays or maps is not supported', pos);
      return a === b;
    };
    if (name === 'eq') { for (const value of args.slice(1)) if (equal(args[0], value)) return true; return false; }
    if (name === 'ne') return !equal(args[0], args[1]);
    if (!['string', 'number', 'bigint'].includes(typeof args[0]) || typeof args[0] !== typeof args[1]) fail('Ordered comparison needs matching numbers or strings', pos);
    const order = typeof args[0] === 'string' ? compareStrings(args[0], args[1]) : args[0] < args[1] ? -1 : args[0] > args[1] ? 1 : 0;
    return name === 'lt' ? order < 0 : name === 'le' ? order <= 0 : name === 'gt' ? order > 0 : order >= 0;
  };
  const atom = async (node, context) => {
    if (node.kind === 'literal') return node.value;
    if (node.kind === 'path') return access(context.dot, node.parts, node.pos);
    if (node.kind === 'variable') return access(context.scope.get(node.name), node.parts, node.pos);
    if (node.kind === 'access') return access(await atom(node.base, context), node.parts, node.pos);
    if (node.kind === 'function') return invoke(node.name, [], node.pos);
    return pipeline(node.pipeline, context);
  };
  const pipeline = async (node, context) => {
    let value;
    for (let index = 0; index < node.commands.length; index++) {
      const command = node.commands[index], [head, ...terms] = command.args;
      if (head.kind !== 'function') { value = await atom(head, context); continue; }
      if (head.name === 'and' || head.name === 'or') {
        if (!terms.length && !index) fail(`${head.name} needs an argument`, head.pos);
        let found = false, resolved;
        for (const term of terms) {
          resolved = await atom(term, context);
          if (truth(resolved) === (head.name === 'or')) { found = true; break; }
        }
        if (!found && index) resolved = value;
        value = resolved; continue;
      }
      const args = []; for (const term of terms) args.push(await atom(term, context));
      if (index) args.push(value);
      value = await invoke(head.name, args, head.pos);
    }
    for (const name of node.vars) context.scope.set(name, value, node.assignment === ':=');
    return value;
  };
  const render = async (list, context) => {
    let output = '';
    for (const node of list) {
      if (node.kind === 'text') { output += node.value; continue; }
      if (node.kind === 'action') {
        const value = await pipeline(node.pipeline, context);
        if (!node.pipeline.vars.length) output += display(value, fail, node.pos);
        continue;
      }
      const nested = {dot:context.dot, scope:new Scope(context.scope)}, value = await pipeline(node.pipeline, nested);
      if (node.kind === 'range') {
        if (typeof value === 'number' && node.pipeline.vars.length > 1) fail('An integer range supports only one variable', node.pos);
        const entries = pairs(value, fail, node.pos);
        if (!entries.length) output += await render(node.otherwise, {dot:context.dot, scope:new Scope(nested.scope)});
        for (const [key, item] of entries) {
          const vars = node.pipeline.vars, values = vars.length === 2 ? [key, item] : [item];
          for (let i = 0; i < vars.length; i++) nested.scope.set(vars[i], values[i]);
          output += await render(node.body, {dot:item, scope:new Scope(nested.scope)});
        }
      } else if (truth(value)) output += await render(node.body, {dot:node.kind === 'with' ? value : context.dot, scope:new Scope(nested.scope)});
      else output += await render(node.otherwise, {dot:context.dot, scope:new Scope(nested.scope)});
    }
    return output;
  };
  return render(nodes, {dot:data, scope});
}

// mgutz/str.ToArgv, used by upstream Custom.RunWithOutput. This is deliberately
// not a shell: only space/tab delimit, quotes concatenate, and Unix backslash
// consumes the next character even inside single quotes. Windows has its own
// upstream rule (backslash retained unless followed by a double quote).
export function splitCommandArgs(text, {platform = 'posix'} = {}) {
  if (typeof text !== 'string') throw new TypeError('Command must be text');
  const fail = (message, offset) => { throw new TemplateError(message, text, offset); };
  let state = 'out', quote = '', value = '', quoteAt = 0; const args = [];
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '"' || char === "'") {
      if (state === 'quote') { if (char === quote) state = 'in'; else value += char; }
      else { if (state === 'out') value = ''; state = 'quote'; quote = char; quoteAt = at; }
    } else if (char === ' ' || char === '\t') {
      if (state === 'in') { args.push(value); state = 'out'; }
      else if (state === 'quote') value += char;
    } else if (char === '\\') {
      if (state === 'out') { value = ''; state = 'in'; }
      if (platform === 'windows') { if (text[at + 1] !== '"') value += char; }
      else { if (at === text.length - 1) fail('Escape character at end of command', at); value += text[++at]; }
    } else { if (state === 'out') { value = ''; state = 'in'; } value += char; }
  }
  if (state === 'quote') fail('Starting quote has no ending quote', quoteAt);
  if (state === 'in') args.push(value);
  return args;
}
