import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260815234119 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "review_settings" alter column "allow_edit" type boolean using ("allow_edit"::boolean);`);
    this.addSql(`alter table if exists "review_settings" alter column "allow_edit" set default true;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "review_settings" alter column "allow_edit" type boolean using ("allow_edit"::boolean);`);
    this.addSql(`alter table if exists "review_settings" alter column "allow_edit" set default false;`);
  }

}
