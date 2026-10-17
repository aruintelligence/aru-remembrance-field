"use strict";

const {createHash} = require("node:crypto");

// Versioned, length-framed digest of the normalizations of selected names.
// Original file hashes bind the input strings; this commits to the runtime's
// interpretation without placing the strings themselves in a capture.
function selectedNames(values) {
  const names = new Set();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const row of Array.isArray(value.records) && value.records.length <= 100 ?
      value.records : []) {
      if (typeof row?.key === "string" && row.key.length <= 500) names.add(row.key);
    }
    if (typeof value.question === "string" && value.question.length <= 500) {
      names.add(value.question);
    }
    for (const name of Array.isArray(value.names) && value.names.length <= 8 ?
      value.names : []) {
      if (typeof name === "string" && name.length <= 500) names.add(name);
    }
  }
  if (names.size > 2500) throw new Error("Too many selected strings");
  return [...names];
}

function profileHash(names, normalize) {
  const hash = createHash("sha256").update("aru-selected-normalization-v1\n", "ascii");
  for (const name of names) {
    const bytes = Buffer.from(normalize(name), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest("hex");
}

module.exports = {selectedNames, profileHash};
