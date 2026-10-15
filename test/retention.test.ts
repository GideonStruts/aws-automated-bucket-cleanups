import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BACKUP_SUFFIXES } from "../src/config.ts";
import {
  backupSeriesId,
  isBackupKey,
  planRetention,
  type BackupObject,
} from "../src/retention.ts";

const SUFFIXES = [...DEFAULT_BACKUP_SUFFIXES];
const NOW = new Date("2026-10-15T00:00:00.000Z");

function backup(key: string, lastModified: string, bucket = "db-backups", region = "us-east-1"): BackupObject {
  return { region, bucket, key, lastModified: new Date(lastModified) };
}

function series(key: string, bucket = "db-backups", region = "us-east-1"): string {
  return backupSeriesId({ region, bucket, key }, SUFFIXES);
}

test("backup suffixes match dump files and ignore everything else", () => {
  assert.equal(isBackupKey("postgres/App-2026-10-01.SQL.GZ", SUFFIXES), true);
  assert.equal(isBackupKey("redis/dump.rdb", SUFFIXES), true);
  assert.equal(isBackupKey("live/app.sqlite", SUFFIXES), false);
  assert.equal(isBackupKey("assets/logo.png", SUFFIXES), false);
  assert.equal(isBackupKey("notes/file.sql.txt", SUFFIXES), false);
});

test("dated copies of one database share a series", () => {
  assert.equal(series("postgres/app-2026-10-01.sql.gz"), series("postgres/app-2026-10-14T03:00:00Z.sql.gz"));
  assert.equal(series("postgres/app_2026_10_01_03_00_00.dump"), series("postgres/app-20261001-030000.dump.gz"));
  assert.equal(series("2026/10/01/backup.sql.gz"), series("2026/10/09/backup.sql.gz"));
  assert.equal(series("dumps/2026-10-01/app.sql"), series("dumps/2026-10-02/app.sql"));
  assert.equal(series("nightly/2026-10-01.sql"), series("nightly/2026-10-08.sql"));
  assert.equal(series("postgres/my db-2026-10-01.sql.gz"), series("postgres/my-db-20261008.sql.gz"));
});

test("different databases, folders, buckets, and regions stay apart", () => {
  assert.notEqual(series("postgres/app-2026-10-01.sql.gz"), series("mysql/app-2026-10-01.sql.gz"));
  assert.notEqual(series("postgres/app-2026-10-01.sql.gz"), series("postgres/billing-2026-10-01.sql.gz"));
  assert.notEqual(series("pg/16/base-2026-10-01.sql"), series("pg/17/base-2026-10-01.sql"));
  assert.notEqual(series("app-2026-10-01.sql.gz", "bucket-a"), series("app-2026-10-01.sql.gz", "bucket-b"));
  assert.notEqual(
    series("app-2026-10-01.sql.gz", "db-backups", "us-east-1"),
    series("app-2026-10-01.sql.gz", "db-backups", "eu-west-1"),
  );
});

test("a file with no timestamp is not folded into the dated series", () => {
  assert.notEqual(series("nightly/2026-10-01.sql"), series("nightly/backup.sql"));
});

test("deletes expired copies and always keeps the newest backup in the series", () => {
  const plan = planRetention(
    [
      backup("postgres/app-2026-09-01.sql.gz", "2026-09-01T00:00:00.000Z"),
      backup("postgres/app-2026-10-01.sql.gz", "2026-10-01T00:00:00.000Z"),
      backup("postgres/billing-2026-08-01.sql.gz", "2026-08-01T00:00:00.000Z"),
    ],
    NOW,
    7,
    SUFFIXES,
  );

  assert.deepEqual(plan.remove.map((object) => object.key), ["postgres/app-2026-09-01.sql.gz"]);
  assert.deepEqual(plan.retainedLatest.map((object) => object.key), [
    "postgres/app-2026-10-01.sql.gz",
    "postgres/billing-2026-08-01.sql.gz",
  ]);
});

test("keeps the only backup after the retention window when uploads have stopped", () => {
  const plan = planRetention(
    [backup("postgres/app-2026-09-01.sql.gz", "2026-09-01T00:00:00.000Z")],
    NOW,
    7,
    SUFFIXES,
  );

  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.retainedLatest.map((object) => object.key), ["postgres/app-2026-09-01.sql.gz"]);
});

test("keeps every object tied for newest", () => {
  const plan = planRetention(
    [
      backup("postgres/app-2026-09-01.sql.gz", "2026-09-01T00:00:00.000Z"),
      backup("postgres/app-2026-09-02.sql.gz", "2026-09-01T00:00:00.000Z"),
    ],
    NOW,
    7,
    SUFFIXES,
  );

  assert.deepEqual(plan.remove, []);
  assert.equal(plan.retainedLatest.length, 2);
});

test("a backup uploaded exactly 7 days ago is kept", () => {
  const plan = planRetention(
    [
      backup("postgres/app-2026-10-01.sql.gz", "2026-10-01T00:00:00.000Z"),
      backup("postgres/app-2026-10-08.sql.gz", "2026-10-08T00:00:00.000Z"),
    ],
    NOW,
    7,
    SUFFIXES,
  );

  assert.deepEqual(plan.remove.map((object) => object.key), ["postgres/app-2026-10-01.sql.gz"]);
  assert.deepEqual(plan.retainedLatest, []);
});
