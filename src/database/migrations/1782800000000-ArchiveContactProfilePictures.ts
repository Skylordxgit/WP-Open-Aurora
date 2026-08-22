import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class ArchiveContactProfilePictures1782800000000 implements MigrationInterface {
  name = 'ArchiveContactProfilePictures1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('chat_snapshots', 'profilePicPath'))) {
      await queryRunner.addColumn(
        'chat_snapshots',
        new TableColumn({ name: 'profilePicPath', type: 'varchar', isNullable: true }),
      );
    }
    if (!(await queryRunner.hasColumn('chat_snapshots', 'profilePicMimetype'))) {
      await queryRunner.addColumn(
        'chat_snapshots',
        new TableColumn({ name: 'profilePicMimetype', type: 'varchar', length: '120', isNullable: true }),
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn('chat_snapshots', 'profilePicMimetype')) {
      await queryRunner.dropColumn('chat_snapshots', 'profilePicMimetype');
    }
    if (await queryRunner.hasColumn('chat_snapshots', 'profilePicPath')) {
      await queryRunner.dropColumn('chat_snapshots', 'profilePicPath');
    }
  }
}
