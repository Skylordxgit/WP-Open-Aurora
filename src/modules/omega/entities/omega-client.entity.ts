import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { OmegaClientStatus } from './omega.enums';

@Entity('omega_clients')
export class OmegaClient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 180 })
  companyName: string;

  @Column({ type: 'varchar', length: 120 })
  ownerName: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 180 })
  email: string;

  @Column({ type: 'varchar', length: 40 })
  phone: string;

  @Column({ type: 'varchar', length: 20, default: OmegaClientStatus.ACTIVE })
  status: OmegaClientStatus;

  @Column({ type: 'varchar', length: 36, nullable: true })
  planId: string | null;

  @Column({ type: 'int', default: 0 })
  monthlyMessageLimit: number;

  @Column({ type: 'int', default: 1 })
  whatsappAccountLimit: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
