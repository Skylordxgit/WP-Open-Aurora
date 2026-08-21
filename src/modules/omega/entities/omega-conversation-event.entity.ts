import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { OmegaConversationEventType } from './omega.enums';

@Entity('omega_conversation_events')
@Index(['clientId', 'createdAt'])
@Index(['userId', 'createdAt'])
export class OmegaConversationEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  conversationId: string;

  @Column({ type: 'varchar', length: 36 })
  clientId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 36 })
  workspaceSessionId: string;

  @Column({ type: 'varchar', length: 120 })
  openwaSessionId: string;

  @Column({ type: 'varchar', length: 180 })
  chatId: string;

  @Column({ type: 'varchar', length: 30 })
  eventType: OmegaConversationEventType;

  @Column({ type: 'integer', nullable: true })
  responseMs: number | null;

  @CreateDateColumn()
  createdAt: Date;
}
