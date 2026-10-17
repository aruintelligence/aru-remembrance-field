"use strict";

// JSON.parse has already checked syntax. Walk the original text to retain every
// object member name, including names a normal parse would silently overwrite.
// Decode each name with JSON.parse so escaped spellings compare as the same name.
function parseUnambiguousJSON(text) {
  const parsed = JSON.parse(text);
  let offset = 0;
  let depth = 0;
  const white = () => { while (/\s/.test(text[offset] || "") && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") offset++;
      else if (char === '"') break;
    }
    return JSON.parse(text.slice(start, offset));
  };
  const value = () => {
    white();
    if (++depth > 128) throw new SyntaxError("JSON nesting exceeds 128 levels");
    if (text[offset] === '"') string();
    else if (text[offset] === "{" || text[offset] === "[") {
      const object = text[offset++] === "{";
      const seen = object ? new Set() : null;
      white();
      const closing = object ? "}" : "]";
      while (text[offset] !== closing) {
        if (object) {
          const name = string();
          if (seen.has(name)) throw new SyntaxError("Duplicate JSON object name");
          seen.add(name);
          white(); offset++; // ':'; syntax was validated by JSON.parse.
        }
        value();
        white();
        if (text[offset] === ",") { offset++; white(); }
      }
      offset++;
    } else {
      while (offset < text.length && !/[\s,\]}]/.test(text[offset])) offset++;
    }
    depth--;
  };
  value();
  return parsed;
}

module.exports = {parseUnambiguousJSON};
