import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260812220807 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "smoke" ("id" text not null, "note" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "smoke_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_smoke_deleted_at" ON "smoke" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "smoke" cascade;`);
  }

}
