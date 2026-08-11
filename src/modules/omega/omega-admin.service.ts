import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MessageService } from '../message/message.service';
import { SessionService } from '../session/session.service';
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
    private readonly messageService: MessageService,
    private readonly sessionService: SessionService,
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

  async getDashboardSummary(actor?: OmegaUser) {
    const [clients, plans, sessions, staff, campaigns, contacts, groups] = await Promise.all([
      this.clientRepository.find(),
      this.planRepository.find(),
      this.listSessionEntities(),
      this.userRepository.find(),
      this.campaignRepository.find(),
      this.contactRepository.find(),
      this.contactGroupRepository.find(),
    ]);
    const scopedClients = this.scopeClientsForActor(clients, actor);
    const scopedClientIds = new Set(scopedClients.map(client => client.id));
    const scopedSessions = this.scopeSessionsForActor(sessions, actor, scopedClientIds);
    const scopedStaff = this.scopeUsersForActor(staff, actor);
    const scopedCampaigns = this.scopeRecordsByClientId(campaigns, scopedClientIds);
    const scopedContacts = this.scopeRecordsByClientId(contacts, scopedClientIds);
    const scopedGroups = this.scopeRecordsByClientId(groups, scopedClientIds);
    const usageOverview = await this.omegaUsageService.buildUsageOverview(scopedClients, scopedSessions);
    const clientsById = new Map(scopedClients.map(client => [client.id, client]));
    const topClients = [...usageOverview.perClient]
      .sort((a, b) => b.messagesThisMonth - a.messagesThisMonth)
      .slice(0, 5)
      .map(client => ({
        clientId: client.clientId,
        companyName: client.companyName,
        units: client.messagesThisMonth,
      }));

    return {
      brandName: 'Aurora WA API',
      stats: {
        totalClients: scopedClients.length,
        activeClients: scopedClients.filter(client => client.status === OmegaClientStatus.ACTIVE).length,
        suspendedClients: scopedClients.filter(client => client.status === OmegaClientStatus.SUSPENDED).length,
        plans: plans.length,
        totalSessions: scopedSessions.length,
        connectedSessions: scopedSessions.filter(session => session.status === OmegaSessionStatus.CONNECTED).length,
        reconnectSessions: scopedSessions.filter(session => session.status === OmegaSessionStatus.NEEDS_RECONNECT).length,
        unassignedSessions: scopedSessions.filter(session => !session.clientId).length,
        messagesThisMonth: usageOverview.totals.messagesThisMonth,
        messagesToday: usageOverview.totals.messagesToday,
        staffCount: scopedStaff.length,
        contactCount: scopedContacts.length,
        contactGroupCount: scopedGroups.length,
        campaigns: scopedCampaigns.length,
      },
      monthlyTrend: usageOverview.trend.map(point => ({ ...point, reconnects: 0 })),
      usageFallbackUsed: usageOverview.fallbackUsed,
      topClients,
      reconnectQueue: scopedSessions
        .filter(session => session.status === OmegaSessionStatus.NEEDS_RECONNECT)
        .map(session => ({
          id: session.id,
          openwaSessionId: session.openwaSessionId,
          openwaSessionName: session.openwaSessionName,
          phoneNumber: session.phoneNumber,
          companyName: session.clientId ? (clientsById.get(session.clientId)?.companyName ?? 'Unknown client') : null,
          lastSeenAt: session.lastSeenAt,
        })),
    };
  }

  async listClients(actor?: OmegaUser) {
    const [clients, plans, sessions, subscriptions, users] = await Promise.all([
      this.clientRepository.find({ order: { createdAt: 'DESC' } }),
      this.planRepository.find(),
      this.listSessionEntities(),
      this.subscriptionRepository.find(),
      this.userRepository.find(),
    ]);
    const scopedClients = this.scopeClientsForActor(clients, actor);
    const scopedClientIds = new Set(scopedClients.map(client => client.id));
    const scopedSessions = this.scopeSessionsForActor(sessions, actor, scopedClientIds);
    const scopedUsers = this.scopeUsersForActor(users, actor);
    const usageOverview = await this.omegaUsageService.buildUsageOverview(scopedClients, scopedSessions);

    return scopedClients.map(client => {
      const plan = plans.find(item => item.id === client.planId) ?? null;
      const clientSessions = scopedSessions.filter(session => session.clientId === client.id);
      const subscription = subscriptions.find(item => item.clientId === client.id) ?? null;
      const usageThisMonth =
        usageOverview.perClient.find(entry => entry.clientId === client.id)?.messagesThisMonth ?? 0;
      const clientUsers = scopedUsers.filter(user => user.clientId === client.id);

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

  async getClientById(id: string, actor?: OmegaUser) {
    const client = await this.getClientEntity(id, actor);

    const [plan, subscription, sessions, usage, users, messages, contacts, contactGroups] = await Promise.all([
      client.planId ? this.planRepository.findOne({ where: { id: client.planId } }) : null,
      this.subscriptionRepository.findOne({ where: { clientId: client.id } }),
      this.getClientSessions(client.id, actor),
      this.getClientUsage(client.id, actor),
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
      staff: this.scopeUsersForActor(users, actor),
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
      activeClients: clients.filter(client => client.planId === plan.id && client.status === OmegaClientStatus.ACTIVE)
        .length,
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

  async listSessions(filters: { status?: string; clientId?: string } = {}, actor?: OmegaUser) {
    await this.syncSessions(actor);
    const clients = this.scopeClientsForActor(await this.clientRepository.find(), actor);
    const scopedClientIds = new Set(clients.map(client => client.id));
    const sessions = this.scopeSessionsForActor(await this.listSessionEntities(filters), actor, scopedClientIds);
    const clientsById = new Map(clients.map(client => [client.id, client]));

    return sessions.map(session => ({
      ...session,
      companyName: session.clientId ? (clientsById.get(session.clientId)?.companyName ?? null) : null,
    }));
  }

  async assignSession(id: string, dto: AssignOmegaSessionDto, actor: OmegaUser) {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException('WhatsApp session not found');
    }

    if (!dto.clientId) {
      throw new BadRequestException('clientId is required for assignment');
    }

    const client = await this.getClientEntity(dto.clientId, actor);
    if (actor.role === OmegaUserRole.CLIENT_ADMIN && actor.clientId !== client.id) {
      throw new ForbiddenException('Sub admin can only assign sessions inside the same workspace');
    }
    const clientSessions = await this.sessionRepository.find({ where: { clientId: client.id } });
    const isNewAssignment = session.clientId !== client.id;
    if (clientSessions.length >= client.whatsappAccountLimit && isNewAssignment) {
      if (dto.overrideLimit && actor.role !== OmegaUserRole.SUPER_ADMIN) {
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

  async unassignSession(id: string, actor?: OmegaUser) {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException('WhatsApp session not found');
    }
    this.assertSessionAccess(session, actor);

    session.clientId = null;
    session.assignedToClient = false;
    await this.sessionRepository.save(session);
    return this.decorateSession(session);
  }

  async updateReplacementFlag(id: string, replacementRequested: boolean, actor?: OmegaUser) {
    const session = await this.sessionRepository.findOne({ where: { id } });
    if (!session) {
      throw new NotFoundException('WhatsApp session not found');
    }
    this.assertSessionAccess(session, actor);
    session.replacementRequested = replacementRequested;
    await this.sessionRepository.save(session);
    return this.decorateSession(session);
  }

  async listUsers(actor?: OmegaUser) {
    const [users, clients] = await Promise.all([
      this.userRepository.find({ order: { createdAt: 'DESC' } }),
      this.clientRepository.find(),
    ]);
    const clientsById = new Map(clients.map(client => [client.id, client.companyName]));

    const scopedUsers = this.scopeUsersForActor(users, actor);
    return scopedUsers.map(user => ({
      ...user,
      companyName: user.clientId ? (clientsById.get(user.clientId) ?? null) : null,
      isOnDuty: user.isOnDuty,
    }));
  }

  async createUser(dto: CreateOmegaUserDto, actor: OmegaUser) {
    this.assertUserRoleAssignment(actor, dto.role);
    const resolvedClientId =
      actor.role === OmegaUserRole.CLIENT_ADMIN ? (actor.clientId ?? null) : (dto.clientId ?? null);
    if (resolvedClientId) {
      await this.getClientEntity(resolvedClientId, actor);
    }

    return this.userRepository.save(
      this.userRepository.create({
        fullName: dto.fullName,
        email: dto.email.toLowerCase(),
        passwordHash: this.omegaAuthService.hashPassword(dto.password),
        role: dto.role,
        status: OmegaUserStatus.ACTIVE,
        clientId: resolvedClientId,
        isOnDuty: dto.isOnDuty ?? true,
      }),
    );
  }

  async updateUser(id: string, dto: UpdateOmegaUserDto, actor: OmegaUser) {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    this.assertManageableUser(actor, user);

    if (dto.role) {
      this.assertUserRoleAssignment(actor, dto.role);
    }

    const resolvedClientId =
      actor.role === OmegaUserRole.CLIENT_ADMIN
        ? (actor.clientId ?? null)
        : dto.clientId !== undefined
          ? dto.clientId
          : user.clientId;

    if (resolvedClientId) {
      await this.getClientEntity(resolvedClientId, actor);
    }

    Object.assign(user, {
      fullName: dto.fullName ?? user.fullName,
      email: dto.email ? dto.email.toLowerCase() : user.email,
      role: dto.role ?? user.role,
      status: dto.status ?? user.status,
      clientId: resolvedClientId ?? null,
      isOnDuty: dto.isOnDuty ?? user.isOnDuty,
    });
    if (dto.password) {
      user.passwordHash = this.omegaAuthService.hashPassword(dto.password);
    }

    await this.userRepository.save(user);
    return user;
  }

  async getClientCompanyName(clientId?: string | null) {
    if (!clientId) {
      return null;
    }

    const client = await this.clientRepository.findOne({ where: { id: clientId } });
    return client?.companyName ?? null;
  }

  async getWorkspaceForUser(user: OmegaUser) {
    const companyName = await this.getClientCompanyName(user.clientId);

    if (!user.clientId) {
      return {
        companyName,
        sessions: [],
        chats: [],
        stats: {
          assignedSessions: 0,
          activeSessions: 0,
          totalChats: 0,
        },
      };
    }

    const sessions = await this.getClientSessions(user.clientId);
    const chatBuckets = await Promise.all(
      sessions.map(async session => {
        try {
          const chats = await this.sessionService.getChats(session.openwaSessionId);
          return chats.map(chat => ({
            ...chat,
            sessionId: session.id,
            sessionName: session.openwaSessionName ?? session.openwaSessionId,
            phoneNumber: session.phoneNumber ?? null,
          }));
        } catch {
          return [];
        }
      }),
    );

    const chats = chatBuckets
      .flat()
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
      .slice(0, 20);

    return {
      companyName,
      sessions,
      chats,
      stats: {
        assignedSessions: sessions.length,
        activeSessions: sessions.filter(session => session.status === OmegaSessionStatus.CONNECTED).length,
        totalChats: chats.length,
      },
    };
  }

  async getWorkspaceMessages(user: OmegaUser, workspaceSessionId: string, chatId: string, limit = 100) {
    const session = await this.getWorkspaceSessionForUser(user, workspaceSessionId);
    return this.messageService.getMessages(session.openwaSessionId, { chatId, limit });
  }

  async markWorkspaceChatRead(user: OmegaUser, workspaceSessionId: string, chatId: string) {
    const session = await this.getWorkspaceSessionForUser(user, workspaceSessionId);
    return this.sessionService.sendSeen(session.openwaSessionId, chatId);
  }

  async sendWorkspaceText(user: OmegaUser, workspaceSessionId: string, chatId: string, text: string) {
    const session = await this.getWorkspaceSessionForUser(user, workspaceSessionId);
    return this.messageService.sendText(session.openwaSessionId, { chatId, text });
  }

  async getUsageOverview(actor?: OmegaUser) {
    const [clients, sessions, manualUsage] = await Promise.all([
      this.clientRepository.find(),
      this.listSessionEntities(),
      this.usageRepository.find({ order: { createdAt: 'DESC' } }),
    ]);
    const scopedClients = this.scopeClientsForActor(clients, actor);
    const scopedClientIds = new Set(scopedClients.map(client => client.id));
    const scopedSessions = this.scopeSessionsForActor(sessions, actor, scopedClientIds);
    const scopedManualUsage = this.scopeRecordsByClientId(manualUsage, scopedClientIds);
    const usage = await this.omegaUsageService.buildUsageOverview(scopedClients, scopedSessions);

    return {
      currentMonth: usage.currentMonth,
      fallbackUsed: usage.fallbackUsed,
      totals: {
        messagesToday: usage.totals.messagesToday,
        messagesThisMonth: usage.totals.messagesThisMonth,
        reconnections: scopedManualUsage
          .filter(
            entry => entry.periodMonth === usage.currentMonth && entry.metricType === OmegaUsageMetricType.RECONNECT,
          )
          .reduce((sum, entry) => sum + entry.units, 0),
      },
      perClient: usage.perClient.map(client => ({
        ...client,
        sessionCount: scopedSessions.filter(session => session.clientId === client.clientId).length,
      })),
      trend: usage.trend.map(point => ({ ...point, reconnects: 0 })),
      bySession: usage.bySession,
      byCampaign: usage.byCampaign,
    };
  }

  async getClientUsage(clientId: string, actor?: OmegaUser) {
    const client = await this.getClientEntity(clientId, actor);
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
      brandName: 'Aurora WA API',
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
        superAdminEmail: this.configService.get<string>('omega.defaultAdminEmail', 'admin@aurorawa.local'),
        supportAdminEmail: this.configService.get<string>('omega.defaultSupportEmail', 'support@aurorawa.local'),
      },
    };
  }

  async syncSessions(actor?: OmegaUser) {
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
    const clients = this.scopeClientsForActor(await this.clientRepository.find(), actor);
    const scopedClientIds = new Set(clients.map(client => client.id));
    const scopedSessions = this.scopeSessionsForActor(sessions, actor, scopedClientIds);
    const clientsById = new Map(clients.map(client => [client.id, client]));
    return scopedSessions.map(session => ({
      ...session,
      companyName: session.clientId ? (clientsById.get(session.clientId)?.companyName ?? null) : null,
    }));
  }

  async getClientSessions(clientId: string, actor?: OmegaUser) {
    await this.getClientEntity(clientId, actor);
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
        status: OmegaUserStatus.INACTIVE,
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

  private async getClientEntity(id: string, actor?: OmegaUser) {
    const client = await this.clientRepository.findOne({ where: { id } });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
    if (actor?.role === OmegaUserRole.CLIENT_ADMIN && actor.clientId !== client.id) {
      throw new ForbiddenException('Sub admin can only access the assigned workspace');
    }
    return client;
  }

  private async getClientSessionEntities(clientId: string) {
    return this.sessionRepository.find({ where: { clientId }, order: { createdAt: 'DESC' } });
  }

  private async listSessionEntities(filters: { status?: string; clientId?: string } = {}) {
    const sessions = await this.sessionRepository.find({ order: { createdAt: 'DESC' } });
    return sessions.filter(session => {
      if (filters.status && String(session.status) !== filters.status) return false;
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

  private async getWorkspaceSessionForUser(user: OmegaUser, workspaceSessionId: string) {
    const session = await this.sessionRepository.findOne({ where: { id: workspaceSessionId } });
    if (!session) {
      throw new NotFoundException('Workspace session not found');
    }

    const canAccessAnySession = [OmegaUserRole.SUPER_ADMIN, OmegaUserRole.SUPPORT_ADMIN].includes(user.role);
    if (!canAccessAnySession && (!user.clientId || session.clientId !== user.clientId)) {
      throw new ForbiddenException('You do not have access to this workspace session');
    }

    return session;
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

  private scopeClientsForActor(clients: OmegaClient[], actor?: OmegaUser) {
    if (actor?.role !== OmegaUserRole.CLIENT_ADMIN) {
      return clients;
    }
    return clients.filter(client => client.id === actor.clientId);
  }

  private scopeUsersForActor(users: OmegaUser[], actor?: OmegaUser) {
    if (!actor) {
      return users;
    }

    if (actor.role === OmegaUserRole.SUPER_ADMIN) {
      return users;
    }

    if (actor.role === OmegaUserRole.SUPPORT_ADMIN) {
      return users.filter(user => user.role !== OmegaUserRole.SUPER_ADMIN);
    }

    if (actor.role === OmegaUserRole.CLIENT_ADMIN) {
      return users.filter(
        user =>
          user.clientId === actor.clientId &&
          user.role !== OmegaUserRole.SUPER_ADMIN &&
          user.role !== OmegaUserRole.SUPPORT_ADMIN,
      );
    }

    return [];
  }

  private scopeSessionsForActor(
    sessions: OmegaWhatsappSession[],
    actor?: OmegaUser,
    scopedClientIds?: Set<string>,
  ) {
    if (actor?.role !== OmegaUserRole.CLIENT_ADMIN) {
      return sessions;
    }

    return sessions.filter(session => {
      if (!session.clientId || !actor.clientId) {
        return false;
      }
      return scopedClientIds ? scopedClientIds.has(session.clientId) : session.clientId === actor.clientId;
    });
  }

  private scopeRecordsByClientId<T extends { clientId: string | null }>(records: T[], scopedClientIds: Set<string>) {
    return records.filter(record => !!record.clientId && scopedClientIds.has(record.clientId));
  }

  private assertUserRoleAssignment(actor: OmegaUser, targetRole: OmegaUserRole) {
    if (actor.role === OmegaUserRole.SUPER_ADMIN) {
      return;
    }

    if (actor.role === OmegaUserRole.SUPPORT_ADMIN) {
      if (targetRole === OmegaUserRole.SUPER_ADMIN) {
        throw new ForbiddenException('Admin cannot create or promote a Super Admin');
      }
      return;
    }

    if (actor.role === OmegaUserRole.CLIENT_ADMIN) {
      if (![OmegaUserRole.CLIENT_ADMIN, OmegaUserRole.CLIENT_AGENT].includes(targetRole)) {
        throw new ForbiddenException('Sub admin can only create or manage sub admin and employee roles');
      }
      return;
    }

    throw new ForbiddenException('This role cannot manage users');
  }

  private assertManageableUser(actor: OmegaUser, target: OmegaUser) {
    if (actor.role === OmegaUserRole.SUPER_ADMIN) {
      return;
    }

    if (actor.role === OmegaUserRole.SUPPORT_ADMIN) {
      if (target.role === OmegaUserRole.SUPER_ADMIN) {
        throw new ForbiddenException('Admin cannot manage Super Admin accounts');
      }
      return;
    }

    if (actor.role === OmegaUserRole.CLIENT_ADMIN) {
      if (target.clientId !== actor.clientId) {
        throw new ForbiddenException('Sub admin can only manage users in the assigned workspace');
      }
      if (![OmegaUserRole.CLIENT_ADMIN, OmegaUserRole.CLIENT_AGENT].includes(target.role)) {
        throw new ForbiddenException('Sub admin can only manage sub admin and employee roles');
      }
      return;
    }

    throw new ForbiddenException('This role cannot manage users');
  }

  private assertSessionAccess(session: OmegaWhatsappSession, actor?: OmegaUser) {
    if (actor?.role === OmegaUserRole.CLIENT_ADMIN && actor.clientId !== session.clientId) {
      throw new ForbiddenException('Sub admin can only manage sessions in the assigned workspace');
    }
  }
}
