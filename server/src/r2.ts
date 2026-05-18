import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";

const REQUIRED = ["R2_BUCKET", "R2_ENDPOINT_URL", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

export function r2Configured(): boolean {
  return REQUIRED.every((k) => !!process.env[k]);
}

function client() {
  return new S3Client({
    endpoint: process.env.R2_ENDPOINT_URL!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    region: "auto",
    forcePathStyle: true,
  });
}

const BUCKET = () => process.env.R2_BUCKET!;
const STAGING_PREFIX = "staging/";

/** Upload a file buffer to R2 staging. Returns the R2 key. */
export async function stageFile(filename: string, data: Buffer): Promise<string> {
  const key = `${STAGING_PREFIX}${filename}`;
  await client().send(new PutObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    Body: data,
    ContentType: "application/octet-stream",
  }));
  return key;
}

/** List all filenames currently in staging. */
export async function listStaging(): Promise<string[]> {
  const res = await client().send(new ListObjectsV2Command({
    Bucket: BUCKET(),
    Prefix: STAGING_PREFIX,
  }));
  return (res.Contents ?? []).map((o) => o.Key!.slice(STAGING_PREFIX.length)).filter(Boolean);
}

/** Delete all staging objects (called after the GitHub Action processes them). */
export async function clearStaging(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await client().send(new DeleteObjectsCommand({
    Bucket: BUCKET(),
    Delete: { Objects: keys.map((k) => ({ Key: `${STAGING_PREFIX}${k}` })) },
  }));
}
