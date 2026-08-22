import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Keep media bytes outside the hot messages table and make WhatsApp event replay idempotent.
 * The pre-index cleanup handles databases that already received the same live/history event twice.
 */
export class StrengthenMessageArchive1782600000000 implements MigrationInterface {
  name = 'StrengthenMessageArchive1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('messages', 'mediaPath'))) {
      await queryRunner.addColumn(
        'messages',
        new TableColumn({ name: 'mediaPath', type: 'varchar', isNullable: true }),
      );
    }
    if (!(await queryRunner.hasColumn('messages', 'mediaMimetype'))) {
      await queryRunner.addColumn(
        'messages',
        new TableColumn({ name: 'mediaMimetype', type: 'varchar', isNullable: true }),
      );
    }

    // Prefer the richest/highest-status copy before removing duplicate event replays. Window
    // functions and the expressions below are supported by both PostgreSQL and modern SQLite.
    await queryRunner.query(
      `DELETE FROM "messages" WHERE "id" IN (` +
        `SELECT "id" FROM (` +
        `SELECT "id", ROW_NUMBER() OVER (` +
        `PARTITION BY "sessionId", "waMessageId" ORDER BY ` +
        `CASE "status" WHEN 'read' THEN 5 WHEN 'delivered' THEN 4 WHEN 'sent' THEN 3 ` +
        `WHEN 'pending' THEN 2 ELSE 1 END DESC, ` +
        `CASE WHEN "metadata" IS NULL THEN 0 ELSE 1 END DESC, ` +
        `LENGTH(COALESCE("body", '')) DESC, "createdAt" DESC, "id" DESC` +
        `) AS "duplicateRank" FROM "messages" WHERE "waMessageId" IS NOT NULL` +
        `) AS "rankedMessages" WHERE "duplicateRank" > 1)`,
    );

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_sessionId_waMessageId"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_messages_session_wa_id" ` +
        `ON "messages" ("sessionId", "waMessageId") WHERE "waMessageId" IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_mediaPath" ON "messages" ("mediaPath")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_mediaPath"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_messages_session_wa_id"`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_sessionId_waMessageId" ON "messages" ("sessionId", "waMessageId")`,
    );
    if (await queryRunner.hasColumn('messages', 'mediaMimetype')) {
      await queryRunner.dropColumn('messages', 'mediaMimetype');
    }
    if (await queryRunner.hasColumn('messages', 'mediaPath')) {
      await queryRunner.dropColumn('messages', 'mediaPath');
    }
  }
}
