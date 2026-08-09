import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { OmegaSubscriptionStatus } from './omega.enums';

@Entity('omega_subscriptions')
export class OmegaSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 36 })
  clientId: string;

  @Column({ type: 'varchar', length: 36 })
  planId: string;

  @Column({ type: 'varchar', length: 20, default: OmegaSubscriptionStatus.ACTIVE })
  status: OmegaSubscriptionStatus;

  @Column({ type: 'int', default: 0 })
  monthlyMessageLimit: number;

  @Column({ type: 'int', default: 1 })
  whatsappAccountLimit: number;

  @Column({ type: 'datetime', nullable: true })
  startsAt: Date | null;

  @Column({ type: 'datetime', nullable: true })
  endsAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
