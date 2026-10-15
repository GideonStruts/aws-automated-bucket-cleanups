# Automated bucket cleanups

AWS Lambda function that runs every midnight UTC, finds database backup objects in S3, and deletes the ones that are past the retention window. The newest backup in each series is always kept, including when backups stop arriving and that newest file is already older than 7 days.

EventBridge invokes the function with `cron(0 0 * * ? *)`. EventBridge schedules use UTC, so this is 00:00 UTC (03:00 in UTC+3). For midnight in UTC+3, change the schedule in `template.yaml` to `cron(0 21 * * ? *)`.

The function uses its execution role. It does not store access keys.

## Retention

An object is a backup when its name ends with a configured suffix (`.sql`, `.sql.gz`, `.dump`, `.backup`, `.bak`, `.rdb`, and the compressed variants in `template.yaml`). Other objects are left alone. Age comes from the S3 `LastModified` timestamp, which is when the object was uploaded.

Backups that belong to the same database are one series. The series is the bucket, plus the folder path, plus the file name, after dates and times have been removed. These are one series:

- `postgres/app-2026-10-01.sql.gz`
- `postgres/app-2026-10-14T030000.sql.gz`
- `2026/10/01/app.sql.gz` and `2026/10/08/app.sql.gz`
- `dumps/2026-10-01/app.sql` and `dumps/2026-10-02/app.sql`

These stay separate, so a new backup of one database cannot make another database's only copy eligible for deletion:

- a different folder or database name (`mysql/app-….sql.gz`, `postgres/billing-….sql.gz`)
- a different bucket
- a non-date folder such as `pg/16/` versus `pg/17/`

For each series the function keeps:

- every backup newer than the retention window (7 days by default; a file uploaded exactly 7 days ago is kept)
- the newest backup, even when that file is older than 7 days

Everything else in the series that is older than 7 days is deleted. When two objects share the newest timestamp, both are kept. Deletion uses `DeleteObjects`, in batches of up to 1000 keys.

Example on 15 October 2026, with a 7-day window:

| Object | Last modified | Result |
| --- | --- | --- |
| `postgres/app-2026-09-01.sql.gz` | 1 September | Deleted. A newer `app` backup exists. |
| `postgres/app-2026-10-01.sql.gz` | 1 October | Kept. Newest `app` backup, even though it is past 7 days. |
| `postgres/billing-2026-08-01.sql.gz` | 1 August | Kept. It is the only `billing` backup. |
| `assets/logo.png` | any | Kept. Not a backup file. |

`LastModified` decides which copy is newest. The dates in the path are only used to tell series apart. A file named with an old date but uploaded today is a new object.

Year folders (`2026/10/01`) and `YYYY-MM-DD` folders are treated as dates. A folder that is only a year, such as `2026`, is also treated as a date. Version folders such as `pg/16` are not.

## Prerequisites

- Node.js 22 or newer
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), authenticated to the account that owns the buckets
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

```bash
aws sts get-caller-identity
```

## Deploy

For a first look at the delete plan, deploy with `DryRun=true`. The function logs what it would delete and does not call `DeleteObjects`.

```bash
npm install
npm test
npm run build
sam build
sam deploy --guided --parameter-overrides DryRun=true
```

`sam deploy --guided` asks for a stack name, region, and permission to create the IAM role. Use a stack name such as `automated-bucket-cleanups`. The template creates:

- a Node.js 24 Lambda function on arm64, with a 15 minute timeout
- an EventBridge schedule at 00:00 UTC
- an execution role that can list every bucket, read object lists, and delete objects

`npm run build` writes `dist/index.js`. Run it again before every `sam build`. The Lambda reads buckets through the AWS SDK, so buckets created later are included without a template change.

When the CloudWatch logs show the plan you expect, deploy the real cleanup:

```bash
sam deploy --parameter-overrides DryRun=false
```

Watch a run with:

```bash
aws logs tail /aws/lambda/automated-bucket-cleanups --follow
```

Each kept latest file is logged as `latest_backup_retained`. Each deletion is logged as `expired_backup_delete`. A failed list or delete fails the invocation after the function has finished the buckets it could. EventBridge retries a failed schedule. Deletes are idempotent, and the newest file in a series is never in the delete set.

Invoke it once without waiting for midnight:

```bash
aws lambda invoke \
  --function-name automated-bucket-cleanups \
  --payload '{"time":"2026-10-15T00:00:00Z"}' \
  --cli-binary-format raw-in-base64-out \
  /tmp/cleanup-result.json
cat /tmp/cleanup-result.json
```

`time` is the clock used for the 7-day comparison. Omit it to use the current time.

A local invoke uses your AWS credentials and the live account:

```bash
cp env.json.example env.json
npm run build
sam build
sam local invoke CleanupFunction --env-vars env.json --event event.json
```

`event.json` can be `{}` or `{"time":"2026-10-15T00:00:00Z"}`. `env.json` is gitignored. The example sets `DRY_RUN` to `true`.

## Configuration

Change these as `sam deploy --parameter-overrides` arguments, or edit the defaults in `template.yaml` and deploy again.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RETENTION_DAYS` | `7` | Delete backups strictly older than this many days. |
| `DRY_RUN` | `false` | `true` logs the delete plan and does not call delete. |
| `BUCKETS` | all buckets | Optional comma-separated allowlist. |
| `REGIONS` | all regions | Optional comma-separated region allowlist, such as `us-east-1,eu-west-1`. |
| `BACKUP_SUFFIXES` | see `template.yaml` | Comma-separated suffixes. Replaces the default list. |

The role can delete objects in every bucket in the account. Narrow `BUCKETS` when this account also stores objects that must never be part of a cleanup, and keep the first deploy on `DryRun=true`.

Live database files such as `.sqlite` and `.db` are not in the default suffix list. Add a suffix only when those names are real backup objects.

If a bucket has [versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html) enabled, this function deletes the current object key and leaves a delete marker. Noncurrent versions remain until a lifecycle rule removes them. Object Lock denies the delete, the error is logged, and the invocation fails.

## Develop

```bash
npm test
npm run check
npm run build
```
