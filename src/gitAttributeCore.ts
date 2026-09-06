export interface GitAttributeRecord {
  readonly path: string;
  readonly attribute: string;
  readonly value: string;
}

export function parseGitAttributeOutput(output: Uint8Array): GitAttributeRecord[] {
  const fields = Buffer.from(output).toString("utf8").split("\0");
  const entries: GitAttributeRecord[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const filePath = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (filePath && attribute && value !== undefined) {
      entries.push({ path: filePath, attribute, value });
    }
  }
  return entries;
}
