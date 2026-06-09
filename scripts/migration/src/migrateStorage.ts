/**
 * Supabase Storage → Cloudflare R2.
 *
 * Copies every object in the `source-documents` bucket to R2, preserving the
 * key (the document's sourceStoragePath = `${uid}/${uuid}-${name}.ext`), so the
 * paths already stored on Firestore documents keep resolving. Idempotent.
 * DRY_RUN=1 lists what would copy without transferring.
 */

import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  DRY_RUN,
  R2_BUCKET,
  SUPABASE_STORAGE_BUCKET,
  log,
  r2,
  supabase,
} from "./config.js";

interface StorageEntry {
  path: string;
  contentType: string;
}

async function listAllObjects(): Promise<StorageEntry[]> {
  const sb = supabase();
  const entries: StorageEntry[] = [];

  // Supabase storage list is per-prefix and non-recursive; walk folders (uid/...).
  async function walk(prefix: string): Promise<void> {
    const { data, error } = await sb.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .list(prefix, { limit: 1000 });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    for (const item of data ?? []) {
      const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
      // Folders have no id/metadata; files carry metadata.mimetype.
      if (item.id === null || item.metadata == null) {
        await walk(fullPath);
      } else {
        entries.push({
          path: fullPath,
          contentType: (item.metadata?.mimetype as string) ?? "application/octet-stream",
        });
      }
    }
  }

  await walk("");
  return entries;
}

async function main(): Promise<void> {
  const sb = supabase();
  const client = r2();
  const objects = await listAllObjects();
  log(`found ${objects.length} storage objects`);

  let copied = 0;
  for (const obj of objects) {
    if (DRY_RUN) {
      log(`would copy ${obj.path}`);
      copied += 1;
      continue;
    }
    const { data, error } = await sb.storage.from(SUPABASE_STORAGE_BUCKET).download(obj.path);
    if (error || !data) {
      log(`WARN download failed ${obj.path}: ${error?.message}`);
      continue;
    }
    const body = new Uint8Array(await data.arrayBuffer());
    await client.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: obj.path,
        Body: body,
        ContentType: obj.contentType,
      }),
    );
    copied += 1;
    if (copied % 25 === 0) log(`copied ${copied}/${objects.length}`);
  }

  log(`done. ${copied} objects ${DRY_RUN ? "would be copied" : "copied"} to R2 (${R2_BUCKET}).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
