import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260814122605 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "review_reply" drop constraint if exists "review_reply_review_id_unique";`);
    this.addSql(`create table if not exists "review_reply" ("id" text not null, "review_id" text not null, "content" text not null, "replied_by" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_reply_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_reply_deleted_at" ON "review_reply" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_reply_review_id_unique" ON "review_reply" ("review_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "review_reply" cascade;`);
  }

}
