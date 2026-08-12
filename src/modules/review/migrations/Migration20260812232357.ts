import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260812232357 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "review_settings" ("id" text not null, "enabled" boolean not null default true, "require_approval" boolean not null default true, "allow_guest" boolean not null default false, "verified_only" boolean not null default false, "allow_media" boolean not null default true, "allow_video" boolean not null default true, "max_media_per_review" integer not null default 5, "max_image_size_mb" integer not null default 5, "max_video_size_mb" integer not null default 50, "allow_edit" boolean not null default false, "one_review_per_customer" boolean not null default true, "min_content_length" integer not null default 10, "max_content_length" integer not null default 5000, "gallery_enabled" boolean not null default true, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_settings_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_settings_deleted_at" ON "review_settings" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "review_settings" cascade;`);
  }

}
