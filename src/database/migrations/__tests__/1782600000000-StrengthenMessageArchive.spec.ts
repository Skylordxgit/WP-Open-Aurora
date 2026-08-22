import { QueryRunner } from 'typeorm';
import { StrengthenMessageArchive1782600000000 } from '../1782600000000-StrengthenMessageArchive';

describe('StrengthenMessageArchive1782600000000', () => {
  it('adds durable media columns, de-duplicates rows, and creates the partial unique index', async () => {
    const addColumn = jest.fn<(table: string, column: unknown) => Promise<void>>().mockResolvedValue(undefined);
    const sqlStatements: string[] = [];
    const query = jest.fn<(sql: string) => Promise<void>>((sql: string) => {
      sqlStatements.push(sql);
      return Promise.resolve();
    });
    const runner = {
      hasColumn: jest.fn().mockResolvedValue(false),
      addColumn,
      query,
    } as unknown as QueryRunner;

    await new StrengthenMessageArchive1782600000000().up(runner);

    expect(addColumn).toHaveBeenCalledTimes(2);
    const sql = sqlStatements.join('\n');
    expect(sql).toContain('ROW_NUMBER() OVER');
    expect(sql).toContain('UQ_messages_session_wa_id');
    expect(sql).toContain('WHERE "waMessageId" IS NOT NULL');
  });

  it('does not re-add columns that already exist', async () => {
    const addColumn = jest.fn<(table: string, column: unknown) => Promise<void>>();
    const runner = {
      hasColumn: jest.fn().mockResolvedValue(true),
      addColumn,
      query: jest.fn().mockResolvedValue(undefined),
    } as unknown as QueryRunner;

    await new StrengthenMessageArchive1782600000000().up(runner);
    expect(addColumn).not.toHaveBeenCalled();
  });
});
