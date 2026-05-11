// One-shot migration: rewrite the existing force IDs in
// public/data/state.json from their legacy numeric form into the new
// deterministic `${login}-${epochMs}-${seq}` shape.
//
// We trace each currently-present force ID back to the commit that
// introduced it (using `git log --reverse` to walk the history of
// state.json), then synthesize a new ID from that commit's
// author-from-subject + commit timestamp.
//
// "Author" is parsed from the commit subject (`move: @username ...`) —
// not from `%an`, because the merging actor on auto-merged PRs is the
// repo owner regardless of who submitted. Subject parsing matches the
// actual move authorship.
//
// Forces with no traceable @author (typically seed forces in the
// initial bake commit) get author = 'seed'.
//
// Run once:
//   node scripts/migrate-force-ids.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const FILE = 'public/data/state.json';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
}

// `git show <sha>:path` fails if the file didn't exist yet at <sha>.
// Treat that as "no forces at this commit".
function readStateAt(sha) {
  try {
    const txt = git('show', `${sha}:${FILE}`);
    const data = JSON.parse(txt);
    return Array.isArray(data.forces) ? data.forces : [];
  } catch {
    return [];
  }
}

const logLines = git('log', '--reverse', '--format=%H|%at|%s', '--', FILE)
  .trim()
  .split('\n');

// Walk history; track last commit each ID was newly introduced.
// "Newly introduced" = present in this commit but not the prior one.
// Last wins so a deletion-then-readd attributes to the re-adder.
const introduced = new Map(); // string id → { author, epochMs }
let prev = new Set();
for (const line of logLines) {
  const [sha, at, subject] = line.split('|');
  const epochMs = Number(at) * 1000;
  const m = subject.match(/@([A-Za-z0-9-]+)/);
  const author = m ? m[1] : 'seed';
  const cur = new Set(readStateAt(sha).map((f) => String(f.id)));
  for (const id of cur) {
    if (!prev.has(id)) introduced.set(id, { author, epochMs });
  }
  prev = cur;
}

// Load current snapshot, rewrite IDs.
const snap = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
const seqCounter = new Map(); // `${author}-${epochMs}` → next seq

let migrated = 0;
let untraceable = 0;
for (const force of snap.forces) {
  const oldId = String(force.id);
  const info = introduced.get(oldId) ?? { author: 'seed', epochMs: 0 };
  if (info.author === 'seed' && info.epochMs === 0) untraceable++;
  const key = `${info.author}-${info.epochMs}`;
  const seq = seqCounter.get(key) ?? 0;
  seqCounter.set(key, seq + 1);
  force.id = `${info.author}-${info.epochMs}-${seq}`;
  migrated++;
}

fs.writeFileSync(FILE, JSON.stringify(snap, null, 2) + '\n');
console.log(`Migrated ${migrated} force IDs (${untraceable} untraceable, fell back to seed-0).`);
console.log(`Sample IDs:`);
for (const f of snap.forces.slice(0, 5)) console.log(`  ${f.id}  (${f.nation}: ${f.name})`);
