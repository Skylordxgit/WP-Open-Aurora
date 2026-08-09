import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { OmegaSessionStatus } from './omega.enums';

@Entity('omega_whatsapp_sessions')
export class OmegaWhatsappSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 120 })
  openwaSessionId: string;

  @Column({ type: 'varchar', length: 160, nullable: true })
  openwaSessionName: string | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  clientId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  phoneNumber: string | null;

  @Column({ type: 'varchar', length: 30, default: OmegaSessionStatus.DISCONNECTED })
  status: OmegaSessionStatus;

  @Column({ type: 'boolean', default: false })
  assignedToClient: boolean;

  @Column({ type: 'boolean', default: false })
  replacementRequested: boolean;

  @Column({ type: 'datetime', nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  lastSyncAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
