import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Message as StoredMessage, MessageDirection } from '../message/entities/message.entity';
import { MessageService } from '../message/message.service';
import { SessionService } from '../session/session.service';
import {
  OmegaAuthSession,
  OmegaCampaign,
  OmegaCampaignRecipient,
  OmegaCampaignStatus,
  OmegaClient,
  OmegaClientStatus,
  OmegaConversation,
  OmegaConversationEvent,
  OmegaConversationEventType,
  OmegaConversationStatus,
  OmegaContact,
  OmegaContactGroup,
  OmegaMessage,
  OmegaMessageDirection,
  OmegaMessageStatus,
  OmegaPlan,
  OmegaSessionStatus,
  OmegaSubscription,
  OmegaTeam,
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
  CreateOmegaTeamDto,
  CreateOmegaUserDto,
  UpdateOmegaClientDto,
  UpdateOmegaPlanDto,
  UpdateOmegaTeamDto,
  UpdateOmegaUserDto,
} from './dto';
import { OmegaAuthService } from './omega-auth.service';
import { OpenwaApiClientService } from './openwa-api-client.service';
import { OmegaUsageService } from './omega-usage.service';
import {
  mergeWorkspaceMessageHistory,
  normalizeLiveWorkspaceMessage,
  WorkspaceHistoryMessage,
} from './workspace-message-history';

@Injectable()
export class OmegaAdminService implements OnModuleInit {
  private static readonly WORKSPACE_HISTORY_PAGE_SIZE = 100;
  private static readonly WORKSPACE_HISTORY_MAX = 500;

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
    @InjectRepository(OmegaTeam, 'main')
    private readonly teamRepository: Repository<OmegaTeam>,
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
    @InjectRepository(OmegaConversation, 'main')
    private readonly conversationRepository: Repository<OmegaConversation>,
    @InjectRepository(OmegaConversationEvent, 'main')
    private readonly conversationEventRepository: Repository<OmegaConversationEvent>,
    @InjectRepository(StoredMessage, 'data')
    private readonly storedMessageRepository: Repository<StoredMessage>,
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
        reconnectSessions: scopedSessions.filter(session => session.status === OmegaSessionStatus.NEEDS_RECONNECT)
          .length,
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

  async getEmployeeAnalytics(
    actor: OmegaUser,
    filters: { preset?: string; startDate?: string; endDate?: string } = {},
  ) {
    const range = this.resolveAnalyticsRange(filters.preset, filters.startDate, filters.endDate);
    const [users, clients, sessions, conversations, events] = await Promise.all([
      this.userRepository.find({ order: { createdAt: 'DESC' } }),
      this.clientRepository.find(),
      this.listSessionEntities(),
      this.conversationRepository.find(),
      this.conversationEventRepository.find({
        where: {
          createdAt: Between(range.start, range.end),
        },
        order: { createdAt: 'ASC' },
      }),
    ]);

    const scopedClients = this.scopeClientsForActor(clients, actor);
    const scopedClientIds = new Set(scopedClients.map(client => client.id));
    const scopedSessions = this.scopeSessionsForActor(sessions, actor, scopedClientIds);
    const scopedSessionIds = new Set(scopedSessions.map(session => session.id));
    const scopedUsers = this.scopeUsersForActor(users, actor).filter(
      user =>
        !!user.clientId &&
        scopedClientIds.has(user.clientId) &&
        [OmegaUserRole.CLIENT_ADMIN, OmegaUserRole.CLIENT_AGENT].includes(user.role),
    );
    const scopedUserIds = new Set(scopedUsers.map(user => user.id));
    const clientsById = new Map(scopedClients.map(client => [client.id, client.companyName]));
    const scopedConversations = conversations.filter(
      conversation =>
        scopedClientIds.has(conversation.clientId) && scopedSessionIds.has(conversation.workspaceSessionId),
    );
    const scopedConversationIds = new Set(scopedConversations.map(conversation => conversation.id));
    const scopedEvents = events.filter(
      event =>
        scopedConversationIds.has(event.conversationId) &&
        (!event.userId || scopedUserIds.has(event.userId)) &&
        scopedClientIds.has(event.clientId),
    );

    const employees = scopedUsers
      .map(user => {
        const userEvents = scopedEvents.filter(event => event.userId === user.id);
        const assignedEvents = userEvents.filter(event => event.eventType === OmegaConversationEventType.ASSIGNED);
        const firstResponseEvents = userEvents.filter(
          event => event.eventType === OmegaConversationEventType.FIRST_RESPONSE,
        );
        const replyEvents = userEvents.filter(event => event.eventType === OmegaConversationEventType.REPLIED);
        const closedEvents = userEvents.filter(event => event.eventType === OmegaConversationEventType.CLOSED);
        const handledConversationIds = new Set(userEvents.map(event => event.conversationId));
        const activeConversationCount = scopedConversations.filter(
          conversation =>
            conversation.assignedUserId === user.id &&
            conversation.status === OmegaConversationStatus.OPEN &&
            (!conversation.closedAt || conversation.closedAt >= range.start),
        ).length;

        return {
          userId: user.id,
          fullName: user.fullName,
          email: user.email,
          role: user.role,
          companyName: user.clientId ? (clientsById.get(user.clientId) ?? null) : null,
          handledChats: handledConversationIds.size,
          assignedChats: assignedEvents.length,
          closedChats: closedEvents.length,
          activeChats: activeConversationCount,
          firstResponseAvgMs: this.averageResponseMs(firstResponseEvents),
          avgResponseMs: this.averageResponseMs([...firstResponseEvents, ...replyEvents]),
          repliesCount: replyEvents.length + firstResponseEvents.length,
        };
      })
      .sort((left, right) => right.handledChats - left.handledChats || left.fullName.localeCompare(right.fullName));

    return {
      range: {
        preset: range.preset,
        startDate: this.toIsoDate(range.start),
        endDate: this.toIsoDate(range.end),
      },
      summary: {
        activeEmployees: employees.filter(
          employee =>
            employee.handledChats > 0 ||
            employee.assignedChats > 0 ||
            employee.closedChats > 0 ||
            employee.activeChats > 0,
        ).length,
        handledChats: employees.reduce((sum, employee) => sum + employee.handledChats, 0),
        assignedChats: employees.reduce((sum, employee) => sum + employee.assignedChats, 0),
        closedChats: employees.reduce((sum, employee) => sum + employee.closedChats, 0),
        activeChats: employees.reduce((sum, employee) => sum + employee.activeChats, 0),
        firstResponseAvgMs: this.averageFromNumbers(
          employees.map(employee => employee.firstResponseAvgMs).filter((value): value is number => value !== null),
        ),
        avgResponseMs: this.averageFromNumbers(
          employees.map(employee => employee.avgResponseMs).filter((value): value is number => value !== null),
        ),
      },
      employees,
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

  async listTeams(actor?: OmegaUser) {
    const [teams, clients] = await Promise.all([
      this.teamRepository.find({ order: { createdAt: 'DESC' } }),
      this.clientRepository.find(),
    ]);
    const scopedClients = this.scopeClientsForActor(clients, actor);
    const scopedClientIds = new Set(scopedClients.map(client => client.id));
    const clientsById = new Map(scopedClients.map(client => [client.id, client.companyName]));

    return teams
      .filter(team => scopedClientIds.has(team.clientId))
      .map(team => ({
        ...team,
        workspaceName: clientsById.get(team.clientId) ?? null,
      }));
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

  async createTeam(dto: CreateOmegaTeamDto, actor: OmegaUser) {
    const targetClientId = actor.role === OmegaUserRole.CLIENT_ADMIN ? actor.clientId : dto.clientId;
    if (!targetClientId) {
      throw new BadRequestException('workspace is required');
    }
    const client = await this.getClientEntity(targetClientId, actor);

    const team = this.teamRepository.create({
      clientId: client.id,
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      status: dto.status ?? 'active',
    });

    return this.teamRepository.save(team);
  }

  async updateTeam(id: string, dto: UpdateOmegaTeamDto, actor: OmegaUser) {
    const team = await this.teamRepository.findOne({ where: { id } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }

    const currentClient = await this.getClientEntity(team.clientId, actor);
    const nextClient =
      dto.clientId && dto.clientId !== team.clientId ? await this.getClientEntity(dto.clientId, actor) : currentClient;

    team.clientId = nextClient.id;
    team.name = dto.name?.trim() || team.name;
    team.description = dto.description !== undefined ? dto.description.trim() || null : team.description;
    team.status = dto.status ?? team.status;

    await this.teamRepository.save(team);

    const impactedUsers = await this.userRepository.find({ where: { teamId: team.id } });
    if (impactedUsers.some(user => user.clientId !== team.clientId)) {
      await this.userRepository.save(
        impactedUsers.map(user => ({
          ...user,
          clientId: team.clientId,
        })),
      );
    }

    return {
      ...team,
      workspaceName: nextClient.companyName,
    };
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
    const [users, clients, teams] = await Promise.all([
      this.userRepository.find({ order: { createdAt: 'DESC' } }),
      this.clientRepository.find(),
      this.teamRepository.find(),
    ]);
    const clientsById = new Map(clients.map(client => [client.id, client.companyName]));
    const teamsById = new Map(teams.map(team => [team.id, team]));

    const scopedUsers = this.scopeUsersForActor(users, actor);
    return scopedUsers.map(user => ({
      ...user,
      companyName: user.clientId ? (clientsById.get(user.clientId) ?? null) : null,
      workspaceName: user.clientId ? (clientsById.get(user.clientId) ?? null) : null,
      teamName: user.teamId ? (teamsById.get(user.teamId)?.name ?? null) : null,
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
    const resolvedTeamId = await this.resolveTeamAssignment(dto.teamId, resolvedClientId, actor);

    return this.userRepository.save(
      this.userRepository.create({
        fullName: dto.fullName,
        email: dto.email.toLowerCase(),
        passwordHash: this.omegaAuthService.hashPassword(dto.password),
        role: dto.role,
        status: OmegaUserStatus.ACTIVE,
        clientId: resolvedClientId,
        teamId: resolvedTeamId,
        isOnDuty: dto.isOnDuty ?? true,
        mustChangePassword: true,
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
    const resolvedTeamId = await this.resolveTeamAssignment(
      dto.teamId !== undefined ? dto.teamId : user.teamId,
      resolvedClientId,
      actor,
    );

    Object.assign(user, {
      fullName: dto.fullName ?? user.fullName,
      email: dto.email ? dto.email.toLowerCase() : user.email,
      role: dto.role ?? user.role,
      status: dto.status ?? user.status,
      clientId: resolvedClientId ?? null,
      teamId: resolvedTeamId,
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

  async getTeamName(teamId?: string | null) {
    if (!teamId) {
      return null;
    }

    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    return team?.name ?? null;
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
          const chats = await this.sessionService.getChatsFast(session.openwaSessionId);
          await Promise.all(
            chats.map(chat =>
              this.syncConversationSnapshot(session, {
                chatId: chat.id,
                chatName: chat.name ?? null,
                isGroup: Boolean(chat.isGroup),
                timestamp: chat.timestamp,
              }),
            ),
          );
          return chats.map(chat => ({
            ...chat,
            sessionId: session.id,
            sessionName: session.openwaSessionName ?? session.openwaSessionId,
            phoneNumber: session.phoneNumber ?? null,
            status: OmegaConversationStatus.OPEN,
          }));
        } catch {
          return [];
        }
      }),
    );

    const chats = chatBuckets.flat().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

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
    await this.syncConversationSnapshot(session, { chatId });
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), OmegaAdminService.WORKSPACE_HISTORY_MAX)
      : OmegaAdminService.WORKSPACE_HISTORY_PAGE_SIZE;
    const [storedResult, liveResult] = await Promise.allSettled([
      this.loadStoredWorkspaceHistory(session.openwaSessionId, chatId, safeLimit),
      this.messageService.getChatHistory(session.openwaSessionId, chatId, safeLimit, false),
    ]);

    if (storedResult.status === 'rejected' && liveResult.status === 'rejected') {
      throw liveResult.reason;
    }

    const storedPayload =
      storedResult.status === 'fulfilled'
        ? storedResult.value
        : { messages: [] as WorkspaceHistoryMessage[], total: 0 };
    const liveMessages = liveResult.status === 'fulfilled' ? liveResult.value.map(normalizeLiveWorkspaceMessage) : [];
    const messages = mergeWorkspaceMessageHistory(liveMessages, storedPayload.messages, safeLimit);
    await this.syncConversationTimelineFromMessages(session, chatId);
    return {
      messages,
      total: Math.max(storedPayload.total, liveMessages.length, messages.length),
    };
  }

  private async loadStoredWorkspaceHistory(sessionId: string, chatId: string, limit: number) {
    const messages: WorkspaceHistoryMessage[] = [];
    let total = 0;

    for (let offset = 0; offset < limit; offset += OmegaAdminService.WORKSPACE_HISTORY_PAGE_SIZE) {
      const page = await this.messageService.getMessages(sessionId, {
        chatId,
        limit: Math.min(OmegaAdminService.WORKSPACE_HISTORY_PAGE_SIZE, limit - offset),
        offset,
      });
      messages.push(...page.messages);
      total = page.total;

      if (page.messages.length === 0 || messages.length >= total) break;
    }

    return { messages: messages.slice(0, limit), total };
  }

  async markWorkspaceChatRead(user: OmegaUser, workspaceSessionId: string, chatId: string) {
    const session = await this.getWorkspaceSessionForUser(user, workspaceSessionId);
    return this.sessionService.sendSeen(session.openwaSessionId, chatId);
  }

  async sendWorkspaceText(user: OmegaUser, workspaceSessionId: string, chatId: string, text: string) {
    const session = await this.getWorkspaceSessionForUser(user, workspaceSessionId);
    const conversation = await this.syncConversationSnapshot(session, { chatId });
    const hydratedConversation = await this.syncConversationTimelineFromMessages(session, chatId, conversation);
    const now = new Date();
    let changedConversation = hydratedConversation;

    if (changedConversation.assignedUserId !== user.id) {
      changedConversation = await this.conversationRepository.save({
        ...changedConversation,
        assignedUserId: user.id,
        assignedAt: now,
      });
      await this.recordConversationEvent(changedConversation, OmegaConversationEventType.ASSIGNED, user.id);
    }

    const hasFirstInbound = !!changedConversation.firstInboundAt;
    const hasFirstResponse = !!changedConversation.firstResponseAt;
    const shouldTrackFirstResponse = hasFirstInbound && !hasFirstResponse && !!changedConversation.firstInboundAt;
    if (shouldTrackFirstResponse && changedConversation.firstInboundAt) {
      const responseMs = Math.max(0, now.getTime() - changedConversation.firstInboundAt.getTime());
      changedConversation = await this.conversationRepository.save({
        ...changedConversation,
        firstResponseAt: now,
      });
      await this.recordConversationEvent(
        changedConversation,
        OmegaConversationEventType.FIRST_RESPONSE,
        user.id,
        responseMs,
      );
    } else if (
      changedConversation.lastInboundAt &&
      (!changedConversation.lastOutboundAt ||
        changedConversation.lastInboundAt.getTime() > changedConversation.lastOutboundAt.getTime())
    ) {
      const responseMs = Math.max(0, now.getTime() - changedConversation.lastInboundAt.getTime());
      await this.recordConversationEvent(changedConversation, OmegaConversationEventType.REPLIED, user.id, responseMs);
    }

    if (changedConversation.status === OmegaConversationStatus.CLOSED) {
      changedConversation = await this.conversationRepository.save({
        ...changedConversation,
        status: OmegaConversationStatus.OPEN,
        closedAt: null,
      });
      await this.recordConversationEvent(changedConversation, OmegaConversationEventType.REOPENED, user.id);
    }

    await this.conversationRepository.save({
      ...changedConversation,
      lastOutboundAt: now,
      lastActivityAt: now,
    });

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
        superAdminEmail: this.configService.get<string>('omega.defaultAdminEmail', 'masteradmin@auroramy.com'),
        supportAdminEmail: this.configService.get<string>('omega.defaultSupportEmail', 'superadmin@auroramy.com'),
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
        fullName: 'Admin',
        email: 'admin@auroramy.com',
        passwordHash: this.omegaAuthService.hashPassword('Abcd1234'),
        role: OmegaUserRole.SUPPORT_ADMIN,
        status: OmegaUserStatus.ACTIVE,
        clientId: null,
        teamId: null,
        mustChangePassword: false,
      }),
      this.userRepository.create({
        fullName: 'Subadmin',
        email: 'subadmin@auroramy.com',
        passwordHash: this.omegaAuthService.hashPassword('Abcd1234'),
        role: OmegaUserRole.CLIENT_ADMIN,
        status: OmegaUserStatus.ACTIVE,
        clientId: firstClient.id,
        teamId: null,
        mustChangePassword: false,
      }),
      this.userRepository.create({
        fullName: 'Employee',
        email: 'employee@auroramy.com',
        passwordHash: this.omegaAuthService.hashPassword('Abcd1234'),
        role: OmegaUserRole.CLIENT_AGENT,
        status: OmegaUserStatus.ACTIVE,
        clientId: firstClient.id,
        teamId: null,
        mustChangePassword: false,
      }),
    ]);

    const [northstarTeam] = await this.teamRepository.save([
      this.teamRepository.create({
        clientId: firstClient.id,
        name: 'Northstar Operations',
        description: 'Default Northstar team',
        status: 'active',
      }),
      this.teamRepository.create({
        clientId: secondClient.id,
        name: 'BluePeak Sales',
        description: 'Default BluePeak team',
        status: 'active',
      }),
    ]);

    const defaultSubadmin = await this.userRepository.findOne({ where: { email: 'subadmin@auroramy.com' } });
    const defaultEmployee = await this.userRepository.findOne({ where: { email: 'employee@auroramy.com' } });
    if (defaultSubadmin) {
      defaultSubadmin.teamId = northstarTeam.id;
      await this.userRepository.save(defaultSubadmin);
    }
    if (defaultEmployee) {
      defaultEmployee.teamId = northstarTeam.id;
      await this.userRepository.save(defaultEmployee);
    }

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

  private async resolveTeamAssignment(teamId: string | null | undefined, clientId: string | null, actor?: OmegaUser) {
    if (!teamId) {
      return null;
    }
    if (!clientId) {
      throw new BadRequestException('workspace must be selected before assigning a team');
    }

    const team = await this.teamRepository.findOne({ where: { id: teamId } });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    if (team.clientId !== clientId) {
      throw new BadRequestException('Selected team does not belong to the selected workspace');
    }

    await this.getClientEntity(team.clientId, actor);
    return team.id;
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

  private async syncConversationSnapshot(
    session: OmegaWhatsappSession,
    chat: { chatId: string; chatName?: string | null; isGroup?: boolean; timestamp?: number },
  ) {
    const existing = await this.conversationRepository.findOne({
      where: { workspaceSessionId: session.id, chatId: chat.chatId },
    });
    const activityAt = chat.timestamp ? new Date(chat.timestamp * 1000) : (existing?.lastActivityAt ?? null);

    if (existing) {
      return this.conversationRepository.save({
        ...existing,
        chatName: chat.chatName ?? existing.chatName,
        isGroup: chat.isGroup ?? existing.isGroup,
        lastActivityAt: activityAt,
      });
    }

    return this.conversationRepository.save(
      this.conversationRepository.create({
        clientId: session.clientId ?? '',
        workspaceSessionId: session.id,
        openwaSessionId: session.openwaSessionId,
        chatId: chat.chatId,
        chatName: chat.chatName ?? null,
        channel: 'whatsapp',
        isGroup: Boolean(chat.isGroup),
        status: OmegaConversationStatus.OPEN,
        lastActivityAt: activityAt,
      }),
    );
  }

  private async syncConversationTimelineFromMessages(
    session: OmegaWhatsappSession,
    chatId: string,
    conversation?: OmegaConversation,
  ) {
    const currentConversation =
      conversation ??
      (await this.syncConversationSnapshot(session, {
        chatId,
      }));

    const messages = await this.storedMessageRepository.find({
      where: { sessionId: session.openwaSessionId, chatId },
      order: { createdAt: 'ASC' },
    });

    if (messages.length === 0) {
      return currentConversation;
    }

    const firstInbound = messages.find(message => message.direction === MessageDirection.INCOMING);
    const lastInbound = [...messages].reverse().find(message => message.direction === MessageDirection.INCOMING);
    const lastOutbound = [...messages].reverse().find(message => message.direction === MessageDirection.OUTGOING);

    let firstResponseAt = currentConversation.firstResponseAt;
    if (!firstResponseAt && firstInbound) {
      const inboundMoment = this.resolveMessageDate(firstInbound);
      const firstOutboundAfterInbound = messages.find(
        message =>
          message.direction === MessageDirection.OUTGOING &&
          this.resolveMessageDate(message).getTime() >= inboundMoment.getTime(),
      );
      firstResponseAt = firstOutboundAfterInbound ? this.resolveMessageDate(firstOutboundAfterInbound) : null;
    }

    return this.conversationRepository.save({
      ...currentConversation,
      firstInboundAt: firstInbound ? this.resolveMessageDate(firstInbound) : currentConversation.firstInboundAt,
      firstResponseAt,
      lastInboundAt: lastInbound ? this.resolveMessageDate(lastInbound) : currentConversation.lastInboundAt,
      lastOutboundAt: lastOutbound ? this.resolveMessageDate(lastOutbound) : currentConversation.lastOutboundAt,
      lastActivityAt: this.resolveMessageDate(messages[messages.length - 1]),
      status: currentConversation.status ?? OmegaConversationStatus.OPEN,
    });
  }

  private async recordConversationEvent(
    conversation: OmegaConversation,
    eventType: OmegaConversationEventType,
    userId?: string | null,
    responseMs?: number,
  ) {
    return this.conversationEventRepository.save(
      this.conversationEventRepository.create({
        conversationId: conversation.id,
        clientId: conversation.clientId,
        userId: userId ?? null,
        workspaceSessionId: conversation.workspaceSessionId,
        openwaSessionId: conversation.openwaSessionId,
        chatId: conversation.chatId,
        eventType,
        responseMs: responseMs ?? null,
      }),
    );
  }

  private resolveMessageDate(message: StoredMessage) {
    if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
      return new Date(message.timestamp * 1000);
    }

    return message.createdAt instanceof Date ? message.createdAt : new Date(message.createdAt);
  }

  private resolveAnalyticsRange(preset?: string, startDate?: string, endDate?: string) {
    const now = new Date();
    const normalizedPreset =
      preset === 'day' || preset === 'week' || preset === 'month' || preset === 'custom' ? preset : 'week';

    if (normalizedPreset === 'custom') {
      if (!startDate || !endDate) {
        throw new BadRequestException('Custom date range requires both startDate and endDate');
      }

      const start = this.startOfDay(new Date(`${startDate}T00:00:00`));
      const end = this.endOfDay(new Date(`${endDate}T00:00:00`));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new BadRequestException('Invalid custom date range');
      }

      return {
        preset: normalizedPreset,
        start,
        end,
      };
    }

    if (normalizedPreset === 'day') {
      return {
        preset: normalizedPreset,
        start: this.startOfDay(now),
        end: this.endOfDay(now),
      };
    }

    if (normalizedPreset === 'month') {
      return {
        preset: normalizedPreset,
        start: this.startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)),
        end: this.endOfDay(now),
      };
    }

    const start = new Date(now);
    const day = start.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + mondayOffset);

    return {
      preset: normalizedPreset,
      start: this.startOfDay(start),
      end: this.endOfDay(now),
    };
  }

  private startOfDay(date: Date) {
    const value = new Date(date);
    value.setHours(0, 0, 0, 0);
    return value;
  }

  private endOfDay(date: Date) {
    const value = new Date(date);
    value.setHours(23, 59, 59, 999);
    return value;
  }

  private toIsoDate(date: Date) {
    return date.toISOString().slice(0, 10);
  }

  private averageResponseMs(events: Array<{ responseMs: number | null }>) {
    return this.averageFromNumbers(
      events
        .map(event => event.responseMs)
        .filter((value): value is number => value !== null && Number.isFinite(value)),
    );
  }

  private averageFromNumbers(values: number[]) {
    if (values.length === 0) {
      return null;
    }

    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
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

  private scopeSessionsForActor(sessions: OmegaWhatsappSession[], actor?: OmegaUser, scopedClientIds?: Set<string>) {
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
