export const DEFAULT_BACKUP_SUFFIXES = [
  ".sql",
  ".sql.gz",
  ".sql.bz2",
  ".sql.xz",
  ".sql.zip",
  ".sql.zst",
  ".dump",
  ".dump.gz",
  ".dump.bz2",
  ".backup",
  ".bak",
  ".rdb",
] as const;

export interface Env {
  RETENTION_DAYS?: string;
  DRY_RUN?: string;
  BACKUP_SUFFIXES?: string;
  BUCKETS?: string;
  REGIONS?: string;
}

export interface CleanupConfig {
  retentionDays: number;
  dryRun: boolean;
  suffixes: string[];
  /** Null scans every bucket returned by ListBuckets. */
  buckets: string[] | null;
  /** Null scans every region. */
  regions: string[] | null;
}

export function readConfig(env: Env): CleanupConfig {
  return {
    retentionDays: parseRetentionDays(env.RETENTION_DAYS),
    dryRun: parseBool("DRY_RUN", env.DRY_RUN, false),
    suffixes: parseList(env.BACKUP_SUFFIXES, [...DEFAULT_BACKUP_SUFFIXES]).map((suffix) =>
      normalizeSuffix(suffix.toLowerCase()),
    ),
    buckets: env.BUCKETS?.trim() ? parseList(env.BUCKETS, []) : null,
    regions: env.REGIONS?.trim()
      ? parseList(env.REGIONS, []).map((region) => region.toLowerCase())
      : null,
  };
}

function parseRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 7;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("RETENTION_DAYS must be a whole number of days, 0 or greater.");
  }
  return parsed;
}

function parseBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new Error(`${name} must be true or false.`);
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") return fallback;
  return [...new Set(value.split(",").map((part) => part.trim()).filter(Boolean))];
}

function normalizeSuffix(suffix: string): string {
  return suffix.startsWith(".") ? suffix : `.${suffix}`;
}
