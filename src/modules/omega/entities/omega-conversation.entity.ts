import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { OmegaConversationStatus } from './omega.enums';

@Entity('omega_conversations')
@Index(['workspaceSessionId', 'chatId'], { unique: true })
@Index(['clientId', 'status'])
export class OmegaConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  clientId: string;

  @Column({ type: 'varchar', length: 36 })
  workspaceSessionId: string;

  @Column({ type: 'varchar', length: 120 })
  openwaSessionId: string;

  @Column({ type: 'varchar', length: 180 })
  chatId: string;

  @Column({ type: 'varchar', length: 180, nullable: true })
  chatName: string | null;

  @Column({ type: 'varchar', length: 20, default: 'whatsapp' })
  channel: string;

  @Column({ type: 'boolean', default: false })
  isGroup: boolean;

  @Column({ type: 'varchar', length: 36, nullable: true })
  assignedUserId: string | null;

  @Column({ type: 'datetime', nullable: true })
  assignedAt: Date | null;

  @Column({ type: 'varchar', length: 20, default: OmegaConversationStatus.OPEN })
  status: OmegaConversationStatus;

  @Column({ type: 'datetime', nullable: true })
  firstInboundAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  firstResponseAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastInboundAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastOutboundAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastActivityAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
