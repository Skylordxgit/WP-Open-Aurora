import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddMessageRetryQueue1782700000000 implements MigrationInterface {
  name = 'AddMessageRetryQueue1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!(await queryRunner.hasColumn('messages', 'retryCount'))) {
      await queryRunner.addColumn('messages', new TableColumn({ name: 'retryCount', type: 'integer', default: 0 }));
    }
    if (!(await queryRunner.hasColumn('messages', 'nextRetryAt'))) {
      await queryRunner.addColumn(
        'messages',
        new TableColumn({ name: 'nextRetryAt', type: isPostgres ? 'timestamp' : 'text', isNullable: true }),
      );
    }
    if (!(await queryRunner.hasColumn('messages', 'lastError'))) {
      await queryRunner.addColumn('messages', new TableColumn({ name: 'lastError', type: 'text', isNullable: true }));
    }
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_nextRetryAt" ON "messages" ("nextRetryAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_nextRetryAt"`);
    for (const column of ['lastError', 'nextRetryAt', 'retryCount']) {
      if (await queryRunner.hasColumn('messages', column)) await queryRunner.dropColumn('messages', column);
    }
  }
}
