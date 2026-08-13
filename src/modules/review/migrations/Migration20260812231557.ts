import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260812231557 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "review" drop constraint if exists "review_product_id_customer_id_unique";`);
    this.addSql(`create table if not exists "review" ("id" text not null, "product_id" text not null, "customer_id" text null, "order_id" text null, "display_name" text not null, "email" text null, "rating" integer not null, "title" text null, "content" text not null, "status" text check ("status" in ('pending', 'approved', 'rejected')) not null default 'pending', "rejection_reason" text null, "is_verified_purchase" boolean not null default false, "helpful_count" integer not null default 0, "edited_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "review_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_deleted_at" ON "review" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_product_id" ON "review" ("product_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_review_status" ON "review" ("status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_review_product_id_customer_id_unique" ON "review" ("product_id", "customer_id") WHERE customer_id IS NOT NULL AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "review" cascade;`);
  }

}
