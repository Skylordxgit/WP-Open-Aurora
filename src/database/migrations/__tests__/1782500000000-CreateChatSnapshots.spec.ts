import { QueryRunner } from 'typeorm';
import { CreateChatSnapshots1782500000000 } from '../1782500000000-CreateChatSnapshots';

describe('CreateChatSnapshots migration', () => {
  it('creates the durable chat table and its indexes without deleting existing data', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const runner = {
      connection: { options: { type: 'sqlite' } },
      hasTable: jest.fn().mockResolvedValue(false),
      query,
    } as unknown as QueryRunner;
    const migration = new CreateChatSnapshots1782500000000();

    await migration.up(runner);

    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('CREATE TABLE "chat_snapshots"'));
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('"contactPhone" varchar(50)'));
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('"lastMessage" text'));
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('CREATE UNIQUE INDEX'));
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining('session_timestamp'));
  });

  it('drops only the snapshot indexes and table on rollback', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const runner = { query } as unknown as QueryRunner;

    await new CreateChatSnapshots1782500000000().down(runner);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenLastCalledWith('DROP TABLE "chat_snapshots"');
  });
});
