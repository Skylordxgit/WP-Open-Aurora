import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSavedContacts1782300000000 implements MigrationInterface {
  name = 'CreateSavedContacts1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const exists = await queryRunner.hasTable('saved_contacts');
    if (exists) return;

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "saved_contacts" (` +
          `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar, ` +
          `"sessionId" varchar NOT NULL, ` +
          `"name" varchar(120), ` +
          `"number" varchar(50) NOT NULL, ` +
          `"source" varchar(20) NOT NULL DEFAULT 'imported', ` +
          `"createdAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `"updatedAt" timestamp NOT NULL DEFAULT NOW(), ` +
          `CONSTRAINT "FK_saved_contacts_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)` ,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "saved_contacts" (` +
          `"id" varchar PRIMARY KEY NOT NULL, ` +
          `"sessionId" varchar NOT NULL, ` +
          `"name" varchar(120), ` +
          `"number" varchar(50) NOT NULL, ` +
          `"source" varchar(20) NOT NULL DEFAULT 'imported', ` +
          `"createdAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `"updatedAt" datetime NOT NULL DEFAULT (datetime('now')), ` +
          `CONSTRAINT "FK_saved_contacts_sessionId" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)` ,
      );
    }

    await queryRunner.query(`CREATE INDEX "IDX_saved_contacts_sessionId" ON "saved_contacts" ("sessionId")`);
    await queryRunner.query(`CREATE INDEX "IDX_saved_contacts_sessionId_number" ON "saved_contacts" ("sessionId", "number")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_saved_contacts_sessionId_number"`);
    await queryRunner.query(`DROP INDEX "IDX_saved_contacts_sessionId"`);
    await queryRunner.query(`DROP TABLE "saved_contacts"`);
  }
}
