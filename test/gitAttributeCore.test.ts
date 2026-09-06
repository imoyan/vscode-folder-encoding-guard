import assert from "node:assert/strict";
import test from "node:test";
import { parseGitAttributeOutput } from "../src/gitAttributeCore.js";

test("parses null-delimited git check-attr output", () => {
  const output = Buffer.from(
    "legacy/a.txt\0eol\0crlf\0src/b.ts\0eol\0lf\0README.md\0eol\0unspecified\0",
  );
  assert.deepEqual(parseGitAttributeOutput(output), [
    { path: "legacy/a.txt", attribute: "eol", value: "crlf" },
    { path: "src/b.ts", attribute: "eol", value: "lf" },
    { path: "README.md", attribute: "eol", value: "unspecified" },
  ]);
});

test("parses empty values and ignores incomplete records", () => {
  const output = Buffer.from("a.txt\0text\0set\0b.txt\0working-tree-encoding\0\0incomplete\0eol");
  assert.deepEqual(parseGitAttributeOutput(output), [
    { path: "a.txt", attribute: "text", value: "set" },
    { path: "b.txt", attribute: "working-tree-encoding", value: "" },
  ]);
});
