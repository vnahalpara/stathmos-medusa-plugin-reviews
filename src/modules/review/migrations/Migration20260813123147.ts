import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260813123147 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "review_media" ("id" text not null, "review_id" text null, "type" text check ("type" in ('image', 'video')) not null, "file_id" text not null, "url" text not null, "thumbnail_url" text null, "mime_type" text not null, "size_bytes" integer not null, "sort_order" integer not null default 0, "pinned_at" timestamptz null, "hidden_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_media_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_media_deleted_at" ON "review_media" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_media_review_id" ON "review_media" ("review_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_media_file_id" ON "review_media" ("file_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "review_media" cascade;`);
  }

}
