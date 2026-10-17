#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_CODE_BYTES = 2 * 1024 * 1024;
const CODE_FILES = [
  "index.html",
  "tools/audit-evidence-batch.cjs",
  "tools/benchmark-evidence.cjs",
  "tools/verify-evidence-receipt.cjs",
  "tools/independent-evidence-batch.py",
  "tools/verifier-kit.cjs"
];
const FILES = [...CODE_FILES, "README.md"];
const README = `# ĀRU offline verifier kit

This folder preserves the exact browser page and the Node and independent Python
batch checkers for a version 2 browser audit capture. It contains no selected
reference, checkpoint, receipt, or capture file. Keep those originals separately
and provide them explicitly when replaying a capture.

From this folder, with Node.js 22+ and Python 3.12+ installed:

\`\`\`bash
node tools/verifier-kit.cjs check . /path/to/capture.json
node tools/audit-evidence-batch.cjs /path/to/reference.json /path/to/receipt-1.json --checkpoint /path/to/checkpoint.json --check-capture /path/to/capture.json
python3 tools/independent-evidence-batch.py /path/to/reference.json /path/to/receipt-1.json --checkpoint /path/to/checkpoint.json --check-capture /path/to/capture.json
\`\`\`

Omit \`--checkpoint\` when the original capture has no checkpoint. Supply all
receipts in their original order. A CAPTURE MATCH can reproduce DIFFER or FAIL
rows, so inspect every outcome. A kit check compares bytes with this folder's
manifest and the browser script with the capture. The Node and Python commands
recompute the actual audit from the selected original files. Neither the
manifest nor the capture is signed, timestamped, or proof of factual truth,
authorship, completeness, or independent custody. Keep a trusted copy of the
capture and code separately if those properties matter.
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactly(value, names) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
}

function regularBytes(file, limit, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error(`${label} must be a regular file of at most ${limit} bytes`);
  const bytes = fs.readFileSync(file);
  if (bytes.length > limit) throw new Error(`${label} exceeds ${limit} bytes`);
  return bytes;
}

function captureScriptHash(file) {
  const bytes = regularBytes(file, MAX_CAPTURE_BYTES, "Capture");
  let capture;
  try { capture = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes)); }
  catch (_) { throw new Error("Capture is not valid UTF-8 JSON"); }
  const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  if (!exactly(capture, ["format", "version", "browser_script_sha256", "reference_sha256",
    "checkpoint_sha256", "receipts", "totals"]) ||
      capture.format !== "aru-evidence-browser-batch-capture" || capture.version !== 2 ||
      !digest(capture.browser_script_sha256) || !digest(capture.reference_sha256) ||
      (capture.checkpoint_sha256 !== null && !digest(capture.checkpoint_sha256)) ||
      !Array.isArray(capture.receipts) || capture.receipts.length < 1 || capture.receipts.length > 20 ||
      !exactly(capture.totals, ["match", "differ", "fail", "identical_copies"])) {
    throw new Error("Expected a well-formed version 2 browser batch capture");
  }
  const counts = {MATCH: 0, DIFFER: 0, FAIL: 0};
  let repeats = 0;
  for (const [index, item] of capture.receipts.entries()) {
    if (!exactly(item, ["index", "sha256", "verdict", "duplicate_of"]) ||
        item.index !== index + 1 || !digest(item.sha256) || !Object.hasOwn(counts, item.verdict) ||
        (item.duplicate_of !== null && (!Number.isSafeInteger(item.duplicate_of) ||
          item.duplicate_of < 1 || item.duplicate_of >= item.index))) {
      throw new Error(`Invalid capture receipt #${index + 1}`);
    }
    counts[item.verdict]++;
    if (item.duplicate_of !== null) repeats++;
  }
  if (capture.totals.match !== counts.MATCH || capture.totals.differ !== counts.DIFFER ||
      capture.totals.fail !== counts.FAIL || capture.totals.identical_copies !== repeats) {
    throw new Error("Capture totals disagree with its receipt rows");
  }
  return capture.browser_script_sha256;
}

function scriptHash(htmlBytes) {
  const html = new TextDecoder("utf-8", {fatal: true}).decode(htmlBytes);
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!script || html.indexOf("<script>", script.index + 1) !== -1) {
    throw new Error("Expected exactly one inline browser script");
  }
  return sha256(Buffer.from(script[1], "utf8"));
}

function kitFiles(root) {
  return FILES.map(name => {
    const bytes = name === "README.md" ? Buffer.from(README, "utf8") :
      regularBytes(path.join(root, name), MAX_CODE_BYTES, name);
    return {name, bytes, entry: {path: name, bytes: bytes.length, sha256: sha256(bytes)}};
  });
}

function checkKit(folder, captureFile) {
  const root = path.resolve(folder);
  if (!fs.lstatSync(root).isDirectory() || !fs.lstatSync(path.join(root, "tools")).isDirectory()) {
    throw new Error("Kit and tools paths must be directories, not links");
  }
  const expectedTop = ["README.md", "index.html", "manifest.json", "tools"];
  const expectedTools = CODE_FILES.filter(name => name.startsWith("tools/"))
    .map(name => path.basename(name));
  if (JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify(expectedTop.sort()) ||
      JSON.stringify(fs.readdirSync(path.join(root, "tools")).sort()) !== JSON.stringify(expectedTools.sort())) {
    throw new Error("Kit has missing or unexpected files");
  }
  const manifestBytes = regularBytes(path.join(root, "manifest.json"), MAX_CAPTURE_BYTES, "Manifest");
  let manifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(manifestBytes)); }
  catch (_) { throw new Error("Manifest is not valid UTF-8 JSON"); }
  if (!exactly(manifest, ["format", "version", "browser_script_sha256", "files"]) ||
      manifest.format !== "aru-offline-verifier-kit" || manifest.version !== 1 ||
      !Array.isArray(manifest.files) || manifest.files.length !== FILES.length ||
      !/^[0-9a-f]{64}$/.test(manifest.browser_script_sha256)) {
    throw new Error("Unsupported verifier kit manifest");
  }
  for (const [index, name] of FILES.entries()) {
    const entry = manifest.files[index];
    const bytes = regularBytes(path.join(root, name), MAX_CODE_BYTES, name);
    if (!exactly(entry, ["path", "bytes", "sha256"]) || entry.path !== name ||
        entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) {
      throw new Error(`Kit file differs from manifest: ${name}`);
    }
  }
  if (scriptHash(regularBytes(path.join(root, "index.html"), MAX_CODE_BYTES, "Browser page")) !==
      manifest.browser_script_sha256) {
    throw new Error("Browser script differs from kit manifest");
  }
  if (captureFile && captureScriptHash(captureFile) !== manifest.browser_script_sha256) {
    throw new Error("Capture requires different browser script bytes");
  }
  return {files: FILES.length, captureChecked: !!captureFile};
}

function createKit(captureFile, folder) {
  const wantedScript = captureScriptHash(captureFile);
  const source = path.resolve(__dirname, "..");
  const files = kitFiles(source);
  if (scriptHash(files[0].bytes) !== wantedScript) {
    throw new Error("Capture requires different browser script bytes; use its archived code version");
  }
  const target = path.resolve(folder);
  if (fs.existsSync(target)) throw new Error("Destination already exists; choose a new empty path");
  fs.mkdirSync(target, {mode: 0o700});
  try {
    fs.mkdirSync(path.join(target, "tools"), {mode: 0o700});
    for (const file of files) {
      fs.writeFileSync(path.join(target, file.name), file.bytes, {flag: "wx", mode: 0o600});
    }
    const manifest = {format: "aru-offline-verifier-kit", version: 1,
      browser_script_sha256: wantedScript, files: files.map(file => file.entry)};
    fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n",
      {flag: "wx", mode: 0o600});
    checkKit(target, captureFile);
    return target;
  } catch (error) {
    fs.rmSync(target, {recursive: true, force: true});
    throw error;
  }
}

function run(args = process.argv.slice(2)) {
  if (args[0] === "create" && args.length === 3) {
    const folder = createKit(args[1], args[2]);
    console.log(`KIT CREATED: ${folder}. Preserve the capture and original files separately.`);
  } else if (args[0] === "check" && (args.length === 2 || args.length === 3)) {
    const result = checkKit(args[1], args[2]);
    console.log(`KIT MATCH: ${result.files} archived files agree with the manifest; browser script agrees${result.captureChecked ? " with the supplied capture" : " internally"}.`);
    console.log("This is a consistency check, not proof of origin, time, completeness, or factual truth.");
  } else {
    throw new Error("Usage: node tools/verifier-kit.cjs create <capture.json> <new-kit-dir> | check <kit-dir> [capture.json]");
  }
}

if (require.main === module) {
  try { run(); }
  catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
}

module.exports = {createKit, checkKit, run};
