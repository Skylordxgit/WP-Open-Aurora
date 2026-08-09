import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  OmegaAuthSession,
  OmegaCampaign,
  OmegaCampaignRecipient,
  OmegaCampaignStatus,
  OmegaClient,
  OmegaClientStatus,
  OmegaContact,
  OmegaContactGroup,
  OmegaMessage,
  OmegaMessageDirection,
  OmegaMessageStatus,
  OmegaPlan,
  OmegaSessionStatus,
  OmegaSubscription,
  OmegaSubscriptionStatus,
  OmegaUsageLog,
  OmegaUsageMetricType,
  OmegaUser,
  OmegaUserRole,
  OmegaUserStatus,
  OmegaWhatsappSession,
} from './entities';
import {
  AssignOmegaSessionDto,
  CreateOmegaClientDto,
  CreateOmegaPlanDto,
  CreateOmegaUserDto,
  UpdateOmegaClientDto,
  UpdateOmegaPlanDto,
  UpdateOmegaUserDto,
} from './dto';
import { OmegaAuthService } from './omega-auth.service';
import { OpenwaApiClientService } from './openwa-api-client.service';
import { OmegaUsageService } from './omega-usage.service';

@Injectable()
export class OmegaAdminService implements OnModuleInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly omegaAuthService: OmegaAuthService,
    private readonly openwaApiClientService: OpenwaApiClientService,
    private readonly omegaUsageService: OmegaUsageService,
    @InjectRepository(OmegaClient, 'main')
    private readonly clientRepository: Repository<OmegaClient>,
    @InjectRepository(OmegaPlan, 'main')
    private readonly planRepository: Repository<OmegaPlan>,
    @InjectRepository(OmegaWhatsappSession, 'main')
    private readonly sessionRepository: Repository<OmegaWhatsappSession>,
    @InjectRepository(OmegaUsageLog, 'main')
    private readonly usageRepository: Repository<OmegaUsageLog>,
    @InjectRepository(OmegaSubscription, 'main')
    private readonly subscriptionRepository: Repository<OmegaSubscription>,
    @InjectRepository(OmegaUser, 'main')
    private readonly userRepository: Repository<OmegaUser>,
    @InjectRepository(OmegaContact, 'main')
    private readonly contactRepository: Repository<OmegaContact>,
    @InjectRepository(OmegaContactGroup, 'main')
    private readonly contactGroupRepository: Repository<OmegaContactGroup>,
    @InjectRepository(OmegaCampaign, 'main')
    private readonly campaignRepository: Repository<OmegaCampaign>,
    @InjectRepository(OmegaCampaignRecipient, 'main')
    private readonly campaignRecipientRepository: Repository<OmegaCampaignRecipient>,
    @InjectRepository(OmegaMessage, 'main')
    private readonly messageRepository: Repository<OmegaMessage>,
    @InjectRepository(OmegaAuthSession, 'main')
    private readonly authSessionRepository: Repository<OmegaAuthSession>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedPlans();
    await this.seedDemoData();
    await this.syncSessions().catch(() => {
      // Avoid failing boot if OPENWA is not ready yet; the manual sync endpoint remains available.
    });
  }

  async getDashboardSummary() {
    const [clients, plans, sessions, usageOverview, staff, campaigns, contacts, groups] = await Promise.all([
      this.clientRepository.find(),
      this.planRepository.find(),
      this.listSessionEntities(),
      this.omegaUsageService.buildUsageOverview(await this.clientRepository.find(), await this.listSessionEntities()),
      this.userRepository.find(),
      this.campaignRepository.find(),
      this.contactRepository.find(),
      this.contactGroupRepository.find(),
    ]);
    const clientsById = new Map(clients.map(client => [client.id, client]));
    const topClients = [...usageOverview.perClient]
      .sort((a, b) => b.messagesThisMonth - a.messagesThisMonth)
      .slice(0, 5)
      .map(client => ({
        clientId: client.clientId,
        companyName: client.companyName,
        units: client.messagesThisMonth,
      }));

    return {
      brandName: 'Omega WA API',
      stats: {
        totalClients: clients.length,
        activeClients: clients.filter(client => client.status === OmegaClientStatus.ACTIVE).length,
        suspendedClients: clients.filter(client => client.status === OmegaClientStatus.SUSPENDED).length,
        plans: plans.length,
        totalSessions: sessions.length,
        connectedSessions: sessions.filter(session => session.status === OmegaSessionStatus.CONNECTED).length,
        reconnectSessions: sessions.filter(session => session.status === OmegaSessionStatus.NEEDS_RECONNECT).length,
        unassignedSessions: sessions.filter(session => !session.clientId).length,
        messagesThisMonth: usageOverview.totals.messagesThisMonth,
        messagesToday: usageOverview.totals.messagesToday,
        staffCount: staff.filter(user =>
          [OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN].includes(user.role),
        ).length,
        contactCount: contacts.length,
        contactGroupCount: groups.length,
        campaigns: campaigns.length,
      },
      monthlyTrend: usageOverview.trend.map(point => ({ ...point, reconnects: 0 })),
      usageFallbackUsed: usageOverview.fallbackUsed,
      topClients,
      reconnectQueue: sessions
        .filter(session => session.status === OmegaSessionStatus.NEEDS_RECONNECT)
        .map(session => ({
          id: session.id,
          openwaSessionId: session.openwaSessionId,
          openwaSessionName: session.openwaSessionName,
          phoneNumber: session.phoneNumber,
          companyName: session.clientId ? clientsById.get(session.clientId)?.companyName ?? 'Unknown client' : null,
          lastSeenAt: session.lastSeenAt,
        })),
    };
  }

  async listClients() {
    const [clients, plans, sessions, subscriptions, usageOverview, users] = await Promise.all([
      this.clientRepository.find({ order: { createdAt: 'DESC' } }),
      this.planRepository.find(),
      this.listSessionEntities(),
      this.subscriptionRepository.find(),
      this.omegaUsageService.buildUsageOverview(await this.clientRepository.find(), await this.listSessionEntities()),
      this.userRepository.find(),
    ]);

    return clients.map(client => {
      const plan = plans.find(item => item.id === client.planId) ?? null;
      const clientSessions = sessions.filter(session => session.clientId === client.id);
      const subscription = subscriptions.find(item => item.clientId === client.id) ?? null;
      const usageThisMonth =
        usageOverview.perClient.find(entry => entry.clientId === client.id)?.messagesThisMonth ?? 0;
      const clientUsers = users.filter(user => user.clientId === client.id);

      return {
        ...client,
        planName: plan?.name ?? 'Custom',
        sessionCount: clientSessions.length,
        connectedSessions: clientSessions.filter(session => session.status === OmegaSessionStatus.CONNECTED).length,
        usageThisMonth,
        subscriptionStatus: subscription?.status ?? OmegaSubscriptionStatus.TRIAL,
        userCount: clientUsers.length,
      };
    });
  }

  async getClientById(id: string) {
    const client = await this.clientRepository.findOne({ where: { id } });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const [plan, subscription, sessions, usage, users, messages, contacts, contactGroups] = await Promise.all([
      client.planId ? this.planRepository.findOne({ where: { id: client.planId } }) : null,
      this.subscriptionRepository.findOne({ where: { clientId: client.id } }),
      this.getClientSessions(client.id),
      this.getClientUsage(client.id),
      this.userRepository.find({ where: { clientId: client.id }, order: { createdAt: 'DESC' } }),
      this.messageRepository.find({ where: { clientId: client.id }, order: { createdAt: 'DESC' }, take: 10 }),
      this.contactRepository.find({ where: { clientId: client.id } }),
      this.contactGroupRepository.find({ where: { clientId: client.id } }),
    ]);

    return {
      ...client,
      plan,
      subscription,
      sessions,
      usageSummary: usage.trend,
      usageStats: usage,
      staff: users,
      recentMessages: messages,
      contactsCount: contacts.length,
      contactGroupsCount: contactGroups.length,
    };
  }

  async createClient(dto: CreateOmegaClientDto) {
    if (dto.planId) {
      await this.ensurePlanExists(dto.planId);
    }

    const client = await this.clientRepository.save(
      this.clientRepository.create({
        companyName: dto.companyName,
        ownerName: dto.ownerName,
        email: dto.email.toLowerCase(),
        phone: dto.phone,
        status: dto.status ?? OmegaClientStatus.ACTIVE,
        planId: dto.planId ?? null,
        monthlyMessageLimit: dto.monthlyMessageLimit,
        whatsappAccountLimit: dto.whatsappAccountLimit,
      }),
    );

    await this.upsertSubscription(client.id, dto.planId ?? null, dto.monthlyMessageLimit, dto.whatsappAccountLimit);
    return this.getClientById(client.id);
  }

  async updateClient(id: string, dto: UpdateOmegaClientDto) {
    const client = await this.getClientEntity(id);
    if (dto.planId !== undefined && dto.planId) {
      await this.ensurePlanExists(dto.planId);
    }

    Object.assign(client, {
      companyName: dto.companyName ?? client.companyName,
      ownerName: dto.ownerName ?? client.ownerName,
      email: dto.email ? dto.email.toLowerCase() : client.email,
      phone: dto.phone ?? client.phone,
      status: dto.status ?? client.status,
      planId: dto.planId !== undefined ? dto.planId : client.planId,
      monthlyMessageLimit: dto.monthlyMessageLimit ?? client.monthlyMessageLimit,
      whatsappAccountLimit: dto.whatsappAccountLimit ?? client.whatsappAccountLimit,
    });

    await this.clientRepository.save(client);
    await this.upsertSubscription(client.id, client.planId, client.monthlyMessageLimit, client.whatsappAccountLimit);
    return this.getClientById(client.id);
  }

  async listPlans() {
    const [plans, clients] = await Promise.all([
      this.planRepository.find({ order: { monthlyPrice: 'ASC', createdAt: 'ASC' } }),
      this.clientRepository.find(),
    ]);

    return plans.map(plan => ({
      ...plan,
      activeClients: clients.filter(client => client.planId === plan.id && client.status === OmegaClientStatus.ACTIVE).length,
    }));
  }

  async createPlan(dto: CreateOmegaPlanDto) {
    return this.planRepository.save(
      this.planRepository.create({
        name: dto.name,
        description: dto.description ?? null,
        monthlyMessageLimit: dto.monthlyMessageLimit,
        whatsappAccountLimit: dto.whatsappAccountLimit,
        monthlyPrice: dto.monthlyPrice,
        features: dto.features ?? [],
        isActive: dto.isActive ?? true,
      }),
    );
  }

  async updatePlan(id: string, dto: UpdateOmegaPlanDto) {
    const plan = await this.planRepository.findOne({ where: { id } });
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }

    Object.assign(plan, {
      name: dto.name ?? plan.name,
      description: dto.description ?? plan.description,
      monthlyMessageLimit: dto.monthlyMessageLimit ?? plan.monthlyMessageLimit,
      whatsappAccountLimit: dto.whatsappAccountLimit ?? plan.whatsappAccountLimit,
      monthlyPrice: dto.monthlyPrice ?? plan.monthlyPrice,
      features: dto.features ?? plan.features,
      isActive: dto.isActive ?? plan.isActive,
    });

    await this.planRepository.save(plan);
    return plan;
  }

  async listSessions(filters: { status?: string; clientId?: string } = {}) {
    await this.syncSessions();
    const clients = await this.clientRepository.find();
    const sessions = await this.listSessionEntities(filters);
    const clientsById = new Map(clients.map(client => [client.id, client]));

    return sessions.map(session => ({
      ...session,
      companyName: session.clientId ? clientsById.get(session.clientId)?.companyName ?? null : null,
    }));
  }

  async assignSession(id: string, dto: AssignOmegaSessionDto, actorRole: OmegaUserRole) {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException('WhatsApp session not found');
    }

    if (!dto.clientId) {
      throw new BadRequestException('clientId is required for assignment');
    }

    const client = await this.getClientEntity(dto.clientId);
    const clientSessions = await this.sessionRepository.find({ where: { clientId: client.id } });
    const isNewAssignment = session.clientId !== client.id;
    if (clientSessions.length >= client.whatsappAccountLimit && isNewAssignment) {
      if (dto.overrideLimit && actorRole !== OmegaUserRole.SUPER_ADMIN) {
        throw new ForbiddenException('Only super_admin can override the WhatsApp account limit');
      }
      if (!dto.overrideLimit) {
        throw new BadRequestException(
          'Client has reached the WhatsApp account limit for the current plan. Super admin override is required.',
        );
      }
    }

    session.clientId = client.id;
    session.assignedToClient = true;
    session.replacementRequested = false;
    await this.sessionRepository.save(session);
    return this.decorateSession(session);
  }

  async unassignSession(id: string) {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException('WhatsApp session not found');
    }

    session.clientId = null;
    session.assignedToClient = false;
    await this.sessionRepository.save(session);
    return this.decorateSession(session);
  }

  async updateReplacementFlag(id: string, replacementRequested: boolean) {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException('WhatsApp session not found');
    }
    session.replacementRequested = replacementRequested;
    await this.sessionRepository.save(session);
    return this.decorateSession(session);
  }

  async listUsers() {
    const [users, clients] = await Promise.all([
      this.userRepository.find({ order: { createdAt: 'DESC' } }),
      this.clientRepository.find(),
    ]);
    const clientsById = new Map(clients.map(client => [client.id, client.companyName]));

    return users.map(user => ({
      ...user,
      companyName: user.clientId ? clientsById.get(user.clientId) ?? null : null,
    }));
  }

  async createUser(dto: CreateOmegaUserDto) {
    if (dto.clientId) {
      await this.getClientEntity(dto.clientId);
    }

    return this.userRepository.save(
      this.userRepository.create({
        fullName: dto.fullName,
        email: dto.email.toLowerCase(),
        passwordHash: this.omegaAuthService.hashPassword(dto.password),
        role: dto.role,
        status: OmegaUserStatus.ACTIVE,
        clientId: dto.clientId ?? null,
      }),
    );
  }

  async updateUser(id: string, dto: UpdateOmegaUserDto) {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (dto.clientId) {
      await this.getClientEntity(dto.clientId);
    }

    Object.assign(user, {
      fullName: dto.fullName ?? user.fullName,
      email: dto.email ? dto.email.toLowerCase() : user.email,
      role: dto.role ?? user.role,
      status: dto.status ?? user.status,
      clientId: dto.clientId !== undefined ? dto.clientId : user.clientId,
    });
    if (dto.password) {
      user.passwordHash = this.omegaAuthService.hashPassword(dto.password);
    }

    await this.userRepository.save(user);
    return user;
  }

  async getUsageOverview() {
    const [clients, sessions, usage, manualUsage] = await Promise.all([
      this.clientRepository.find(),
      this.listSessionEntities(),
      this.omegaUsageService.buildUsageOverview(await this.clientRepository.find(), await this.listSessionEntities()),
      this.usageRepository.find({ order: { createdAt: 'DESC' } }),
    ]);

    return {
      currentMonth: usage.currentMonth,
      fallbackUsed: usage.fallbackUsed,
      totals: {
        messagesToday: usage.totals.messagesToday,
        messagesThisMonth: usage.totals.messagesThisMonth,
        reconnections: manualUsage
          .filter(entry => entry.periodMonth === usage.currentMonth && entry.metricType === OmegaUsageMetricType.RECONNECT)
          .reduce((sum, entry) => sum + entry.units, 0),
      },
      perClient: usage.perClient.map(client => ({
        ...client,
        sessionCount: sessions.filter(session => session.clientId === client.clientId).length,
      })),
      trend: usage.trend.map(point => ({ ...point, reconnects: 0 })),
      bySession: usage.bySession,
      byCampaign: usage.byCampaign,
    };
  }

  async getClientUsage(clientId: string) {
    const client = await this.getClientEntity(clientId);
    const sessions = await this.getClientSessionEntities(clientId);
    return this.omegaUsageService.buildClientUsage(client, sessions);
  }

  async getSettings() {
    const [activeAuthSessions, totalClients, totalSessions] = await Promise.all([
      this.authSessionRepository.count(),
      this.clientRepository.count(),
      this.sessionRepository.count(),
    ]);

    return {
      brandName: 'Omega WA API',
      architecture: {
        omegaLayer: '/api/omega',
        openwaApiBaseUrl: this.configService.get<string>('omega.openwaApiBaseUrl', '/api'),
        openwaBaseUrl: this.configService.get<string>('openwa.baseUrl', 'http://localhost:2785'),
        openwaHttpClientConfigured: !!this.configService.get<string>('openwa.apiKey'),
        openwaMasterKeyConfigured: !!process.env.API_MASTER_KEY,
        credentialsStoredInBackendOnly: true,
        existingAdminPanelUntouched: true,
      },
      operations: {
        activeAdminSessions: activeAuthSessions,
        totalClients,
        totalSessions,
        authSessionTtlHours: this.configService.get<number>('omega.authSessionTtlHours', 12),
      },
      defaultAccounts: {
        superAdminEmail: this.configService.get<string>('omega.defaultAdminEmail', 'admin@omega.local'),
        supportAdminEmail: this.configService.get<string>('omega.defaultSupportEmail', 'support@omega.local'),
      },
    };
  }

  async syncSessions() {
    const snapshots = await this.openwaApiClientService.listSessions();
    const existing = await this.sessionRepository.find();
    const existingByOpenwaId = new Map(existing.map(session => [session.openwaSessionId, session]));
    const now = new Date();

    for (const snapshot of snapshots) {
      const current = existingByOpenwaId.get(snapshot.openwaSessionId);
      if (current) {
        current.openwaSessionName = snapshot.openwaSessionName;
        current.phoneNumber = snapshot.phoneNumber;
        current.status = snapshot.status as OmegaSessionStatus;
        current.lastSeenAt = snapshot.lastSeenAt;
        current.lastSyncAt = now;
        current.assignedToClient = !!current.clientId;
        await this.sessionRepository.save(current);
        existingByOpenwaId.delete(snapshot.openwaSessionId);
        continue;
      }

      await this.sessionRepository.save(
        this.sessionRepository.create({
          openwaSessionId: snapshot.openwaSessionId,
          openwaSessionName: snapshot.openwaSessionName,
          phoneNumber: snapshot.phoneNumber,
          status: snapshot.status as OmegaSessionStatus,
          assignedToClient: false,
          replacementRequested: false,
          lastSeenAt: snapshot.lastSeenAt,
          lastSyncAt: now,
          createdAt: snapshot.createdAt,
          updatedAt: snapshot.updatedAt,
        }),
      );
    }

    for (const stale of existingByOpenwaId.values()) {
      stale.status = stale.clientId ? OmegaSessionStatus.NEEDS_RECONNECT : OmegaSessionStatus.DISCONNECTED;
      stale.lastSyncAt = now;
      await this.sessionRepository.save(stale);
    }

    const sessions = await this.listSessionEntities();
    const clients = await this.clientRepository.find();
    const clientsById = new Map(clients.map(client => [client.id, client]));
    return sessions.map(session => ({
      ...session,
      companyName: session.clientId ? clientsById.get(session.clientId)?.companyName ?? null : null,
    }));
  }

  async getClientSessions(clientId: string) {
    await this.getClientEntity(clientId);
    const sessions = await this.getClientSessionEntities(clientId);
    return Promise.all(sessions.map(session => this.decorateSession(session)));
  }

  private async seedPlans() {
    if ((await this.planRepository.count()) > 0) {
      return;
    }

    await this.planRepository.save([
      this.planRepository.create({
        name: 'Starter',
        description: 'For smaller teams onboarding WhatsApp support quickly.',
        monthlyMessageLimit: 15000,
        whatsappAccountLimit: 2,
        monthlyPrice: 99,
        features: ['2 WhatsApp accounts', 'Basic support', 'Monthly usage reporting'],
        isActive: true,
      }),
      this.planRepository.create({
        name: 'Growth',
        description: 'For active sales and support teams with multiple brands.',
        monthlyMessageLimit: 75000,
        whatsappAccountLimit: 8,
        monthlyPrice: 299,
        features: ['8 WhatsApp accounts', 'Priority support', 'Usage monitoring'],
        isActive: true,
      }),
      this.planRepository.create({
        name: 'Scale',
        description: 'For high-volume multi-team deployments needing support oversight.',
        monthlyMessageLimit: 250000,
        whatsappAccountLimit: 20,
        monthlyPrice: 799,
        features: ['20 WhatsApp accounts', 'Support admin controls', 'Reconnect queue visibility'],
        isActive: true,
      }),
    ]);
  }

  private async seedDemoData() {
    if ((await this.clientRepository.count()) > 0) {
      return;
    }

    const plans = await this.planRepository.find({ order: { monthlyPrice: 'ASC' } });
    const starter = plans[0];
    const growth = plans[1] ?? plans[0];

    const [firstClient, secondClient] = await this.clientRepository.save([
      this.clientRepository.create({
        companyName: 'Northstar Health',
        ownerName: 'Amelia Reed',
        email: 'ops@northstar-health.example',
        phone: '+1 202 555 0151',
        status: OmegaClientStatus.ACTIVE,
        planId: growth.id,
        monthlyMessageLimit: growth.monthlyMessageLimit,
        whatsappAccountLimit: growth.whatsappAccountLimit,
      }),
      this.clientRepository.create({
        companyName: 'BluePeak Realty',
        ownerName: 'Marcus Silva',
        email: 'hello@bluepeak-realty.example',
        phone: '+1 202 555 0188',
        status: OmegaClientStatus.SUSPENDED,
        planId: starter.id,
        monthlyMessageLimit: starter.monthlyMessageLimit,
        whatsappAccountLimit: starter.whatsappAccountLimit,
      }),
    ]);

    await this.subscriptionRepository.save([
      this.subscriptionRepository.create({
        clientId: firstClient.id,
        planId: growth.id,
        status: OmegaSubscriptionStatus.ACTIVE,
        monthlyMessageLimit: growth.monthlyMessageLimit,
        whatsappAccountLimit: growth.whatsappAccountLimit,
        startsAt: new Date(),
      }),
      this.subscriptionRepository.create({
        clientId: secondClient.id,
        planId: starter.id,
        status: OmegaSubscriptionStatus.PAST_DUE,
        monthlyMessageLimit: starter.monthlyMessageLimit,
        whatsappAccountLimit: starter.whatsappAccountLimit,
        startsAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30),
      }),
    ]);

    await this.userRepository.save([
      this.userRepository.create({
        fullName: 'Northstar Admin',
        email: 'admin@northstar-health.example',
        passwordHash: this.omegaAuthService.hashPassword('ChangeMe123!'),
        role: OmegaUserRole.CLIENT_ADMIN,
        status: OmegaUserStatus.ACTIVE,
        clientId: firstClient.id,
      }),
      this.userRepository.create({
        fullName: 'Northstar Agent',
        email: 'agent@northstar-health.example',
        passwordHash: this.omegaAuthService.hashPassword('ChangeMe123!'),
        role: OmegaUserRole.CLIENT_AGENT,
        status: OmegaUserStatus.ACTIVE,
        clientId: firstClient.id,
      }),
      this.userRepository.create({
        fullName: 'BluePeak Admin',
        email: 'admin@bluepeak-realty.example',
        passwordHash: this.omegaAuthService.hashPassword('ChangeMe123!'),
        role: OmegaUserRole.CLIENT_ADMIN,
        status: OmegaUserStatus.SUSPENDED,
        clientId: secondClient.id,
      }),
    ]);

    await this.contactRepository.save([
      this.contactRepository.create({
        clientId: firstClient.id,
        name: 'Jamie Brooks',
        phoneNumber: '+1 202 555 1101',
        email: 'jamie@example.com',
        metadata: { source: 'import' },
      }),
      this.contactRepository.create({
        clientId: firstClient.id,
        name: 'Harper Lane',
        phoneNumber: '+1 202 555 1102',
        email: 'harper@example.com',
        metadata: { source: 'lead form' },
      }),
    ]);

    await this.contactGroupRepository.save(
      this.contactGroupRepository.create({
        clientId: firstClient.id,
        name: 'Priority Leads',
        description: 'Imported from CRM for follow-up campaigns.',
        contactCount: 2,
      }),
    );

    const draftCampaign = await this.campaignRepository.save(
      this.campaignRepository.create({
        clientId: firstClient.id,
        name: 'June Welcome Follow-up',
        status: OmegaCampaignStatus.DRAFT,
      }),
    );

    await this.campaignRecipientRepository.save(
      this.campaignRecipientRepository.create({
        campaignId: draftCampaign.id,
        phoneNumber: '+1 202 555 1101',
      }),
    );

    await this.messageRepository.save([
      this.messageRepository.create({
        clientId: firstClient.id,
        campaignId: draftCampaign.id,
        recipient: '+1 202 555 1101',
        direction: OmegaMessageDirection.OUTBOUND,
        status: OmegaMessageStatus.SENT,
        body: 'Welcome to Northstar Health. A coordinator will reach out shortly.',
        sentAt: new Date(Date.now() - 1000 * 60 * 20),
      }),
      this.messageRepository.create({
        clientId: firstClient.id,
        recipient: '+1 202 555 1102',
        direction: OmegaMessageDirection.INBOUND,
        status: OmegaMessageStatus.READ,
        body: 'Please call me after 4 PM.',
        sentAt: new Date(Date.now() - 1000 * 60 * 10),
      }),
    ]);

    const usageRows: OmegaUsageLog[] = [];
    usageRows.push(
      this.usageRepository.create({
        clientId: firstClient.id,
        metricType: OmegaUsageMetricType.RECONNECT,
        units: 2,
        periodMonth: this.currentMonth(),
        metadata: { reason: 'session handoff' },
      }),
    );
    await this.usageRepository.save(usageRows);
  }

  private async upsertSubscription(
    clientId: string,
    planId: string | null,
    monthlyMessageLimit: number,
    whatsappAccountLimit: number,
  ) {
    const current = await this.subscriptionRepository.findOne({ where: { clientId } });
    if (!current) {
      await this.subscriptionRepository.save(
        this.subscriptionRepository.create({
          clientId,
          planId: planId ?? '',
          status: OmegaSubscriptionStatus.ACTIVE,
          monthlyMessageLimit,
          whatsappAccountLimit,
          startsAt: new Date(),
        }),
      );
      return;
    }

    current.planId = planId ?? current.planId;
    current.monthlyMessageLimit = monthlyMessageLimit;
    current.whatsappAccountLimit = whatsappAccountLimit;
    await this.subscriptionRepository.save(current);
  }

  private async ensurePlanExists(planId: string) {
    const plan = await this.planRepository.findOne({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException('Plan not found');
    }
  }

  private async getClientEntity(id: string) {
    const client = await this.clientRepository.findOne({ where: { id } });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
    return client;
  }

  private async getClientSessionEntities(clientId: string) {
    return this.sessionRepository.find({ where: { clientId }, order: { createdAt: 'DESC' } });
  }

  private async listSessionEntities(filters: { status?: string; clientId?: string } = {}) {
    const sessions = await this.sessionRepository.find({ order: { createdAt: 'DESC' } });
    return sessions.filter(session => {
      if (filters.status && session.status !== filters.status) return false;
      if (filters.clientId && session.clientId !== filters.clientId) return false;
      return true;
    });
  }

  private async decorateSession(session: OmegaWhatsappSession) {
    const client = session.clientId ? await this.clientRepository.findOne({ where: { id: session.clientId } }) : null;
    return {
      ...session,
      companyName: client?.companyName ?? null,
    };
  }

  private currentMonth(date = new Date()): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${date.getFullYear()}-${month}`;
  }

  private lastSixMonths(): string[] {
    const months: string[] = [];
    const cursor = new Date();
    for (let index = 5; index >= 0; index -= 1) {
      const point = new Date(cursor.getFullYear(), cursor.getMonth() - index, 1);
      months.push(this.currentMonth(point));
    }
    return months;
  }

  private buildMonthlyTrend(usage: OmegaUsageLog[]) {
    const months = this.lastSixMonths();
    return months.map(month => {
      const monthRows = usage.filter(entry => entry.periodMonth === month);
      return {
        month,
        messages: monthRows
          .filter(entry => entry.metricType === OmegaUsageMetricType.MESSAGES)
          .reduce((sum, entry) => sum + entry.units, 0),
        reconnects: monthRows
          .filter(entry => entry.metricType === OmegaUsageMetricType.RECONNECT)
          .reduce((sum, entry) => sum + entry.units, 0),
      };
    });
  }
}
