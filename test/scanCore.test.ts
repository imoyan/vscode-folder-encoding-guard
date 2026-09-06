import assert from "node:assert/strict";
import test from "node:test";
import { EncodingCodec } from "../src/conversionCore.js";
import {
  classifyEncoding,
  classifyConsistentLineEndings,
  classifyLineEndings,
  isExpectedEncodingForLineEndings,
  detectLineEndingChange,
  EncodingClassificationCancelledError,
} from "../src/scanCore.js";

const codec: EncodingCodec = {
  async decode(bytes, encoding) {
    if (encoding === "utf8" || encoding === "utf8bom") {
      const offset = encoding === "utf8bom" && bytes[0] === 0xef ? 3 : 0;
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset));
    }
    if (encoding === "windows1252" || encoding === "iso88591") {
      return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
    }
    if (encoding === "utf16le" || encoding === "utf16be") {
      return new TextDecoder("utf-16le", { fatal: true }).decode(
        encoding === "utf16le" ? bytes : swapBytePairs(bytes),
      );
    }
    throw new Error(`unsupported test encoding: ${encoding}`);
  },
  async encode(text, encoding) {
    if (encoding === "utf8") {
      return new TextEncoder().encode(text);
    }
    if (encoding === "utf8bom") {
      return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    }
    if (encoding === "windows1252" || encoding === "iso88591") {
      if (Array.from(text).some((character) => character.charCodeAt(0) > 0xff)) {
        throw new Error("not representable");
      }
      return new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));
    }
    if (encoding === "utf16le" || encoding === "utf16be") {
      const bytes = Buffer.from(text, "utf16le");
      return encoding === "utf16le" ? bytes : swapBytePairs(bytes);
    }
    throw new Error(`unsupported test encoding: ${encoding}`);
  },
};

test("treats ASCII as compatible with an ASCII-superset rule", async () => {
  assert.deepEqual(
    await classifyEncoding(new TextEncoder().encode("plain text"), "shiftjis", codec),
    { kind: "ascii" },
  );
});

test("treats an empty file as encoding-neutral", async () => {
  assert.deepEqual(await classifyEncoding(new Uint8Array(), "utf16le", codec), {
    kind: "ascii",
  });
  assert.deepEqual(await classifyEncoding(new Uint8Array(), "utf8bom", codec), {
    kind: "ascii",
  });
});

test("does not call ASCII-looking bytes UTF-8 when UTF-16 is expected", async () => {
  assert.deepEqual(
    await classifyEncoding(Buffer.from("あい", "utf16le"), "utf16le", codec),
    { kind: "ambiguous", candidates: ["utf8", "utf16le"] },
  );
});

test("detects a short BOM-less UTF-16 file under a UTF-8 rule", async () => {
  assert.deepEqual(
    await classifyEncoding(Buffer.from("a\n", "utf16le"), "utf8", codec),
    { kind: "mismatch", detectedEncoding: "utf16le" },
  );
});

test("withholds line endings when ambiguous encodings disagree", () => {
  const bytes = new TextEncoder().encode("a\n");
  assert.equal(
    classifyConsistentLineEndings(
      bytes,
      { kind: "ambiguous", candidates: ["utf8", "utf16le"] },
      "utf16le",
    ),
    undefined,
  );
  assert.deepEqual(
    classifyConsistentLineEndings(
      new TextEncoder().encode("one line"),
      { kind: "ambiguous", candidates: ["utf8", "utf16le"] },
      "utf16le",
    ),
    { kind: "none", styles: [] },
  );
});

test("detects matching and mismatching UTF-8", async () => {
  const bytes = new TextEncoder().encode("日本語");
  assert.deepEqual(await classifyEncoding(bytes, "utf8", codec), {
    kind: "match",
    detectedEncoding: "utf8",
  });
  assert.deepEqual(await classifyEncoding(bytes, "shiftjis", codec), {
    kind: "mismatch",
    detectedEncoding: "utf8",
  });
});

test("uses a BOM as an explicit signal", async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("日本語")]);
  assert.deepEqual(await classifyEncoding(bytes, "utf8bom", codec), {
    kind: "match",
    detectedEncoding: "utf8bom",
  });
  assert.deepEqual(await classifyEncoding(bytes, "utf8", codec), {
    kind: "mismatch",
    detectedEncoding: "utf8bom",
  });
});

test("does not guess when UTF-8 and the expected single-byte encoding both round-trip", async () => {
  const bytes = new TextEncoder().encode("café");
  assert.deepEqual(await classifyEncoding(bytes, "windows1252", codec), {
    kind: "ambiguous",
    candidates: ["utf8", "windows1252"],
  });
});

test("does not guess when configured single-byte encodings overlap", async () => {
  const overlappingCodec: EncodingCodec = {
    async decode(bytes, encoding) {
      if (encoding === "utf8") {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      if (encoding === "shiftjis" || encoding === "windows1252") {
        return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
      }
      throw new Error(`unsupported test encoding: ${encoding}`);
    },
    async encode(text, encoding) {
      if (encoding === "utf8") {
        return new TextEncoder().encode(text);
      }
      if (encoding === "shiftjis" || encoding === "windows1252") {
        return new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));
      }
      throw new Error(`unsupported test encoding: ${encoding}`);
    },
  };
  assert.deepEqual(
    await classifyEncoding(
      new Uint8Array([0xa6]),
      "shiftjis",
      overlappingCodec,
      { alternativeEncodings: ["shiftjis", "windows1252"] },
    ),
    {
      kind: "ambiguous",
      candidates: ["shiftjis", "windows1252"],
    },
  );
});

test("stops encoding probes after cancellation", async () => {
  let cancelled = false;
  const probed: string[] = [];
  const cancellingCodec: EncodingCodec = {
    async decode(_bytes, encoding) {
      probed.push(encoding);
      await Promise.resolve();
      cancelled = true;
      throw new Error("invalid encoding");
    },
    async encode() {
      throw new Error("encode must not run");
    },
  };

  await assert.rejects(
    classifyEncoding(
      new Uint8Array([0x80]),
      "shiftjis",
      cancellingCodec,
      {
        alternativeEncodings: ["windows1252"],
        isCancellationRequested: () => cancelled,
      },
    ),
    EncodingClassificationCancelledError,
  );
  assert.deepEqual(probed, ["utf8"]);
});

test("recognizes LF, CRLF, CR, and files without line endings", () => {
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\nb\n")), {
    kind: "lf",
    styles: ["lf"],
  });
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\r\nb\r\n")), {
    kind: "crlf",
    styles: ["crlf"],
  });
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\rb\r")), {
    kind: "cr",
    styles: ["cr"],
  });
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("one line")), {
    kind: "none",
    styles: [],
  });
});

test("reports mixed line endings without double-counting CRLF", () => {
  assert.deepEqual(classifyLineEndings(new TextEncoder().encode("a\r\nb\nc\r")), {
    kind: "mixed",
    styles: ["lf", "crlf", "cr"],
  });
});

test("recognizes UTF-16 line endings", () => {
  const utf16le = new Uint8Array([0xff, 0xfe, 0x61, 0, 0x0d, 0, 0x0a, 0, 0x62, 0]);
  assert.deepEqual(classifyLineEndings(utf16le), {
    kind: "crlf",
    styles: ["crlf"],
  });
});

test("verifies the encoding before interpreting HEAD line endings", async () => {
  assert.equal(
    await isExpectedEncodingForLineEndings(
      new Uint8Array([0xc3, 0xa9, 0x0a]),
      "windows1252",
      codec,
    ),
    true,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      Buffer.from("a\n", "utf16le"),
      "utf16le",
      codec,
    ),
    true,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      Buffer.from("「日本語」\n", "utf16le"),
      "utf16le",
      codec,
    ),
    true,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      new TextEncoder().encode("a\nb\n"),
      "utf16le",
      codec,
    ),
    false,
  );
  assert.equal(
    await isExpectedEncodingForLineEndings(
      Buffer.from("あい", "utf16le"),
      "utf16le",
      codec,
    ),
    true,
  );
});

function swapBytePairs(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("odd UTF-16 byte length");
  }
  const swapped = Uint8Array.from(bytes);
  for (let index = 0; index < swapped.length; index += 2) {
    [swapped[index], swapped[index + 1]] = [swapped[index + 1]!, swapped[index]!];
  }
  return swapped;
}

test("detects line ending changes only after a baseline exists", () => {
  const lf = { kind: "lf", styles: ["lf"] } as const;
  assert.equal(detectLineEndingChange(undefined, lf), undefined);
  assert.equal(detectLineEndingChange(lf, lf), undefined);
  assert.deepEqual(detectLineEndingChange({ kind: "crlf", styles: ["crlf"] }, lf), {
    from: "crlf",
    to: "lf",
    fromStyles: ["crlf"],
    toStyles: ["lf"],
  });
  assert.deepEqual(
    detectLineEndingChange(
      { kind: "mixed", styles: ["lf", "crlf"] },
      { kind: "mixed", styles: ["lf", "cr"] },
    ),
    {
      from: "mixed",
      to: "mixed",
      fromStyles: ["lf", "crlf"],
      toStyles: ["lf", "cr"],
    },
  );
  assert.equal(
    detectLineEndingChange(
      { kind: "mixed" },
      { kind: "mixed", styles: ["lf", "cr"] },
    ),
    undefined,
  );
});
