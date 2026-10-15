import {
  DeleteObjectsCommand,
  GetBucketLocationCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  S3Client,
  type Bucket,
} from "@aws-sdk/client-s3";

const DELETE_BATCH_SIZE = 1000;
const MAX_PAGES = 100_000;

export interface ListedObject {
  key: string;
  lastModified: string;
}

export interface BucketInfo {
  name: string;
  region: string;
}

export interface ObjectStore {
  listBuckets(): Promise<BucketInfo[]>;
  listObjects(region: string, bucket: string): Promise<ListedObject[]>;
  deleteObjects(
    region: string,
    bucket: string,
    keys: readonly string[],
  ): Promise<{ deleted: number; errors: string[] }>;
}

/** Buckets whose region could not be resolved are omitted, and the error carries the rest. */
export class PartialBucketListError extends Error {
  readonly buckets: BucketInfo[];

  constructor(message: string, buckets: BucketInfo[]) {
    super(message);
    this.name = "PartialBucketListError";
    this.buckets = buckets;
  }
}

/** GetBucketLocation still returns these legacy codes instead of region names. */
export function normalizeBucketRegion(location: string | undefined | null): string {
  if (!location || location === "US") return "us-east-1";
  if (location === "EU") return "eu-west-1";
  return location;
}

export class S3Account implements ObjectStore {
  private readonly globalClient = new S3Client({ region: "us-east-1" });
  private readonly clients = new Map<string, S3Client>();

  async listBuckets(): Promise<BucketInfo[]> {
    const listed = await this.fetchBucketPage();
    const buckets: BucketInfo[] = [];
    const errors: string[] = [];

    for (const bucket of listed) {
      if (!bucket.name) continue;
      try {
        const region = bucket.region ?? (await this.lookupRegion(bucket.name));
        buckets.push({ name: bucket.name, region: normalizeBucketRegion(region) });
      } catch (error) {
        errors.push(`${bucket.name}: ${errorMessage(error)}`);
      }
    }

    if (errors.length > 0) {
      throw new PartialBucketListError(
        `Bucket location lookup failed for ${errors.length} bucket(s): ${errors.join("; ")}`,
        buckets,
      );
    }
    return buckets;
  }

  async listObjects(region: string, bucket: string): Promise<ListedObject[]> {
    const client = this.clientFor(region);
    const objects: ListedObject[] = [];
    let token: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const item of response.Contents ?? []) {
        if (!item.Key || !item.LastModified) continue;
        objects.push({ key: item.Key, lastModified: item.LastModified.toISOString() });
      }
      if (!response.IsTruncated || !response.NextContinuationToken) return objects;
      if (response.NextContinuationToken === token) {
        throw new Error(`List objects (${region}/${bucket}) repeated a continuation token.`);
      }
      token = response.NextContinuationToken;
    }

    throw new Error(`Stopped listing ${region}/${bucket} after ${MAX_PAGES} pages.`);
  }

  async deleteObjects(
    region: string,
    bucket: string,
    keys: readonly string[],
  ): Promise<{ deleted: number; errors: string[] }> {
    const client = this.clientFor(region);
    let deleted = 0;
    const errors: string[] = [];

    for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
      const batch = keys.slice(offset, offset + DELETE_BATCH_SIZE);
      try {
        const response = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
              Objects: batch.map((key) => ({ Key: key })),
              Quiet: false,
            },
          }),
        );
        const batchErrors = (response.Errors ?? []).map(
          (error) => `${error.Key ?? ""} (${error.Code ?? "Error"}: ${error.Message ?? ""})`,
        );
        if (batchErrors.length === 0) deleted += batch.length;
        else {
          deleted += response.Deleted?.length ?? 0;
          errors.push(...batchErrors);
        }
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }

    return { deleted, errors };
  }

  private clientFor(region: string): S3Client {
    const existing = this.clients.get(region);
    if (existing) return existing;
    const client = new S3Client({ region });
    this.clients.set(region, client);
    return client;
  }

  private async fetchBucketPage(): Promise<{ name: string; region?: string }[]> {
    const buckets: { name: string; region?: string }[] = [];
    let token: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.globalClient.send(
        new ListBucketsCommand({ ContinuationToken: token, MaxBuckets: 1000 }),
      );
      for (const bucket of response.Buckets ?? []) {
        const described = bucketRegion(bucket);
        if (!described.name) continue;
        buckets.push({ name: described.name, region: described.region });
      }
      if (!response.ContinuationToken || response.ContinuationToken === token) return buckets;
      token = response.ContinuationToken;
    }

    throw new Error(`Stopped listing buckets after ${MAX_PAGES} pages.`);
  }

  private async lookupRegion(bucket: string): Promise<string> {
    const response = await this.globalClient.send(new GetBucketLocationCommand({ Bucket: bucket }));
    return normalizeBucketRegion(response.LocationConstraint);
  }
}

function bucketRegion(bucket: Bucket): { name?: string; region?: string } {
  const region = "BucketRegion" in bucket ? bucket.BucketRegion : undefined;
  return {
    name: bucket.Name,
    region: typeof region === "string" && region.length > 0 ? region : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
