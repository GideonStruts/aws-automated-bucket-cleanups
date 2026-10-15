import assert from "node:assert/strict";
import test from "node:test";

import { readConfig } from "../src/config.ts";

test("reads the retention defaults", () => {
  const config = readConfig({});
  assert.equal(config.retentionDays, 7);
  assert.equal(config.dryRun, false);
  assert.equal(config.buckets, null);
  assert.equal(config.regions, null);
  assert.ok(config.suffixes.includes(".sql.gz"));
});

test("parses overrides", () => {
  const config = readConfig({
    DRY_RUN: "true",
    RETENTION_DAYS: "14",
    BUCKETS: "db-backups, db-backups, archive",
    REGIONS: "us-east-1, EU-WEST-1",
    BACKUP_SUFFIXES: "sql, .DUMP.GZ",
  });
  assert.equal(config.dryRun, true);
  assert.equal(config.retentionDays, 14);
  assert.deepEqual(config.buckets, ["db-backups", "archive"]);
  assert.deepEqual(config.regions, ["us-east-1", "eu-west-1"]);
  assert.deepEqual(config.suffixes, [".sql", ".dump.gz"]);
});

test("rejects a retention window that is not a whole number of days", () => {
  assert.throws(() => readConfig({ RETENTION_DAYS: "7.5" }), /RETENTION_DAYS/);
});
