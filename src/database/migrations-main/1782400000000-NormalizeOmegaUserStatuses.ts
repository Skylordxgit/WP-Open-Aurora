import { MigrationInterface, QueryRunner } from 'typeorm';

export class NormalizeOmegaUserStatuses1782400000000 implements MigrationInterface {
  name = 'NormalizeOmegaUserStatuses1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "omega_users" SET "status" = 'inactive' WHERE "status" IN ('invited', 'suspended')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "omega_users" SET "status" = 'suspended' WHERE "status" = 'inactive'`);
  }
}
