import { ForbiddenException, Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
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
    const email = this.configService.get<string>('omega.defaultAdminEmail', 'masteradmin@auroramy.com');
    const password = this.configService.get<string>('omega.defaultAdminPassword', 'Abcd1234');
    const supportEmail = this.configService.get<string>('omega.defaultSupportEmail', 'superadmin@auroramy.com');
    await this.ensureDefaultUser({
      fullName: 'Master Admin',
      email,
      password,
      role: OmegaUserRole.SUPER_ADMIN,
    });
    await this.ensureDefaultUser({
      fullName: 'Super Admin',
      email: supportEmail,
      password,
      role: OmegaUserRole.SUPPORT_ADMIN,
    });
  }

  async login(email: string, password: string): Promise<{ token: string; user: OmegaUser; expiresAt: Date }> {
    const user = await this.userRepository.findOne({ where: { email: email.toLowerCase() } });
    if (!user || !this.verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid Aurora credentials');
    }

    if (user.status !== OmegaUserStatus.ACTIVE) {
      throw new UnauthorizedException('This Aurora user is inactive');
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
      throw new UnauthorizedException('Aurora session has expired');
    }

    const user = await this.userRepository.findOne({ where: { id: session.userId } });
    if (!user || user.status !== OmegaUserStatus.ACTIVE) {
      throw new UnauthorizedException('Aurora user is unavailable');
    }

    return { user, session };
  }

  async logout(token: string): Promise<void> {
    await this.sessionRepository.delete({ tokenHash: this.hashToken(token) });
  }

  async updateProfile(
    userId: string,
    updates: { fullName?: string; password?: string; isOnDuty?: boolean },
  ): Promise<OmegaUser> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException('Aurora user is unavailable');
    }

    if (updates.fullName !== undefined) {
      user.fullName = updates.fullName;
    }
    if (updates.password) {
      user.passwordHash = this.hashPassword(updates.password);
      user.mustChangePassword = false;
    }
    if (updates.isOnDuty !== undefined) {
      user.isOnDuty = updates.isOnDuty;
    }
    await this.userRepository.save(user);
    return user;
  }

  assertPasswordChangeSatisfied(user: OmegaUser, requestPath: string, method: string): void {
    if (!user.mustChangePassword) {
      return;
    }

    const normalizedPath = requestPath.split('?')[0].replace(/^\/api/, '');
    const normalizedMethod = method.toUpperCase();
    const canUpdateOwnProfile = normalizedPath === '/omega/auth/me' && normalizedMethod === 'PATCH';
    const canViewOwnProfile = normalizedPath === '/omega/auth/me' && normalizedMethod === 'GET';
    const canLogout = normalizedPath === '/omega/auth/logout' && normalizedMethod === 'POST';

    if (canUpdateOwnProfile || canViewOwnProfile || canLogout) {
      return;
    }

    throw new ForbiddenException('Password change is required before accessing Aurora');
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
      if (existing.mustChangePassword !== true && this.verifyPassword(password, existing.passwordHash)) {
        existing.mustChangePassword = true;
        await this.userRepository.save(existing);
      }
      return;
    }

    await this.userRepository.save(
      this.userRepository.create({
        fullName,
        email: normalizedEmail,
        passwordHash: this.hashPassword(password),
        role,
        status: OmegaUserStatus.ACTIVE,
        isOnDuty: true,
        mustChangePassword: true,
      }),
    );
  }
}
