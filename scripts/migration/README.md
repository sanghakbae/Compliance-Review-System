# Migration ETL: Supabase → Firebase + Cloudflare R2

One-shot scripts to move data off Supabase (Phase 4 of [docs/MIGRATION.md](../../docs/MIGRATION.md)).
Run these **after** Firestore is provisioned (Phase 1 rules/indexes deployed) and
the R2 bucket exists (`policy-revision-mgmt-system`), and **before** the client
cutover (Phase 5).

## Setup

```bash
cd scripts/migration
npm install
```

Set env vars (e.g. in a local `.env` you `export`, or inline):

| Var | Description |
|-----|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | service role key (read access to all tables/storage) |
| `FIREBASE_SERVICE_ACCOUNT` | path to service account JSON **or** inline JSON |
| `R2_ACCOUNT_ID` | Cloudflare account id (`02f0426678a5977483be4b2210cdf293`) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token (S3 credentials) |
| `R2_BUCKET` | `policy-revision-mgmt-system` |
| `DRY_RUN` | `1` to read + transform without writing (recommended first) |

Create the R2 S3 credentials in the Cloudflare dashboard: **R2 → Manage R2 API Tokens**.

## Run order

```bash
# 1. Dry run first — verify reads + transforms, no writes.
DRY_RUN=1 npm run migrate:data
DRY_RUN=1 npm run migrate:storage

# 2. Real migration.
npm run migrate:data      # Postgres → Firestore
npm run migrate:storage   # Storage  → R2

# 3. Verify row/document counts.
npm run verify
```

Both write scripts are **idempotent** (reuse Postgres UUIDs as Firestore ids /
R2 keys), so they can be re-run safely.

## What it does

- `migrateData.ts` — rebuilds the Firestore model from `src/lib/firestore/schema.ts`:
  FKs → subcollections, latest-version view → denormalized `documents.latest`,
  and denormalizes `ownerUserId` onto versions/sections plus a self `id` on
  versions (so the Workers' collection-group queries work).
- `migrateStorage.ts` — copies the `source-documents` bucket to R2, preserving
  keys so `sourceStoragePath` values stay valid.
- `verify.ts` — compares Postgres counts to Firestore counts per collection.

## Notes / known gaps

- Firebase **Auth users** are not migrated here. Users sign in with the same
  Google accounts; Firebase `uid` ≠ Supabase `user.id`. If you need the existing
  `owner_user_id` values to keep matching, import users with preserved UIDs via
  the Firebase Auth import API, or run a uid-remap pass before this script.
- Legacy `.doc` raw text is carried over as-is (already stored as `rawText`).
