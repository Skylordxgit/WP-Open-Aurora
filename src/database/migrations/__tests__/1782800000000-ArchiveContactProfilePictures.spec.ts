import { QueryRunner } from 'typeorm';
import { ArchiveContactProfilePictures1782800000000 } from '../1782800000000-ArchiveContactProfilePictures';

describe('ArchiveContactProfilePictures1782800000000', () => {
  it('adds durable profile-picture storage metadata to chat snapshots', async () => {
    const addColumn = jest.fn().mockResolvedValue(undefined);
    const runner = {
      hasColumn: jest.fn().mockResolvedValue(false),
      addColumn,
    } as unknown as QueryRunner;

    await new ArchiveContactProfilePictures1782800000000().up(runner);

    expect(addColumn).toHaveBeenCalledTimes(2);
    const calls = addColumn.mock.calls as unknown[][];
    expect(calls.map(call => (call[1] as { name: string }).name)).toEqual(['profilePicPath', 'profilePicMimetype']);
  });
});
