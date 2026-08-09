import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { OmegaClient, OmegaWhatsappSession } from './entities';

@Injectable()
export class OmegaUsageService {
  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
  ) {}

  async buildUsageOverview(clients: OmegaClient[], omegaSessions: OmegaWhatsappSession[]) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const messages = await this.messageRepository
      .createQueryBuilder('message')
      .where('message.direction = :direction', { direction: MessageDirection.OUTGOING })
      .andWhere('message.status != :failed', { failed: MessageStatus.FAILED })
      .andWhere('message.createdAt >= :from', { from: sixMonthsAgo.toISOString() })
      .orderBy('message.createdAt', 'ASC')
      .getMany();

    return this.composeUsage(clients, omegaSessions, messages, dayStart, monthStart);
  }

  async buildClientUsage(client: OmegaClient, omegaSessions: OmegaWhatsappSession[]) {
    const sessions = omegaSessions.filter(session => session.clientId === client.id);
    const sessionIds = sessions.map(session => session.openwaSessionId);
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const query = this.messageRepository
      .createQueryBuilder('message')
      .where('message.direction = :direction', { direction: MessageDirection.OUTGOING })
      .andWhere('message.status != :failed', { failed: MessageStatus.FAILED })
      .andWhere('message.createdAt >= :from', { from: sixMonthsAgo.toISOString() });

    if (sessionIds.length === 0) {
      return this.composeClientUsage(client, sessions, [], dayStart, monthStart);
    }

    const messages = await query.andWhere('message.sessionId IN (:...sessionIds)', { sessionIds }).getMany();
    return this.composeClientUsage(client, sessions, messages, dayStart, monthStart);
  }

  private composeUsage(
    clients: OmegaClient[],
    omegaSessions: OmegaWhatsappSession[],
    messages: Message[],
    dayStart: Date,
    monthStart: Date,
  ) {
    const months = this.lastSixMonths();
    const sessionsByOpenwaId = new Map(omegaSessions.map(session => [session.openwaSessionId, session]));

    const totals = {
      today: 0,
      month: 0,
    };

    const monthlyMap = new Map<string, number>();
    const perClientMap = new Map<string, { today: number; month: number; bySession: Map<string, number> }>();

    for (const month of months) {
      monthlyMap.set(month, 0);
    }

    for (const message of messages) {
      const createdAt = new Date(message.createdAt);
      const monthKey = this.monthKey(createdAt);
      monthlyMap.set(monthKey, (monthlyMap.get(monthKey) ?? 0) + 1);

      if (createdAt >= dayStart) {
        totals.today += 1;
      }
      if (createdAt >= monthStart) {
        totals.month += 1;
      }

      const omegaSession = sessionsByOpenwaId.get(message.sessionId);
      if (!omegaSession?.clientId) continue;

      const entry = perClientMap.get(omegaSession.clientId) ?? { today: 0, month: 0, bySession: new Map<string, number>() };
      if (createdAt >= dayStart) {
        entry.today += 1;
      }
      if (createdAt >= monthStart) {
        entry.month += 1;
      }
      entry.bySession.set(omegaSession.id, (entry.bySession.get(omegaSession.id) ?? 0) + 1);
      perClientMap.set(omegaSession.clientId, entry);
    }

    return {
      fallbackUsed: false,
      currentMonth: this.monthKey(monthStart),
      totals: {
        messagesToday: totals.today,
        messagesThisMonth: totals.month,
      },
      trend: months.map(month => ({ month, messages: monthlyMap.get(month) ?? 0 })),
      perClient: clients.map(client => {
        const entry = perClientMap.get(client.id);
        const clientSessions = omegaSessions.filter(session => session.clientId === client.id);
        return {
          clientId: client.id,
          companyName: client.companyName,
          status: client.status,
          messagesToday: entry?.today ?? 0,
          messagesThisMonth: entry?.month ?? 0,
          monthlyMessageLimit: client.monthlyMessageLimit,
          sessionCount: clientSessions.length,
          whatsappAccountLimit: client.whatsappAccountLimit,
        };
      }),
      bySession: omegaSessions.map(session => ({
        sessionId: session.id,
        openwaSessionId: session.openwaSessionId,
        openwaSessionName: session.openwaSessionName,
        clientId: session.clientId,
        messagesThisMonth: messages.filter(
          message =>
            message.sessionId === session.openwaSessionId &&
            new Date(message.createdAt) >= monthStart &&
            message.direction === MessageDirection.OUTGOING &&
            message.status !== MessageStatus.FAILED,
        ).length,
      })),
      byCampaign: [],
    };
  }

  private composeClientUsage(
    client: OmegaClient,
    sessions: OmegaWhatsappSession[],
    messages: Message[],
    dayStart: Date,
    monthStart: Date,
  ) {
    const months = this.lastSixMonths();
    const trendMap = new Map<string, number>(months.map(month => [month, 0]));
    const bySession = new Map<string, number>();
    let today = 0;
    let month = 0;

    for (const message of messages) {
      const createdAt = new Date(message.createdAt);
      if (createdAt >= dayStart) today += 1;
      if (createdAt >= monthStart) month += 1;
      trendMap.set(this.monthKey(createdAt), (trendMap.get(this.monthKey(createdAt)) ?? 0) + 1);
      bySession.set(message.sessionId, (bySession.get(message.sessionId) ?? 0) + 1);
    }

    return {
      clientId: client.id,
      companyName: client.companyName,
      fallbackUsed: false,
      messagesToday: today,
      messagesThisMonth: month,
      monthlyMessageLimit: client.monthlyMessageLimit,
      whatsappAccountLimit: client.whatsappAccountLimit,
      sessionCount: sessions.length,
      trend: months.map(monthKey => ({ month: monthKey, messages: trendMap.get(monthKey) ?? 0 })),
      bySession: sessions.map(session => ({
        sessionId: session.id,
        openwaSessionId: session.openwaSessionId,
        openwaSessionName: session.openwaSessionName,
        messagesThisMonth: bySession.get(session.openwaSessionId) ?? 0,
        status: session.status,
      })),
    };
  }

  private lastSixMonths() {
    const months: string[] = [];
    const now = new Date();
    for (let index = 5; index >= 0; index -= 1) {
      months.push(this.monthKey(new Date(now.getFullYear(), now.getMonth() - index, 1)));
    }
    return months;
  }

  private monthKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
}
