import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

@Entity('omega_plans')
export class OmegaPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 400, nullable: true })
  description: string | null;

  @Column({ type: 'int', default: 0 })
  monthlyMessageLimit: number;

  @Column({ type: 'int', default: 1 })
  whatsappAccountLimit: number;

  @Column({ type: 'float', default: 0 })
  monthlyPrice: number;

  @Column({ type: jsonColumnType(), default: '[]' })
  features: string[];

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
