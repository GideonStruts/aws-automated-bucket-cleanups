import assert from "node:assert/strict";
import test from "node:test";

import { runCleanup } from "../src/cleanup.ts";
import type { Env } from "../src/config.ts";
import type { BucketInfo, ListedObject, ObjectStore } from "../src/s3.ts";
import { normalizeBucketRegion } from "../src/s3.ts";

const ENV: Env = {
  RETENTION_DAYS: "7",
  DRY_RUN: "false",
};

const NOW = new Date("2026-10-15T00:00:00.000Z");

const OBJECTS: ListedObject[] = [
  { key: "postgres/app-2026-09-01.sql.gz", lastModified: "2026-09-01T00:00:00.000Z" },
  { key: "postgres/app-2026-10-01.sql.gz", lastModified: "2026-10-01T00:00:00.000Z" },
  { key: "postgres/billing-2026-08-01.sql.gz", lastModified: "2026-08-01T00:00:00.000Z" },
  { key: "assets/logo.png", lastModified: "2020-01-01T00:00:00.000Z" },
];

function store(deleted: string[], buckets: BucketInfo[] = [{ name: "db-backups", region: "us-east-1" }]): ObjectStore {
  return {
    async listBuckets() {
      return buckets;
    },
    async listObjects() {
      return OBJECTS;
    },
    async deleteObjects(_region, _bucket, keys) {
      deleted.push(...keys);
      return { deleted: keys.length, errors: [] };
    },
  };
}

test("maps legacy S3 location codes to region names", () => {
  assert.equal(normalizeBucketRegion(undefined), "us-east-1");
  assert.equal(normalizeBucketRegion(""), "us-east-1");
  assert.equal(normalizeBucketRegion("US"), "us-east-1");
  assert.equal(normalizeBucketRegion("EU"), "eu-west-1");
  assert.equal(normalizeBucketRegion("ap-southeast-1"), "ap-southeast-1");
});

test("batch delete skips the newest backup even when it is older than 7 days", async () => {
  const deleted: string[] = [];
  const summary = await runCleanup(ENV, { store: store(deleted), now: NOW });

  assert.deepEqual(deleted, ["postgres/app-2026-09-01.sql.gz"]);
  assert.equal(summary.backupsSeen, 3);
  assert.equal(summary.expired, 1);
  assert.equal(summary.deleted, 1);
  assert.equal(summary.retainedLatest, 2);
  assert.equal(summary.dryRun, false);
});

test("dry run does not call delete", async () => {
  let deleted = false;
  const summary = await runCleanup(
    { ...ENV, DRY_RUN: "true" },
    {
      now: NOW,
      store: {
        async listBuckets() {
          return [{ name: "db-backups", region: "us-east-1" }];
        },
        async listObjects() {
          return OBJECTS;
        },
        async deleteObjects() {
          deleted = true;
          return { deleted: 0, errors: [] };
        },
      },
    },
  );

  assert.equal(deleted, false);
  assert.equal(summary.expired, 1);
  assert.equal(summary.deleted, 0);
  assert.equal(summary.dryRun, true);
});

test("a region filter leaves buckets in other regions alone", async () => {
  const scanned: string[] = [];
  await runCleanup(
    { ...ENV, REGIONS: "us-east-1" },
    {
      now: NOW,
      store: {
        async listBuckets() {
          return [
            { name: "east-backups", region: "us-east-1" },
            { name: "west-backups", region: "us-west-2" },
          ];
        },
        async listObjects(_region, bucket) {
          scanned.push(bucket);
          return [{ key: "db/only-2026-01-01.sql.gz", lastModified: "2026-01-01T00:00:00.000Z" }];
        },
        async deleteObjects() {
          throw new Error("the only backup in each series must be kept");
        },
      },
    },
  );

  assert.deepEqual(scanned, ["east-backups"]);
});

test("a delete error fails the run", async () => {
  await assert.rejects(
    () =>
      runCleanup(ENV, {
        now: NOW,
        store: {
          async listBuckets() {
            return [{ name: "db-backups", region: "us-east-1" }];
          },
          async listObjects() {
            return OBJECTS;
          },
          async deleteObjects() {
            return { deleted: 0, errors: ["postgres/app-2026-09-01.sql.gz (InternalError: retry)"] };
          },
        },
      }),
    /failure/,
  );
});
