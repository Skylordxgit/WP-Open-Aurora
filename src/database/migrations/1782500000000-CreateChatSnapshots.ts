import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateChatSnapshots1782500000000 implements MigrationInterface {
  name = 'CreateChatSnapshots1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('chat_snapshots')) return;

    const isPostgres = queryRunner.connection.options.type === 'postgres';
    const idDefinition = isPostgres
      ? `varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `varchar PRIMARY KEY NOT NULL`;
    const timestampDefinition = isPostgres ? 'bigint' : 'bigint';
    const createdAtDefinition = isPostgres
      ? 'timestamp NOT NULL DEFAULT NOW()'
      : `datetime NOT NULL DEFAULT (datetime('now'))`;

    await queryRunner.query(
      `CREATE TABLE "chat_snapshots" (` +
        `"id" ${idDefinition}, ` +
        `"sessionId" varchar(64) NOT NULL, ` +
        `"chatId" varchar(180) NOT NULL, ` +
        `"name" varchar(180) NOT NULL, ` +
        `"isGroup" boolean NOT NULL DEFAULT false, ` +
        `"unreadCount" integer NOT NULL DEFAULT 0, ` +
        `"timestamp" ${timestampDefinition}, ` +
        `"lastMessage" text, ` +
        `"contactPhone" varchar(50), ` +
        `"createdAt" ${createdAtDefinition}, ` +
        `"updatedAt" ${createdAtDefinition})`,
    );

    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_chat_snapshots_session_chat" ON "chat_snapshots" ("sessionId", "chatId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_snapshots_session_timestamp" ON "chat_snapshots" ("sessionId", "timestamp")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_chat_snapshots_session_timestamp"`);
    await queryRunner.query(`DROP INDEX "IDX_chat_snapshots_session_chat"`);
    await queryRunner.query(`DROP TABLE "chat_snapshots"`);
  }
}
