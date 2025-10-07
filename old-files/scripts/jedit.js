#!/usr/bin/env node

/**
 * jedit.js
 * Read JSON (object or NDJSON) from stdin and apply key mutations or read values.
 *
 * Features:
 * - Set/add/remove/rename keys with dot/bracket paths (arrays supported).
 * - Append to arrays via [] or [-] at END of path, e.g. --set list[]='"x"'.
 * - --push/-p path=value | path value  (append without writing [] yourself).
 * - Load values from files with @file (parsed as JSON if possible, else raw text).
 *   Escape literal leading '@' with @@ (e.g. @@foo -> "@foo").
 * - NEW: --get/-g path   Output the value at path as JSON.
 *   • Single JSON: prints the JSON value (honors --pretty).
 *   • NDJSON: prints one JSON value per line (always compact), uses null if missing.
 *
 * Usage examples:
 *   cat in.json | ./jedit.js --set user.name="Ada" --set flags[0]=true --pretty
 *   cat in.json | ./jedit.js --add config.port=8080
 *   echo '{"list":["a"]}' | ./jedit.js --set list[]='"b"'
 *   echo '{"users":[]}' | ./jedit.js --push users @user.json
 *   echo '{}' | ./jedit.js --set cfg=@config.json
 *   echo '{"a":{"b":[{"c":5}]}}' | ./jedit.js --get a.b[0].c
 *   # combine ops + get:
 *   echo '{}' | ./jedit.js --set a.b=1 --get a.b
 */

const fs = require('fs');

function showHelp() {
  const text = `
Usage:
  cat input.json   | jedit.js [ops] [--get path] [--pretty]
  cat input.ndjson | jedit.js [ops] [--get path] [--pretty] [--ndjson]

Operations (repeatable):
  --set,   -s  path=value     Set (create/overwrite) a value at path.
  --add,   -a  path=value     Add only if path is missing; if path ends with [] or [-], append to array.
  --remove,-r  path           Remove at path.
  --rename,-R  old:new        Move value from old path to new path.
  --push,  -p  path value     Append to array at path. Also supports "path=value".
  --get,   -g  path           Print the value at path as JSON. For NDJSON input, prints one compact JSON per line.

Path syntax:
  - Dot segments: a.b.c
  - Arrays:       items[0].name
  - Append:       list[] or list[-] (only allowed at END of path)
  - Escape dot/brackets/backslash in key name with "\\": a.b\\.c or key\\[with\\]brackets

Values:
  - Parsed as JSON when possible (true, 42, "str", {}, []...).
  - Use @file to load value from a file (parsed as JSON if possible; otherwise raw text).
  - Use @@ to escape a leading @ (e.g., @@foo -> literal string "@foo").

Examples:
  echo '{"list":["a"]}' | jedit.js -s list[]='"b"'
  echo '{}' | jedit.js -s config=@config.json
  echo '{}' | jedit.js -p users '{"name":"Ada"}'
  echo '{}' | jedit.js --push users @user.json
  echo '{"a":{"b":[{"c":5}]}}' | jedit.js -g a.b[0].c
`;
  console.error(text.trim());
}

// --- Argument parsing ---
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  showHelp();
  process.exit(0);
}

const ops = []; // preserve order
let pretty = false;
let forceNdjson = false;
let getPath = null;

function pushOp(type, payload) { ops.push({ type, ...payload }); }

// Parse args with support for repeated flags
for (let i = 0; i < argv.length; i++) {
  const tok = argv[i];

  if (tok === '--pretty') { pretty = true; continue; }
  if (tok === '--ndjson') { forceNdjson = true; continue; }

  const next = () => {
    if (i + 1 >= argv.length) {
      console.error(`Missing argument after ${tok}`);
      process.exit(1);
    }
    return argv[++i];
  };

  if (tok === '--set' || tok === '-s') {
    const arg = next();
    const idx = arg.indexOf('=');
    if (idx < 0) {
      console.error(`--set requires path=value, got: ${arg}`);
      process.exit(1);
    }
    const path = arg.slice(0, idx);
    const valueRaw = arg.slice(idx + 1);
    pushOp('set', { path, valueRaw });
    continue;
  }

  if (tok === '--add' || tok === '-a') {
    const arg = next();
    const idx = arg.indexOf('=');
    if (idx < 0) {
      console.error(`--add requires path=value, got: ${arg}`);
      process.exit(1);
    }
    const path = arg.slice(0, idx);
    const valueRaw = arg.slice(idx + 1);
    pushOp('add', { path, valueRaw });
    continue;
  }

  if (tok === '--remove' || tok === '-r') {
    const path = next();
    pushOp('remove', { path });
    continue;
  }

  if (tok === '--rename' || tok === '-R') {
    const arg = next();
    const idx = arg.indexOf(':');
    if (idx < 0) {
      console.error(`--rename requires old:new, got: ${arg}`);
      process.exit(1);
    }
    const from = arg.slice(0, idx);
    const to = arg.slice(idx + 1);
    pushOp('rename', { from, to });
    continue;
  }

  if (tok === '--push' || tok === '-p') {
    // Accept "--push path=value" OR "--push path value"
    const a1 = next();
    let path, valueRaw;
    const eq = a1.indexOf('=');
    if (eq >= 0) {
      path = a1.slice(0, eq);
      valueRaw = a1.slice(eq + 1);
    } else {
      path = a1;
      valueRaw = next();
    }
    const segs = parsePath(path);
    if (segs.length === 0) {
      console.error(`--push requires a non-empty path`);
      process.exit(1);
    }
    if (segs[segs.length - 1] !== '-') segs.push('-'); // ensure append
    pushOp('push', { segs, valueRaw });
    continue;
  }

  if (tok === '--get' || tok === '-g') {
    if (getPath !== null) {
      console.error('Only one --get path is supported.');
      process.exit(1);
    }
    getPath = next();
    continue;
  }

  console.error(`Unknown argument: ${tok}`);
  process.exit(1);
}

// --- Path utilities ---
function parsePath(path) {
  const segs = [];
  let buf = '';
  let i = 0;
  while (i < path.length) {
    const ch = path[i];

    if (ch === '\\') {
      if (i + 1 < path.length) {
        const next = path[i + 1];
        if (next === '.' || next === '\\' || next === '[' || next === ']') {
          buf += next;
          i += 2;
          continue;
        }
      }
      buf += '\\';
      i += 1;
      continue;
    }

    if (ch === '.') {
      segs.push(buf);
      buf = '';
      i += 1;
      continue;
    }

    if (ch === '[') {
      if (buf) {
        segs.push(buf);
        buf = '';
      }
      i += 1;
      let content = '';
      while (i < path.length && path[i] !== ']') {
        content += path[i];
        i += 1;
      }
      if (path[i] !== ']') throw new Error(`Unclosed [ at: ${path}`);
      i += 1; // skip ']'
      if (content === '' || content === '-') {
        segs.push('-'); // append marker
      } else if (/^\d+$/.test(content)) {
        segs.push(Number(content));
      } else {
        throw new Error(`Array index must be a number, [], or [-]; got: [${content}]`);
      }
      continue;
    }

    buf += ch;
    i += 1;
  }
  if (buf.length) segs.push(buf);
  return segs.filter(s => s !== '');
}

function ensureContainer(parent, key, nextKey) {
  if (parent[key] === undefined) {
    parent[key] = (typeof nextKey === 'number' || nextKey === '-') ? [] : {};
  }
}

function getAt(obj, path) {
  const segs = Array.isArray(path) ? path : parsePath(path);
  if (segs.includes('-')) {
    throw new Error('Append marker "[]" is not valid for reading values');
  }
  let cur = obj;
  for (const s of segs) {
    if (cur == null || !(s in cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

function setAt(obj, path, value) {
  const segs = Array.isArray(path) ? path : parsePath(path);
  if (segs.length === 0) return obj;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    const nk = segs[i + 1];
    if (k === '-') throw new Error('Append marker not allowed in mid-path');
    if (typeof k === 'number') {
      if (!Array.isArray(cur)) {
        throw new Error(`Expected array while traversing at segment [${k}]`);
      }
      if (cur[k] === undefined) cur[k] = (typeof nk === 'number' || nk === '-') ? [] : {};
      cur = cur[k];
    } else {
      if (typeof cur !== 'object' || cur === null) {
        throw new Error(`Cannot traverse into non-object at "${k}"`);
      }
      ensureContainer(cur, k, nk);
      cur = cur[k];
    }
  }
  const last = segs[segs.length - 1];
  if (last === '-') {
    if (!Array.isArray(cur)) throw new Error('Append marker used on non-array');
    cur.push(value);
  } else if (typeof last === 'number') {
    if (!Array.isArray(cur)) throw new Error(`Expected array at final segment [${last}]`);
    cur[last] = value;
  } else {
    if (typeof cur !== 'object' || cur === null) {
      throw new Error(`Cannot set key on non-object at final segment "${last}"`);
    }
    cur[last] = value;
  }
  return obj;
}

function hasAt(obj, path) {
  const segs = Array.isArray(path) ? path : parsePath(path);
  if (segs[segs.length - 1] === '-') return false;
  let cur = obj;
  for (const s of segs) {
    if (cur == null || !(s in cur)) return false;
    cur = cur[s];
  }
  return true;
}

function removeAt(obj, path) {
  const segs = Array.isArray(path) ? path : parsePath(path);
  if (segs.includes('-')) throw new Error('Append marker "[]" not valid for --remove');
  if (segs.length === 0) return obj;
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur == null) return obj;
    cur = cur[s];
  }
  const last = segs[segs.length - 1];
  if (cur == null) return obj;
  if (Array.isArray(cur) && typeof last === 'number') {
    if (last >= 0 && last < cur.length) cur.splice(last, 1);
  } else if (typeof cur === 'object') {
    delete cur[last];
  }
  return obj;
}

// --- Value parsing with @file support ---
function loadFileValue(spec) {
  const filePath = spec.slice(1); // drop leading '@'
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const trimmed = data.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      return data; // raw text
    }
  } catch (e) {
    console.error(`Cannot read value file "${filePath}": ${e.message}`);
    process.exit(1);
  }
}

function parseValue(valueRaw) {
  if (typeof valueRaw === 'string' && valueRaw.startsWith('@@')) {
    valueRaw = valueRaw.slice(1); // drop one '@'
  } else if (typeof valueRaw === 'string' && valueRaw.startsWith('@')) {
    return loadFileValue(valueRaw);
  }
  try {
    return JSON.parse(valueRaw);
  } catch {
    return valueRaw;
  }
}

function applyOps(obj) {
  for (const op of ops) {
    try {
      if (op.type === 'set') {
        setAt(obj, op.path, parseValue(op.valueRaw));
      } else if (op.type === 'add') {
        const segs = parsePath(op.path);
        if (segs[segs.length - 1] === '-') {
          setAt(obj, segs, parseValue(op.valueRaw));
        } else if (!hasAt(obj, segs)) {
          setAt(obj, segs, parseValue(op.valueRaw));
        }
      } else if (op.type === 'remove') {
        removeAt(obj, op.path);
      } else if (op.type === 'rename') {
        const val = getAt(obj, op.from);
        if (val !== undefined) {
          removeAt(obj, op.from);
          setAt(obj, op.to, val);
        }
      } else if (op.type === 'push') {
        setAt(obj, op.segs, parseValue(op.valueRaw));
      }
    } catch (e) {
      console.error(`Operation failed (${op.type}): ${e.message}`);
      process.exit(1);
    }
  }
  return obj;
}

// --- Read stdin ---
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  input = input.trim();
  if (!input) {
    console.error('No input received on stdin.');
    process.exit(1);
  }

  const out = [];
  const printDoc = (obj, isNdjson) => {
    if (getPath !== null) {
      let v;
      try {
        v = getAt(obj, getPath);
      } catch (e) {
        console.error(`--get failed: ${e.message}`);
        process.exit(1);
      }
      if (v === undefined) v = null;
      const s = isNdjson ? JSON.stringify(v)
                         : (pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v));
      out.push(s);
    } else {
      out.push(pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
    }
  };

  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return undefined; }
  };

  let processed = false;

  // Forced NDJSON mode
  if (forceNdjson) {
    const lines = input.split(/\r?\n/).filter(l => l.trim() !== '');
    for (const line of lines) {
      const obj = tryParse(line);
      if (obj === undefined) {
        console.error('NDJSON parse error on line: ' + line.slice(0, 120));
        process.exit(1);
      }
      const mutated = applyOps(obj);
      printDoc(mutated, /*isNdjson=*/true); // compact always for NDJSON
    }
    processed = true;
  }

  // Auto-detect NDJSON: all non-empty lines are JSON
  if (!processed) {
    const lines = input.split(/\r?\n/).filter(l => l.trim() !== '');
    const allJson = lines.length > 1 && lines.every(l => tryParse(l) !== undefined);
    if (allJson) {
      for (const line of lines) {
        const obj = JSON.parse(line);
        const mutated = applyOps(obj);
        printDoc(mutated, /*isNdjson=*/true);
      }
      processed = true;
    }
  }

  // Single JSON document
  if (!processed) {
    const obj = tryParse(input);
    if (obj === undefined) {
      console.error('Input is not valid JSON or NDJSON.');
      process.exit(1);
    }
    const mutated = applyOps(obj);
    printDoc(mutated, /*isNdjson=*/false);
  }

  process.stdout.write(out.join('\n') + '\n');
});
process.stdin.resume();
