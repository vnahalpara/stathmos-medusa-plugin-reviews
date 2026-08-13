import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260813001646 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "review_stats" drop constraint if exists "review_stats_product_id_unique";`);
    this.addSql(`create table if not exists "review_stats" ("id" text not null, "product_id" text not null, "count" integer not null default 0, "average" real not null default 0, "breakdown_1" integer not null default 0, "breakdown_2" integer not null default 0, "breakdown_3" integer not null default 0, "breakdown_4" integer not null default 0, "breakdown_5" integer not null default 0, "media_count" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_stats_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_stats_deleted_at" ON "review_stats" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_stats_product_id_unique" ON "review_stats" ("product_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "review_stats" cascade;`);
  }

}
