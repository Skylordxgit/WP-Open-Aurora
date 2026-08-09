import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnhanceOmegaSessionsForOpenwaSync1782100000000 implements MigrationInterface {
  name = 'EnhanceOmegaSessionsForOpenwaSync1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rawColumns: unknown = await queryRunner.query(`PRAGMA table_info("omega_whatsapp_sessions")`);
    const columns = Array.isArray(rawColumns) ? (rawColumns as Array<{ name?: unknown }>) : [];
    const hasColumn = (name: string) => columns.some(column => typeof column.name === 'string' && column.name === name);

    if (!hasColumn('openwaSessionName')) {
      await queryRunner.query(`ALTER TABLE "omega_whatsapp_sessions" ADD COLUMN "openwaSessionName" varchar(160)`);
    }
    if (!hasColumn('replacementRequested')) {
      await queryRunner.query(
        `ALTER TABLE "omega_whatsapp_sessions" ADD COLUMN "replacementRequested" boolean NOT NULL DEFAULT (0)`,
      );
    }
    if (!hasColumn('lastSyncAt')) {
      await queryRunner.query(`ALTER TABLE "omega_whatsapp_sessions" ADD COLUMN "lastSyncAt" datetime`);
    }
  }

  public down(queryRunner: QueryRunner): Promise<void> {
    // SQLite does not support DROP COLUMN in-place across all bundled versions; keep this migration additive-only.
    void queryRunner;
    return Promise.resolve();
  }
}
