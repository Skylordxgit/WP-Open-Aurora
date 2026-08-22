import { QueryRunner } from 'typeorm';
import { AddMessageRetryQueue1782700000000 } from '../1782700000000-AddMessageRetryQueue';

describe('AddMessageRetryQueue1782700000000', () => {
  it('adds retry state columns and a due-time index', async () => {
    const sql: string[] = [];
    const addColumn = jest.fn().mockResolvedValue(undefined);
    const runner = {
      connection: { options: { type: 'postgres' } },
      hasColumn: jest.fn().mockResolvedValue(false),
      addColumn,
      query: jest.fn().mockImplementation((statement: string) => {
        sql.push(statement);
        return Promise.resolve();
      }),
    } as unknown as QueryRunner;

    await new AddMessageRetryQueue1782700000000().up(runner);

    expect(addColumn).toHaveBeenCalledTimes(3);
    expect(sql.join('\n')).toContain('IDX_messages_nextRetryAt');
  });
});
