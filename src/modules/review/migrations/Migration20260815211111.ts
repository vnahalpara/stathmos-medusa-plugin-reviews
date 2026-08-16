import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260815211111 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "review_vote" drop constraint if exists "review_vote_review_id_voter_hash_unique";`);
    this.addSql(`alter table if exists "review_vote" drop constraint if exists "review_vote_review_id_customer_id_unique";`);
    this.addSql(`create table if not exists "review_vote" ("id" text not null, "review_id" text not null, "customer_id" text null, "voter_hash" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_vote_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_vote_deleted_at" ON "review_vote" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_vote_review_id" ON "review_vote" ("review_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_vote_review_id_customer_id_unique" ON "review_vote" ("review_id", "customer_id") WHERE customer_id IS NOT NULL AND deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_vote_review_id_voter_hash_unique" ON "review_vote" ("review_id", "voter_hash") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "review_vote" cascade;`);
  }

}
