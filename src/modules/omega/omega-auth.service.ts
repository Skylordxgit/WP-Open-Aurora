import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { OmegaAuthSession, OmegaUser, OmegaUserRole, OmegaUserStatus } from './entities';

@Injectable()
export class OmegaAuthService implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(OmegaUser, 'main')
    private readonly userRepository: Repository<OmegaUser>,
    @InjectRepository(OmegaAuthSession, 'main')
    private readonly sessionRepository: Repository<OmegaAuthSession>,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = this.configService.get<string>('omega.defaultAdminEmail', 'admin@omega.local');
    const password = this.configService.get<string>('omega.defaultAdminPassword', 'ChangeMe123!');
    const supportEmail = this.configService.get<string>('omega.defaultSupportEmail', 'support@omega.local');
    await this.ensureDefaultUser({
      fullName: 'Omega Super Admin',
      email,
      password,
      role: OmegaUserRole.SUPER_ADMIN,
    });
    await this.ensureDefaultUser({
      fullName: 'Omega Support',
      email: supportEmail,
      password,
      role: OmegaUserRole.SUPPORT_ADMIN,
    });
  }

  async login(email: string, password: string): Promise<{ token: string; user: OmegaUser; expiresAt: Date }> {
    const user = await this.userRepository.findOne({ where: { email: email.toLowerCase() } });
    if (!user || !this.verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid Omega admin credentials');
    }

    if (user.status === OmegaUserStatus.SUSPENDED) {
      throw new UnauthorizedException('This Omega user has been suspended');
    }

    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + this.sessionTtlHours() * 60 * 60 * 1000);

    await this.sessionRepository.save(
      this.sessionRepository.create({
        userId: user.id,
        tokenHash: this.hashToken(token),
        expiresAt,
      }),
    );

    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    return { token, user, expiresAt };
  }

  async validateSessionToken(token: string): Promise<{ user: OmegaUser; session: OmegaAuthSession }> {
    const tokenHash = this.hashToken(token);
    const session = await this.sessionRepository.findOne({ where: { tokenHash } });

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Omega admin session has expired');
    }

    const user = await this.userRepository.findOne({ where: { id: session.userId } });
    if (!user || user.status === OmegaUserStatus.SUSPENDED) {
      throw new UnauthorizedException('Omega admin user is unavailable');
    }

    return { user, session };
  }

  async logout(token: string): Promise<void> {
    await this.sessionRepository.delete({ tokenHash: this.hashToken(token) });
  }

  private sessionTtlHours(): number {
    return this.configService.get<number>('omega.authSessionTtlHours', 12);
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) {
      return false;
    }

    const candidate = scryptSync(password, salt, 64);
    const stored = Buffer.from(hash, 'hex');
    return stored.length === candidate.length && timingSafeEqual(stored, candidate);
  }

  private async ensureDefaultUser({
    fullName,
    email,
    password,
    role,
  }: {
    fullName: string;
    email: string;
    password: string;
    role: OmegaUserRole;
  }): Promise<void> {
    const normalizedEmail = email.toLowerCase();
    const existing = await this.userRepository.findOne({ where: { email: normalizedEmail } });
    if (existing) {
      return;
    }

    await this.userRepository.save(
      this.userRepository.create({
        fullName,
        email: normalizedEmail,
        passwordHash: this.hashPassword(password),
        role,
        status: OmegaUserStatus.ACTIVE,
      }),
    );
  }
}
