import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CacheService } from '../../common/cache';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { StatsQueryDto } from './dto/stats-query.dto';

export type StatsPeriod = 'today' | '7d' | '30d' | 'custom';

export interface TimeSeriesPoint {
  timestamp: string;
  sent: number;
  received: number;
}

export interface SessionPerformanceStats {
  sessionId: string;
  name: string;
  status: string;
  phone?: string;
  handledChats: number;
  activeChats: number;
  incoming: number;
  outgoing: number;
  failed: number;
  avgResponseMinutes: number | null;
  messagesPerDay: number;
  lastResponseAt: string | null;
  lastInboundAt: string | null;
}

export interface OverviewStats {
  sessions: {
    active: number;
    total: number;
    byStatus: Record<string, number>;
  };
  messages: {
    sent: number;
    received: number;
    failed: number;
    today: { sent: number; received: number };
    selectedPeriod: {
      period: StatsPeriod;
      sent: number;
      received: number;
      failed: number;
      total: number;
      handledChats: number;
      activeChats: number;
      avgResponseMinutes: number | null;
      respondedChats: number;
      pendingChats: number;
    };
  };
  range: {
    period: StatsPeriod;
    startDate: string;
    endDate: string;
    days: number;
  };
  activitySeries: Array<{
    label: string;
    sent: number;
    received: number;
    handledChats: number;
  }>;
  sessionPerformance: SessionPerformanceStats[];
}

export interface MessageStats {
  timeSeries: TimeSeriesPoint[];
  byType: Record<string, number>;
  bySession: Array<{ sessionId: string; name: string; sent: number; received: number }>;
  topChats: Array<{ chatId: string; messageCount: number }>;
  range: {
    period: StatsPeriod;
    startDate: string;
    endDate: string;
    days: number;
  };
}

export interface SessionStats {
  session: { id: string; name: string; status: string };
  messages: { sent: number; received: number; today: number; failed: number };
  topChats: Array<{ chatId: string; count: number; lastActive: string }>;
  hourlyActivity: Array<{ hour: number; sent: number; received: number }>;
  avgResponseMinutes: number | null;
  handledChats: number;
  activeChats: number;
}

interface NormalizedRange {
  period: StatsPeriod;
  start: Date;
  end: Date;
  days: number;
}

interface SessionAccumulator {
  sessionId: string;
  name: string;
  status: string;
  phone?: string;
  incoming: number;
  outgoing: number;
  failed: number;
  handledChatIds: Set<string>;
  activeChatIds: Set<string>;
  responseTimes: number[];
  lastResponseAt: Date | null;
  lastInboundAt: Date | null;
}

interface PeriodAnalytics {
  byType: Record<string, number>;
  bySession: SessionPerformanceStats[];
  topChats: Array<{ chatId: string; messageCount: number }>;
  timeSeries: TimeSeriesPoint[];
  activitySeries: Array<{
    label: string;
    sent: number;
    received: number;
    handledChats: number;
  }>;
  totals: {
    sent: number;
    received: number;
    failed: number;
    total: number;
    handledChats: number;
    activeChats: number;
    avgResponseMinutes: number | null;
    respondedChats: number;
    pendingChats: number;
  };
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(Session, 'data')
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(Message, 'data')
    private readonly messageRepo: Repository<Message>,
    private readonly cacheService: CacheService,
  ) {}

  async getOverview(query?: StatsQueryDto): Promise<OverviewStats> {
    const range = this.normalizeRange(query);
    const [sessions, periodMessages, overallDirectionCounts, todayDirectionCounts, failed] = await Promise.all([
      this.sessionRepo.find(),
      this.findMessagesInRange(range.start, range.end),
      this.messageRepo
        .createQueryBuilder('m')
        .select('m.direction', 'direction')
        .addSelect('COUNT(*)', 'count')
        .groupBy('m.direction')
        .getRawMany<{ direction: string; count: string }>(),
      this.messageRepo
        .createQueryBuilder('m')
        .select('m.direction', 'direction')
        .addSelect('COUNT(*)', 'count')
        .where('m.createdAt >= :todayStart', { todayStart: this.startOfDay(new Date()) })
        .groupBy('m.direction')
        .getRawMany<{ direction: string; count: string }>(),
      this.messageRepo.count({ where: { status: MessageStatus.FAILED } }),
    ]);

    const byStatus: Record<string, number> = {};
    let active = 0;
    for (const session of sessions) {
      byStatus[session.status] = (byStatus[session.status] || 0) + 1;
      if (session.status === SessionStatus.READY) active++;
    }

    const sent = parseInt(overallDirectionCounts.find(row => row.direction === MessageDirection.OUTGOING)?.count || '0', 10);
    const received = parseInt(overallDirectionCounts.find(row => row.direction === MessageDirection.INCOMING)?.count || '0', 10);
    const todaySent = parseInt(todayDirectionCounts.find(row => row.direction === MessageDirection.OUTGOING)?.count || '0', 10);
    const todayReceived = parseInt(todayDirectionCounts.find(row => row.direction === MessageDirection.INCOMING)?.count || '0', 10);

    const analytics = this.buildPeriodAnalytics(sessions, periodMessages, range);

    await this.cacheService.setSessionsStats({
      active,
      total: sessions.length,
      byStatus,
    });

    return {
      sessions: {
        active,
        total: sessions.length,
        byStatus,
      },
      messages: {
        sent,
        received,
        failed,
        today: { sent: todaySent, received: todayReceived },
        selectedPeriod: {
          period: range.period,
          ...analytics.totals,
        },
      },
      range: {
        period: range.period,
        startDate: range.start.toISOString(),
        endDate: range.end.toISOString(),
        days: range.days,
      },
      activitySeries: analytics.activitySeries,
      sessionPerformance: analytics.bySession,
    };
  }

  async getMessageStats(query?: StatsQueryDto): Promise<MessageStats> {
    const range = this.normalizeRange(query);
    const [sessions, periodMessages] = await Promise.all([
      this.sessionRepo.find(),
      this.findMessagesInRange(range.start, range.end),
    ]);

    const analytics = this.buildPeriodAnalytics(sessions, periodMessages, range);

    return {
      timeSeries: analytics.timeSeries,
      byType: analytics.byType,
      bySession: analytics.bySession.map(session => ({
        sessionId: session.sessionId,
        name: session.name,
        sent: session.outgoing,
        received: session.incoming,
      })),
      topChats: analytics.topChats,
      range: {
        period: range.period,
        startDate: range.start.toISOString(),
        endDate: range.end.toISOString(),
        days: range.days,
      },
    };
  }

  async getSessionStats(sessionId: string): Promise<SessionStats> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    const [sessionMessages, todayCount] = await Promise.all([
      this.messageRepo
        .createQueryBuilder('m')
        .where('m.sessionId = :sessionId', { sessionId })
        .orderBy('m.createdAt', 'ASC')
        .getMany(),
      this.messageRepo
        .createQueryBuilder('m')
        .where('m.sessionId = :sessionId', { sessionId })
        .andWhere('m.createdAt >= :todayStart', { todayStart: this.startOfDay(new Date()) })
        .getCount(),
    ]);

    const analytics = this.buildPeriodAnalytics([session], sessionMessages, {
      period: '30d',
      start: this.startOfDay(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)),
      end: new Date(),
      days: 30,
    });

    const row = analytics.bySession[0] || {
      sessionId,
      name: session.name,
      status: session.status,
      phone: session.phone || undefined,
      handledChats: 0,
      activeChats: 0,
      incoming: 0,
      outgoing: 0,
      failed: 0,
      avgResponseMinutes: null,
      messagesPerDay: 0,
      lastResponseAt: null,
      lastInboundAt: null,
    };

    return {
      session: { id: session.id, name: session.name, status: session.status },
      messages: {
        sent: row.outgoing,
        received: row.incoming,
        today: todayCount,
        failed: row.failed,
      },
      topChats: analytics.topChats.slice(0, 10).map(chat => ({
        chatId: chat.chatId,
        count: chat.messageCount,
        lastActive:
          sessionMessages
            .filter(message => message.chatId === chat.chatId)
            .sort((a, b) => this.getMessageTime(b).getTime() - this.getMessageTime(a).getTime())[0]
            ?.createdAt.toISOString() || new Date().toISOString(),
      })),
      hourlyActivity: this.buildHourlyActivity(sessionMessages),
      avgResponseMinutes: row.avgResponseMinutes,
      handledChats: row.handledChats,
      activeChats: row.activeChats,
    };
  }

  private async findMessagesInRange(start: Date, end: Date): Promise<Message[]> {
    return this.messageRepo
      .createQueryBuilder('m')
      .where('m.createdAt >= :start', { start })
      .andWhere('m.createdAt <= :end', { end })
      .orderBy('m.createdAt', 'ASC')
      .getMany();
  }

  private buildPeriodAnalytics(sessions: Session[], messages: Message[], range: NormalizedRange): PeriodAnalytics {
    const sessionMap = new Map<string, SessionAccumulator>();
    const sessionNameMap = new Map(sessions.map(session => [session.id, session]));
    const chatMessageCount = new Map<string, number>();
    const chatActivity = new Map<string, { pendingIncomingAt: Date | null }>();
    const byType: Record<string, number> = {};
    const totalHandledChats = new Set<string>();
    const totalActiveChats = new Set<string>();
    const allResponseTimes: number[] = [];
    let pendingChats = 0;
    let totalSent = 0;
    let totalReceived = 0;
    let totalFailed = 0;

    const timeSeriesMap = new Map<string, { sent: number; received: number }>();
    const activityMap = new Map<string, { sent: number; received: number; handledChats: Set<string> }>();

    for (const bucket of this.buildBucketLabels(range)) {
      timeSeriesMap.set(bucket, { sent: 0, received: 0 });
      activityMap.set(bucket, { sent: 0, received: 0, handledChats: new Set<string>() });
    }

    for (const message of messages) {
      const session = sessionNameMap.get(message.sessionId);
      const accumulator =
        sessionMap.get(message.sessionId) ||
        {
          sessionId: message.sessionId,
          name: session?.name || message.sessionId,
          status: session?.status || SessionStatus.DISCONNECTED,
          phone: session?.phone || undefined,
          incoming: 0,
          outgoing: 0,
          failed: 0,
          handledChatIds: new Set<string>(),
          activeChatIds: new Set<string>(),
          responseTimes: [],
          lastResponseAt: null,
          lastInboundAt: null,
        };
      sessionMap.set(message.sessionId, accumulator);

      const occurredAt = this.getMessageTime(message);
      const timeKey = this.bucketKey(occurredAt, range);
      const timeSeries = timeSeriesMap.get(timeKey);
      const activity = activityMap.get(timeKey);
      const chatStateKey = `${message.sessionId}::${message.chatId}`;
      const chatState = chatActivity.get(chatStateKey) || { pendingIncomingAt: null };

      accumulator.activeChatIds.add(message.chatId);
      totalActiveChats.add(chatStateKey);
      byType[message.type || 'unknown'] = (byType[message.type || 'unknown'] || 0) + 1;
      chatMessageCount.set(message.chatId, (chatMessageCount.get(message.chatId) || 0) + 1);

      if (message.status === MessageStatus.FAILED) {
        accumulator.failed += 1;
        totalFailed += 1;
      }

      if (message.direction === MessageDirection.OUTGOING) {
        accumulator.outgoing += 1;
        totalSent += 1;
        accumulator.handledChatIds.add(message.chatId);
        totalHandledChats.add(chatStateKey);
        accumulator.lastResponseAt =
          !accumulator.lastResponseAt || occurredAt > accumulator.lastResponseAt ? occurredAt : accumulator.lastResponseAt;
        if (timeSeries) timeSeries.sent += 1;
        if (activity) {
          activity.sent += 1;
          activity.handledChats.add(chatStateKey);
        }

        if (chatState.pendingIncomingAt) {
          const minutes = (occurredAt.getTime() - chatState.pendingIncomingAt.getTime()) / 60000;
          if (minutes >= 0) {
            accumulator.responseTimes.push(minutes);
            allResponseTimes.push(minutes);
          }
          chatState.pendingIncomingAt = null;
        }
      } else {
        accumulator.incoming += 1;
        totalReceived += 1;
        accumulator.lastInboundAt =
          !accumulator.lastInboundAt || occurredAt > accumulator.lastInboundAt ? occurredAt : accumulator.lastInboundAt;
        if (timeSeries) timeSeries.received += 1;
        if (activity) activity.received += 1;

        if (!chatState.pendingIncomingAt) {
          chatState.pendingIncomingAt = occurredAt;
        }
      }

      chatActivity.set(chatStateKey, chatState);
    }

    for (const state of chatActivity.values()) {
      if (state.pendingIncomingAt) pendingChats += 1;
    }

    const bySession = [...sessionMap.values()]
      .map(session => ({
        sessionId: session.sessionId,
        name: session.name,
        status: session.status,
        phone: session.phone,
        handledChats: session.handledChatIds.size,
        activeChats: session.activeChatIds.size,
        incoming: session.incoming,
        outgoing: session.outgoing,
        failed: session.failed,
        avgResponseMinutes: session.responseTimes.length ? this.round(this.average(session.responseTimes)) : null,
        messagesPerDay: this.round((session.incoming + session.outgoing) / range.days),
        lastResponseAt: session.lastResponseAt?.toISOString() || null,
        lastInboundAt: session.lastInboundAt?.toISOString() || null,
      }))
      .sort((a, b) => b.handledChats - a.handledChats || b.outgoing - a.outgoing || a.name.localeCompare(b.name));

    const topChats = [...chatMessageCount.entries()]
      .map(([chatId, messageCount]) => ({ chatId, messageCount }))
      .sort((a, b) => b.messageCount - a.messageCount)
      .slice(0, 10);

    return {
      byType,
      bySession,
      topChats,
      timeSeries: [...timeSeriesMap.entries()].map(([timestamp, counts]) => ({
        timestamp,
        sent: counts.sent,
        received: counts.received,
      })),
      activitySeries: [...activityMap.entries()].map(([label, counts]) => ({
        label,
        sent: counts.sent,
        received: counts.received,
        handledChats: counts.handledChats.size,
      })),
      totals: {
        sent: totalSent,
        received: totalReceived,
        failed: totalFailed,
        total: totalSent + totalReceived,
        handledChats: totalHandledChats.size,
        activeChats: totalActiveChats.size,
        avgResponseMinutes: allResponseTimes.length ? this.round(this.average(allResponseTimes)) : null,
        respondedChats: allResponseTimes.length,
        pendingChats,
      },
    };
  }

  private normalizeRange(query?: StatsQueryDto): NormalizedRange {
    const now = new Date();
    const period = query?.period || 'today';

    if (period === 'custom' && query?.startDate && query?.endDate) {
      const start = this.startOfDay(new Date(query.startDate));
      const end = this.endOfDay(new Date(query.endDate));
      const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
      return { period, start, end, days };
    }

    if (period === '7d') {
      const start = this.startOfDay(new Date(now.getTime() - 6 * 86400000));
      return { period, start, end: now, days: 7 };
    }

    if (period === '30d') {
      const start = this.startOfDay(new Date(now.getTime() - 29 * 86400000));
      return { period, start, end: now, days: 30 };
    }

    return {
      period: 'today',
      start: this.startOfDay(now),
      end: now,
      days: 1,
    };
  }

  private buildBucketLabels(range: NormalizedRange): string[] {
    if (range.days <= 1) {
      return Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`);
    }

    const labels: string[] = [];
    const cursor = this.startOfDay(range.start);
    while (cursor <= range.end) {
      labels.push(this.formatDayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return labels;
  }

  private bucketKey(date: Date, range: NormalizedRange): string {
    return range.days <= 1 ? `${String(date.getHours()).padStart(2, '0')}:00` : this.formatDayKey(date);
  }

  private buildHourlyActivity(messages: Message[]): Array<{ hour: number; sent: number; received: number }> {
    const result = Array.from({ length: 24 }, (_, hour) => ({ hour, sent: 0, received: 0 }));
    const since = Date.now() - 24 * 60 * 60 * 1000;

    for (const message of messages) {
      const occurredAt = this.getMessageTime(message);
      if (occurredAt.getTime() < since) continue;
      const bucket = result[occurredAt.getHours()];
      if (message.direction === MessageDirection.OUTGOING) bucket.sent += 1;
      else bucket.received += 1;
    }

    return result;
  }

  private getMessageTime(message: Message): Date {
    if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp > 0) {
      return new Date(message.timestamp > 1_000_000_000_000 ? message.timestamp : message.timestamp * 1000);
    }
    return new Date(message.createdAt);
  }

  private startOfDay(date: Date): Date {
    const value = new Date(date);
    value.setHours(0, 0, 0, 0);
    return value;
  }

  private endOfDay(date: Date): Date {
    const value = new Date(date);
    value.setHours(23, 59, 59, 999);
    return value;
  }

  private formatDayKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private round(value: number): number {
    return Math.round(value * 10) / 10;
  }
}
