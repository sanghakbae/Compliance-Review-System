/**
 * Row → Firestore document transforms.
 *
 * Rules: snake_case → camelCase; ISO timestamp strings → Firestore Timestamp;
 * Postgres arrays pass through; uuid ids reused as document ids.
 */

import { Timestamp } from "firebase-admin/firestore";

const TIMESTAMP_FIELDS = new Set([
  "createdAt",
  "updatedAt",
  "retrievalTimestamp",
  "effectiveDate",
  "versionEffectiveDate",
]);

export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function coerce(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (TIMESTAMP_FIELDS.has(key) && typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : Timestamp.fromDate(date);
  }
  return value;
}

/** Convert a Postgres row to a camelCased Firestore field map. */
export function rowToFields(
  row: Record<string, unknown>,
  opts: { omit?: string[] } = {},
): Record<string, unknown> {
  const omit = new Set(opts.omit ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (omit.has(k)) continue;
    const camel = snakeToCamel(k);
    out[camel] = coerce(camel, v);
  }
  return out;
}
