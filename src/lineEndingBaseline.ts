export const LINE_ENDING_BASELINE_KEY = "lineEndingBaseline.v2";

import {
  LineEndingClassification,
  LineEndingKind,
  LineEndingSnapshot,
  LineEndingStyle,
} from "./scanCore.js";

export interface LineEndingBaseline {
  readonly kind: LineEndingKind;
  readonly styles?: readonly LineEndingStyle[];
  readonly identity: string;
  readonly source: "git" | "baseline";
}

export interface LineEndingReference {
  readonly previous?: LineEndingSnapshot;
  readonly source?: "git" | "baseline";
}

export interface LineEndingComparisonPlan {
  readonly reference: LineEndingReference;
  readonly nextBaseline?: LineEndingBaseline;
}

export interface LineEndingComparisonInput {
  readonly current: LineEndingClassification;
  readonly head?: LineEndingClassification;
  readonly historyIdentity?: string;
  readonly historyUnavailable: boolean;
  readonly fallbackIdentity: string;
  readonly compatibleStoredIdentities?: readonly string[];
  readonly stored?: LineEndingBaseline;
}

export function isPortableLocalBaseline(
  baseline: LineEndingBaseline | undefined,
  expectedEncoding: string,
): boolean {
  if (!baseline || baseline.source !== "baseline") {
    return false;
  }
  return (
    baseline.identity === "legacy:v1" ||
    baseline.identity === `unavailable:${expectedEncoding}` ||
    baseline.identity === `non-git:${expectedEncoding}` ||
    isUntrackedGitBaselineIdentity(baseline.identity, expectedEncoding)
  );
}

export function isUntrackedGitBaselineIdentity(
  identity: string | undefined,
  expectedEncoding: string,
): boolean {
  return identity?.startsWith("git-untracked:") === true &&
    identity.endsWith(`:${expectedEncoding}`);
}

export function planLineEndingComparison(
  input: LineEndingComparisonInput,
): LineEndingComparisonPlan {
  const activeIdentity = input.historyIdentity ?? input.fallbackIdentity;
  const storedIsCompatible =
    input.stored !== undefined &&
    (input.stored.identity === activeIdentity ||
      input.compatibleStoredIdentities?.includes(input.stored.identity) === true);
  const matchingBaseline = storedIsCompatible ? input.stored : undefined;
  if (input.head !== undefined) {
    const nextBaseline: LineEndingBaseline = {
      kind: input.head.kind,
      styles: input.head.styles,
      identity: activeIdentity,
      source: "git",
    };
    return {
      reference: { previous: input.head, source: "git" },
      nextBaseline,
    };
  }
  if (matchingBaseline) {
    let nextBaseline = matchingBaseline.identity === activeIdentity
      ? matchingBaseline
      : { ...matchingBaseline, identity: activeIdentity };
    if (
      nextBaseline.source === "baseline" &&
      nextBaseline.kind === "mixed" &&
      nextBaseline.styles === undefined &&
      input.current.kind === "mixed"
    ) {
      nextBaseline = { ...nextBaseline, styles: input.current.styles };
    }
    return {
      reference: {
        previous: {
          kind: matchingBaseline.kind,
          ...(matchingBaseline.styles === undefined
            ? {}
            : { styles: matchingBaseline.styles }),
        },
        source: matchingBaseline.source,
      },
      nextBaseline,
    };
  }
  if (
    input.historyUnavailable &&
    input.historyIdentity === undefined &&
    input.stored
  ) {
    return { reference: {}, nextBaseline: input.stored };
  }
  return {
    reference: {},
    nextBaseline: {
      kind: input.current.kind,
      styles: input.current.styles,
      identity: activeIdentity,
      source: "baseline",
    },
  };
}

export function parseLineEndingBaselines(
  stored: unknown,
): ReadonlyMap<string, LineEndingBaseline> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return new Map();
  }
  const validKinds = new Set<LineEndingKind>(["lf", "crlf", "cr", "mixed", "none"]);
  return new Map(
    Object.entries(stored).flatMap(([key, value]) => {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("kind" in value) ||
        !("identity" in value) ||
        !("source" in value) ||
        !validKinds.has(value.kind as LineEndingKind) ||
        typeof value.identity !== "string" ||
        (value.source !== "git" && value.source !== "baseline")
      ) {
        return [];
      }
      const styles = parseStoredStyles(
        value.kind as LineEndingKind,
        "styles" in value ? value.styles : undefined,
      );
      if (styles === "invalid") {
        return [];
      }
      return [[key, {
        kind: value.kind as LineEndingKind,
        ...(styles === undefined ? {} : { styles }),
        identity: value.identity,
        source: value.source,
      }] as const];
    }),
  );
}

export function parseLegacyLineEndingBaselines(
  stored: unknown,
): ReadonlyMap<string, LineEndingBaseline> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return new Map();
  }
  const validKinds = new Set<LineEndingKind>(["lf", "crlf", "cr", "mixed", "none"]);
  return new Map(
    Object.entries(stored).flatMap(([key, value]) =>
      validKinds.has(value as LineEndingKind)
        ? [[key, {
          kind: value as LineEndingKind,
          ...((value as LineEndingKind) === "mixed"
            ? {}
            : { styles: inferredStyles(value as LineEndingKind) }),
          identity: "legacy:v1",
          source: "baseline" as const,
        }] as const]
        : [],
    ),
  );
}

function parseStoredStyles(
  kind: LineEndingKind,
  stored: unknown,
): readonly LineEndingStyle[] | undefined | "invalid" {
  if (stored === undefined) {
    return kind === "mixed" ? undefined : inferredStyles(kind);
  }
  if (!Array.isArray(stored)) {
    return "invalid";
  }
  const validStyles = new Set<LineEndingStyle>(["lf", "crlf", "cr"]);
  if (
    stored.some((style) => typeof style !== "string" || !validStyles.has(style as LineEndingStyle))
  ) {
    return "invalid";
  }
  const styles = stored as LineEndingStyle[];
  const canonical = ["lf", "crlf", "cr"].filter(
    (style): style is LineEndingStyle => styles.includes(style as LineEndingStyle),
  );
  if (
    canonical.length !== styles.length ||
    canonical.some((style, index) => style !== styles[index]) ||
    kindForStyles(styles) !== kind
  ) {
    return "invalid";
  }
  return [...styles];
}

function inferredStyles(kind: LineEndingKind): readonly LineEndingStyle[] {
  return kind === "none" || kind === "mixed" ? [] : [kind];
}

function kindForStyles(styles: readonly LineEndingStyle[]): LineEndingKind {
  return styles.length === 0 ? "none" : styles.length === 1 ? styles[0]! : "mixed";
}
