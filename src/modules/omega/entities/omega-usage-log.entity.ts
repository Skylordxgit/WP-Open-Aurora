import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';
import { OmegaUsageMetricType } from './omega.enums';
import { jsonColumnType } from '../../../common/utils/column-types';

@Entity('omega_usage_logs')
export class OmegaUsageLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 36 })
  clientId: string;

  @Column({ type: 'varchar', length: 36, nullable: true })
  sessionId: string | null;

  @Column({ type: 'varchar', length: 30, default: OmegaUsageMetricType.MESSAGES })
  metricType: OmegaUsageMetricType;

  @Column({ type: 'int', default: 0 })
  units: number;

  @Column({ type: 'varchar', length: 7 })
  periodMonth: string;

  @Column({ type: jsonColumnType(), default: '{}' })
  metadata: Record<string, string | number>;

  @CreateDateColumn()
  createdAt: Date;
}
