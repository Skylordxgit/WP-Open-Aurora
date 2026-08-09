import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { OmegaUserRole, OmegaUserStatus } from './omega.enums';

@Entity('omega_users')
export class OmegaUser {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  fullName: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 180 })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  clientId: string | null;

  @Column({ type: 'varchar', length: 30, default: OmegaUserRole.CLIENT_AGENT })
  role: OmegaUserRole;

  @Column({ type: 'varchar', length: 20, default: OmegaUserStatus.ACTIVE })
  status: OmegaUserStatus;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
