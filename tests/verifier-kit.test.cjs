const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.join(__dirname, '..');
const kitTool = path.join(root, 'tools', 'verifier-kit.cjs');
const fixture = name => path.join(root, 'research', name);
const capture = fixture('example-evidence-browser-batch-capture.json');
const transition = fixture('example-evidence-reference-transition-capture.json');
const reference = fixture('example-evidence-reference-baseline.json');
const referenceB = fixture('example-evidence-reference-conflict.json');
const checkpoint = fixture('example-evidence-ledger-checkpoint.json');
const receipts = [fixture('example-evidence-excerpt.json'), fixture('example-evidence-receipt.json')];

function temporary(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aru-verifier-kit-'));
  try { return callback(dir); }
  finally { fs.rmSync(dir, {recursive: true, force: true}); }
}

function node(args, cwd = root) {
  return spawnSync(process.execPath, args, {encoding: 'utf8', cwd});
}

test('archived kit replays a capture through Node and independent Python outside the repository', () => temporary(dir => {
  const kit = path.join(dir, 'kit');
  const created = node([kitTool, 'create', capture, kit]);
  assert.equal(created.status, 0, created.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(kit, 'manifest.json'), 'utf8'));
  assert.equal(manifest.browser_script_sha256, JSON.parse(fs.readFileSync(capture, 'utf8')).browser_script_sha256);
  assert.equal(manifest.files.length, 11);
  assert.deepEqual(fs.readdirSync(kit).sort(), ['README.md', 'index.html', 'manifest.json', 'tools']);
  assert.equal(fs.existsSync(path.join(kit, 'research')), false);
  assert.equal(fs.existsSync(path.join(kit, 'capture.json')), false);
  const verified = node([path.join(kit, 'tools', 'verifier-kit.cjs'), 'check', kit, capture], dir);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /KIT MATCH: 11 archived files.*supplied capture/);
  const args = [reference, ...receipts, '--checkpoint', checkpoint, '--check-capture', capture];
  const replay = node([path.join(kit, 'tools', 'audit-evidence-batch.cjs'), ...args], dir);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /CAPTURE MATCH/);
  const independent = spawnSync('python3',
    [path.join(kit, 'tools', 'independent-evidence-batch.py'), ...args], {encoding: 'utf8', cwd: dir});
  assert.equal(independent.status, 0, independent.stderr);
  assert.match(independent.stdout, /CAPTURE MATCH: independent Python replay agrees/);
  const decision = node([path.join(kit, 'tools', 'review-evidence.cjs'), ...args, '--json'], dir);
  assert.equal(decision.status, 0, decision.stderr);
  assert.equal(JSON.parse(decision.stdout).receipt_assessment, 'all_receipts_match');

  const another = path.join(dir, 'same-kit');
  assert.equal(node([kitTool, 'create', capture, another]).status, 0);
  assert.equal(fs.readFileSync(path.join(kit, 'manifest.json'), 'utf8'),
    fs.readFileSync(path.join(another, 'manifest.json'), 'utf8'));
}));

test('kit checker rejects a changed verifier, unexpected file, and altered capture script', () => temporary(dir => {
  const kit = path.join(dir, 'kit');
  assert.equal(node([kitTool, 'create', capture, kit]).status, 0);
  const checker = path.join(kit, 'tools', 'verifier-kit.cjs');
  const verifier = path.join(kit, 'tools', 'verify-evidence-receipt.cjs');
  fs.appendFileSync(verifier, '\n// changed after packaging\n');
  const changed = node([checker, 'check', kit, capture], dir);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /Kit file differs from manifest: tools\/verify-evidence-receipt.cjs/);
  fs.copyFileSync(path.join(root, 'tools', 'verify-evidence-receipt.cjs'), verifier);
  const reviewer = path.join(kit, 'tools', 'review-evidence.cjs');
  fs.appendFileSync(reviewer, '\n// changed after packaging\n');
  assert.match(node([checker, 'check', kit, capture], dir).stderr,
    /Kit file differs from manifest: tools\/review-evidence.cjs/);
  fs.copyFileSync(path.join(root, 'tools', 'review-evidence.cjs'), reviewer);
  fs.writeFileSync(path.join(kit, 'tools', 'unexpected.txt'), 'extra');
  assert.match(node([checker, 'check', kit, capture], dir).stderr, /missing or unexpected files/);
  fs.rmSync(path.join(kit, 'tools', 'unexpected.txt'));
  const modifiedCapture = {...JSON.parse(fs.readFileSync(capture, 'utf8')),
    browser_script_sha256: '0'.repeat(64)};
  const changedCapture = path.join(dir, 'changed-capture.json');
  fs.writeFileSync(changedCapture, JSON.stringify(modifiedCapture));
  assert.match(node([checker, 'check', kit, changedCapture], dir).stderr,
    /Capture requires different browser script bytes/);
}));

test('a paired transition capture creates an offline kit that independently replays both sides', () => temporary(dir => {
  const kit = path.join(dir, 'paired-kit');
  const created = node([kitTool, 'create', transition, kit]);
  assert.equal(created.status, 0, created.stderr);
  const checked = node([path.join(kit, 'tools/verifier-kit.cjs'), 'check', kit, transition], dir);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /KIT MATCH/);
  const args = [reference, ...receipts, '--checkpoint', checkpoint, '--reference-b', referenceB,
    '--check-transition', transition, '--explain-additions'];
  const replay = node([path.join(kit, 'tools/audit-evidence-batch.cjs'), ...args], dir);
  assert.equal(replay.status, 0, replay.stderr);
  assert.match(replay.stdout, /TRANSITION CAPTURE MATCH.*Inspect A and B counts independently/);
  assert.match(replay.stdout, /#1 answer witness: 1 added source.*#2/);
  const independent = spawnSync('python3',
    [path.join(kit, 'tools/independent-evidence-batch.py'), ...args], {encoding: 'utf8', cwd: dir});
  assert.equal(independent.status, 0, independent.stderr);
  assert.match(independent.stdout, /TRANSITION CAPTURE MATCH/);
  assert.match(independent.stdout, /#1 answer witness: 1 added source.*#2/);
  assert.equal(fs.existsSync(path.join(kit, 'transition.json')), false);
  assert.equal(fs.existsSync(path.join(kit, 'research')), false);

  const original = JSON.parse(fs.readFileSync(transition, 'utf8'));
  const bad = path.join(dir, 'changed.json');
  fs.writeFileSync(bad, JSON.stringify({...original, changed_receipts: []}));
  const rejected = path.join(dir, 'rejected-kit');
  assert.match(node([kitTool, 'create', bad, rejected]).stderr, /Paired transition sides disagree/);
  assert.equal(fs.existsSync(rejected), false);
}));

test('creation refuses a mismatched or legacy capture before writing and never replaces a destination', () => temporary(dir => {
  const altered = {...JSON.parse(fs.readFileSync(capture, 'utf8')),
    browser_script_sha256: '0'.repeat(64)};
  const changed = path.join(dir, 'changed.json');
  fs.writeFileSync(changed, JSON.stringify(altered));
  const refused = path.join(dir, 'refused');
  const mismatch = node([kitTool, 'create', changed, refused]);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /archived code version/);
  assert.equal(fs.existsSync(refused), false);

  const {browser_script_sha256, ...old} = altered;
  const legacy = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({...old, version: 1}));
  assert.match(node([kitTool, 'create', legacy, refused]).stderr, /version 2 or 3 browser batch capture/);
  assert.equal(fs.existsSync(refused), false);

  fs.mkdirSync(refused);
  fs.writeFileSync(path.join(refused, 'sentinel'), 'keep this');
  const existing = node([kitTool, 'create', capture, refused]);
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /Destination already exists/);
  assert.equal(fs.readFileSync(path.join(refused, 'sentinel'), 'utf8'), 'keep this');
}));
