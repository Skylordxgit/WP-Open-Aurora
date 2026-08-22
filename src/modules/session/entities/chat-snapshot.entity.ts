import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('chat_snapshots')
@Index(['sessionId', 'chatId'], { unique: true })
@Index(['sessionId', 'timestamp'])
export class ChatSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 64 })
  sessionId: string;

  @Column({ type: 'varchar', length: 180 })
  chatId: string;

  @Column({ type: 'varchar', length: 180 })
  name: string;

  @Column({ default: false })
  isGroup: boolean;

  @Column({ type: 'integer', default: 0 })
  unreadCount: number;

  @Column({ type: 'bigint', nullable: true })
  timestamp: number | null;

  @Column({ type: 'text', nullable: true })
  lastMessage: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  contactPhone: string | null;

  @Column({ type: 'varchar', nullable: true })
  profilePicPath: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  profilePicMimetype: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
