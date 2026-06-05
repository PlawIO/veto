import { createHash } from "node:crypto";

function assertJsonValue(value: unknown, path: string): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${path}: non-finite numbers cannot be committed`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJsonValue(value[i], `${path}[${i}]`);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) {
        throw new Error(`${path}.${key}: undefined cannot be committed`);
      }
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path}: ${typeof value} cannot be committed`);
}

export function canonicalize(value: unknown): string {
  assertJsonValue(value, "$");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Prefixed(input: string | Uint8Array): string {
  const hash = createHash("sha256").update(input).digest("hex");
  return `sha256:${hash}`;
}

export function computeCommitment(value: unknown): string {
  return sha256Prefixed(canonicalize(value));
}
