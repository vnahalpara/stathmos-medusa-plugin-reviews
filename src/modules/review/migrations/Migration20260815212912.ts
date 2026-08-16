import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260815212912 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "review_vote" alter column "voter_hash" type text using ("voter_hash"::text);`);
    this.addSql(`alter table if exists "review_vote" alter column "voter_hash" drop not null;`);
    // `plugin:db:generate` diffed the column but not this index's `where`
    // clause - it left the old, narrower predicate in the emitted SQL even
    // though it advanced the snapshot to the new one. Added by hand so the
    // live index actually matches what the model (and the snapshot) claim:
    // a customer row's null voter_hash must never fall under this guest
    // dedup constraint, only a genuinely-hashed guest row should.
    this.addSql(`drop index if exists "IDX_review_vote_review_id_voter_hash_unique";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_vote_review_id_voter_hash_unique" ON "review_vote" ("review_id", "voter_hash") WHERE voter_hash IS NOT NULL AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_review_vote_review_id_voter_hash_unique";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_vote_review_id_voter_hash_unique" ON "review_vote" ("review_id", "voter_hash") WHERE deleted_at IS NULL;`);
    this.addSql(`alter table if exists "review_vote" alter column "voter_hash" type text using ("voter_hash"::text);`);
    this.addSql(`alter table if exists "review_vote" alter column "voter_hash" set not null;`);
  }

}
