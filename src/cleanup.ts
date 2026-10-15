import { readConfig, type Env } from "./config.ts";
import { isBackupKey, planRetention, type BackupObject } from "./retention.ts";
import {
  PartialBucketListError,
  S3Account,
  type BucketInfo,
  type ListedObject,
  type ObjectStore,
} from "./s3.ts";

export interface CleanupSummary {
  bucketsScanned: number;
  backupsSeen: number;
  kept: number;
  expired: number;
  deleted: number;
  retainedLatest: number;
  dryRun: boolean;
  retentionDays: number;
}

export async function runCleanup(
  env: Env,
  options: { store?: ObjectStore; now?: Date } = {},
): Promise<CleanupSummary> {
  const config = readConfig(env);
  const now = options.now ?? new Date();
  const store = options.store ?? new S3Account();
  const failures: string[] = [];
  let listed: BucketInfo[] = [];
  let listedAny = false;

  try {
    listed = await store.listBuckets();
    listedAny = true;
  } catch (error) {
    if (error instanceof PartialBucketListError) {
      listed = error.buckets;
      listedAny = true;
      failures.push(error.message);
    } else {
      failures.push(`list buckets: ${errorMessage(error)}`);
    }
  }

  const names = new Set(listed.map((bucket) => bucket.name));
  if (config.buckets && listedAny) {
    for (const bucket of config.buckets) {
      if (!names.has(bucket)) failures.push(`bucket "${bucket}" was not found`);
    }
  }

  const selected = listed.filter((bucket) => {
    if (config.regions && !config.regions.includes(bucket.region)) {
      if (config.buckets?.includes(bucket.name)) {
        failures.push(`bucket "${bucket.name}" is in ${bucket.region}, outside REGIONS`);
      }
      return false;
    }
    return !config.buckets || config.buckets.includes(bucket.name);
  });
  log("buckets_listed", {
    buckets: selected.map((bucket) => ({ name: bucket.name, region: bucket.region })),
  });

  const backups: BackupObject[] = [];
  for (const bucket of selected) {
    try {
      const objects = await store.listObjects(bucket.region, bucket.name);
      backups.push(...backupObjects(bucket, objects, config.suffixes));
    } catch (error) {
      failures.push(`list objects (${bucket.region}/${bucket.name}): ${errorMessage(error)}`);
    }
  }

  const plan = planRetention(backups, now, config.retentionDays, config.suffixes);

  for (const object of plan.retainedLatest) {
    log("latest_backup_retained", {
      region: object.region,
      bucket: object.bucket,
      key: object.key,
      lastModified: object.lastModified.toISOString(),
      ageDays: ageDays(object.lastModified, now),
    });
  }

  for (const object of plan.remove) {
    log(config.dryRun ? "expired_backup_would_delete" : "expired_backup_delete", {
      region: object.region,
      bucket: object.bucket,
      key: object.key,
      lastModified: object.lastModified.toISOString(),
    });
  }

  let deleted = 0;
  if (!config.dryRun) {
    for (const group of groupByBucket(plan.remove)) {
      const result = await store.deleteObjects(group.region, group.bucket, group.keys);
      deleted += result.deleted;
      if (result.errors.length > 0) {
        log("delete_failed", { region: group.region, bucket: group.bucket, errors: result.errors });
        failures.push(`delete ${group.region}/${group.bucket}: ${result.errors.length} error(s)`);
      }
    }
  }

  const summary: CleanupSummary = {
    bucketsScanned: selected.length,
    backupsSeen: backups.length,
    kept: plan.keep.length,
    expired: plan.remove.length,
    deleted,
    retainedLatest: plan.retainedLatest.length,
    dryRun: config.dryRun,
    retentionDays: config.retentionDays,
  };
  log("cleanup_complete", { ...summary, failures });

  if (failures.length > 0) {
    throw new Error(
      `Backup cleanup finished with ${failures.length} failure(s): ${failures.join("; ")}`,
    );
  }
  return summary;
}

function backupObjects(
  bucket: BucketInfo,
  objects: readonly ListedObject[],
  suffixes: readonly string[],
): BackupObject[] {
  const backups: BackupObject[] = [];
  for (const object of objects) {
    if (!isBackupKey(object.key, suffixes)) continue;
    const lastModified = new Date(object.lastModified);
    if (Number.isNaN(lastModified.getTime())) {
      log("skip_unparsed_timestamp", {
        region: bucket.region,
        bucket: bucket.name,
        key: object.key,
        lastModified: object.lastModified,
      });
      continue;
    }
    backups.push({ region: bucket.region, bucket: bucket.name, key: object.key, lastModified });
  }
  return backups;
}

function groupByBucket(objects: readonly BackupObject[]): {
  region: string;
  bucket: string;
  keys: string[];
}[] {
  const groups = new Map<string, { region: string; bucket: string; keys: string[] }>();
  for (const object of objects) {
    const id = `${object.region}\0${object.bucket}`;
    const group = groups.get(id);
    if (group) group.keys.push(object.key);
    else groups.set(id, { region: object.region, bucket: object.bucket, keys: [object.key] });
  }
  for (const group of groups.values()) group.keys.sort();
  return [...groups.values()];
}

function ageDays(then: Date, now: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
