import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { OmegaCampaignStatus } from './omega.enums';

@Entity('omega_campaigns')
export class OmegaCampaign {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  clientId: string;

  @Column({ type: 'varchar', length: 160 })
  name: string;

  @Column({ type: 'varchar', length: 30, default: OmegaCampaignStatus.DRAFT })
  status: OmegaCampaignStatus;

  @Column({ type: 'datetime', nullable: true })
  scheduledAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
