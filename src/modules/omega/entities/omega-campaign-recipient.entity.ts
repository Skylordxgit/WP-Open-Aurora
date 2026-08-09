import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { OmegaCampaignRecipientStatus } from './omega.enums';

@Entity('omega_campaign_recipients')
export class OmegaCampaignRecipient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  campaignId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  contactId: string | null;

  @Column({ type: 'varchar', length: 40 })
  phoneNumber: string;

  @Column({ type: 'varchar', length: 30, default: OmegaCampaignRecipientStatus.PENDING })
  status: OmegaCampaignRecipientStatus;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
