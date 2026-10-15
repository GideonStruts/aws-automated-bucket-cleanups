export interface BackupObject {
  region: string;
  bucket: string;
  key: string;
  lastModified: Date;
}

export interface RetentionPlan {
  keep: BackupObject[];
  remove: BackupObject[];
  /** Newest object in a series that is already older than the retention window. */
  retainedLatest: BackupObject[];
}

const DATE_TIME =
  /\d{4}-\d{2}-\d{2}[tT ]?\d{2}[:-]?\d{2}[:-]?\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?/gi;
const DATE_DASH = /\d{4}-\d{2}-\d{2}/g;
const DATE_UNDERSCORE = /\d{4}_\d{2}_\d{2}(?:_\d{2}_\d{2}_\d{2})?/g;
const COMPACT_DATE_TIME = /(?<![0-9])\d{8}[_-]?\d{6}(?![0-9])/g;
const COMPACT_DATE = /(?<![0-9])\d{8}(?![0-9])/g;
const EPOCH = /(?<![0-9])\d{13}(?![0-9])|(?<![0-9])\d{10}(?![0-9])/g;
const CLOCK = /(?<![0-9])(?:[01]\d|2[0-3])[:-][0-5]\d[:-][0-5]\d(?![0-9])/g;
const HMS = /(?<![0-9])(?:[01]\d|2[0-3])[0-5]\d[0-5]\d(?![0-9])/g;
const YEAR = /(?<![0-9])(?:19|20)\d{2}(?![0-9])/g;

export function isBackupKey(key: string, suffixes: readonly string[]): boolean {
  return longestSuffix(key, suffixes) !== null;
}

/**
 * Identity of one database's backup history.
 *
 * Dates and times are removed from the folder path and the file name, so
 * `2026/10/01/app.sql.gz` and `2026/10/08/app.sql.gz` stay in one series.
 * The bucket, region, and remaining folder names stay in the identity, so a
 * different database, folder, or bucket is never treated as a newer copy.
 */
export function backupSeriesId(
  object: Pick<BackupObject, "region" | "bucket" | "key">,
  suffixes: readonly string[],
): string {
  const suffix = longestSuffix(object.key, suffixes) ?? "";
  const slash = object.key.lastIndexOf("/");
  const directory = slash === -1 ? "" : object.key.slice(0, slash);
  const filename = slash === -1 ? object.key : object.key.slice(slash + 1);
  const stem = filename.slice(0, filename.length - suffix.length);
  const folders = stripDateSegments(directory.split("/").filter((segment) => segment.length > 0));
  return [object.region, object.bucket, ...folders, normalizeStem(stem)].join("/");
}

export function planRetention(
  objects: readonly BackupObject[],
  now: Date,
  retentionDays: number,
  suffixes: readonly string[],
): RetentionPlan {
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error("retentionDays must be a non-negative number.");
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const groups = new Map<string, BackupObject[]>();
  for (const object of objects) {
    const id = backupSeriesId(object, suffixes);
    const group = groups.get(id);
    if (group) group.push(object);
    else groups.set(id, [object]);
  }

  const keep: BackupObject[] = [];
  const remove: BackupObject[] = [];
  const retainedLatest: BackupObject[] = [];

  for (const group of groups.values()) {
    let newest = Number.NEGATIVE_INFINITY;
    for (const object of group) {
      const time = object.lastModified.getTime();
      if (time > newest) newest = time;
    }

    for (const object of group) {
      const time = object.lastModified.getTime();
      const latest = time === newest;
      const expired = time < cutoff;
      if (!expired) {
        keep.push(object);
        continue;
      }
      if (latest) {
        keep.push(object);
        retainedLatest.push(object);
        continue;
      }
      remove.push(object);
    }
  }

  return { keep, remove, retainedLatest };
}

function longestSuffix(key: string, suffixes: readonly string[]): string | null {
  const lower = key.toLowerCase();
  let best: string | null = null;
  for (const suffix of suffixes) {
    if (lower.endsWith(suffix) && (best === null || suffix.length > best.length)) best = suffix;
  }
  return best;
}

function normalizeStem(stem: string): string {
  const stripped = stem
    .replace(DATE_TIME, "-")
    .replace(DATE_UNDERSCORE, "-")
    .replace(DATE_DASH, "-")
    .replace(COMPACT_DATE_TIME, "-")
    .replace(COMPACT_DATE, "-")
    .replace(EPOCH, "-")
    .replace(CLOCK, "-")
    .replace(HMS, "-")
    .replace(YEAR, "-");
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripDateSegments(segments: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (isFullDateSegment(segment)) continue;
    if (isYear(segment)) {
      if (isMonth(segments[index + 1] ?? "")) {
        index++;
        if (isDay(segments[index + 1] ?? "")) index++;
      }
      continue;
    }
    kept.push(segment);
  }
  return kept;
}

function isFullDateSegment(segment: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}(?:[tT]\d{2}[-:]?\d{2}[-:]?\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?$/i.test(
      segment,
    ) ||
    /^\d{4}_\d{2}_\d{2}(?:_\d{2}_\d{2}_\d{2})?$/.test(segment) ||
    /^\d{8}(?:[_-]?\d{6})?$/.test(segment)
  );
}

function isYear(segment: string): boolean {
  return /^(?:19|20)\d{2}$/.test(segment);
}

function isMonth(segment: string): boolean {
  if (!/^\d{1,2}$/.test(segment)) return false;
  const month = Number(segment);
  return month >= 1 && month <= 12;
}

function isDay(segment: string): boolean {
  if (!/^\d{1,2}$/.test(segment)) return false;
  const day = Number(segment);
  return day >= 1 && day <= 31;
}
