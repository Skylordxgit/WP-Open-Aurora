import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { BigIntNumberTransformer } from '../../../common/transformers/bigint.transformer';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { dateColumnType } from '../../../common/utils/column-types';

export enum MessageDirection {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
}

export enum MessageStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

@Entity('messages')
@Index(['sessionId', 'createdAt'])
@Index(['chatId'])
// Composite index for the ack-driven status UPDATE (scoped by sessionId + waMessageId).
// Without it every ack does a full table scan of a hot table.
@Index('UQ_messages_session_wa_id', ['sessionId', 'waMessageId'], {
  unique: true,
  where: '"waMessageId" IS NOT NULL',
})
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  @Index()
  sessionId: string;

  @Column({ nullable: true })
  waMessageId: string;

  @Column()
  chatId: string;

  @Column()
  from: string;

  @Column()
  to: string;

  @Column({ type: 'text', nullable: true })
  body: string;

  @Column({ default: 'text' })
  type: string;

  @Column({
    type: 'varchar',
    default: MessageDirection.OUTGOING,
  })
  direction: MessageDirection;

  @Column({ type: 'bigint', nullable: true, transformer: BigIntNumberTransformer })
  timestamp: number;

  @Column({ nullable: true })
  @Index('IDX_messages_mediaPath')
  mediaPath: string;

  @Column({ nullable: true })
  mediaMimetype: string;

  @Column({ type: 'integer', default: 0 })
  retryCount: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  @Index('IDX_messages_nextRetryAt')
  nextRetryAt: Date | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: jsonColumnType(), nullable: true })
  metadata: Record<string, unknown>;

  @Column({
    type: 'varchar',
    default: MessageStatus.SENT,
  })
  @Index()
  status: MessageStatus;

  @CreateDateColumn()
  createdAt: Date;
}
