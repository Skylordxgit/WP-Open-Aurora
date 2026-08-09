import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { OmegaMessageDirection, OmegaMessageStatus } from './omega.enums';

@Entity('omega_messages')
export class OmegaMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  clientId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  campaignId: string | null;

  @Column({ type: 'varchar', length: 40 })
  recipient: string;

  @Column({ type: 'varchar', length: 20, default: OmegaMessageDirection.OUTBOUND })
  direction: OmegaMessageDirection;

  @Column({ type: 'varchar', length: 20, default: OmegaMessageStatus.QUEUED })
  status: OmegaMessageStatus;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'datetime', nullable: true })
  sentAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
