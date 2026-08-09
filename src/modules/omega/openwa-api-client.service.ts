import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionService } from '../session/session.service';
import { Session, SessionStatus } from '../session/entities/session.entity';

export interface OpenwaSessionSnapshot {
  openwaSessionId: string;
  openwaSessionName: string | null;
  phoneNumber: string | null;
  status: 'connected' | 'disconnected' | 'needs_reconnect' | 'starting' | 'qr_required';
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RemoteSessionResponse {
  id: string;
  name: string;
  status: string;
  phone?: string | null;
  lastActive?: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class OpenwaApiClientService {
  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: SessionService,
  ) {}

  async listSessions(): Promise<OpenwaSessionSnapshot[]> {
    const apiKey = this.configService.get<string>('openwa.apiKey');
    if (apiKey) {
      return this.fetchSessionsOverHttp(apiKey);
    }

    const sessions = await this.sessionService.findAll();
    return sessions.map(session => this.normalizeLocalSession(session));
  }

  private async fetchSessionsOverHttp(apiKey: string): Promise<OpenwaSessionSnapshot[]> {
    const baseUrl = this.configService.get<string>('openwa.baseUrl', 'http://localhost:2785').replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/api/sessions`, {
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenWA session sync failed with status ${response.status}`);
    }

    const payload = (await response.json()) as RemoteSessionResponse[];
    return payload.map(session => ({
      openwaSessionId: session.id,
      openwaSessionName: session.name ?? null,
      phoneNumber: session.phone ?? null,
      status: this.mapStatus(session.status),
      lastSeenAt: session.lastActive ? new Date(session.lastActive) : null,
      createdAt: new Date(session.createdAt),
      updatedAt: new Date(session.updatedAt),
    }));
  }

  private normalizeLocalSession(session: Session): OpenwaSessionSnapshot {
    return {
      openwaSessionId: session.id,
      openwaSessionName: session.name ?? null,
      phoneNumber: session.phone ?? null,
      status: this.mapStatus(session.status),
      lastSeenAt: session.lastActiveAt ?? null,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  private mapStatus(status: string): OpenwaSessionSnapshot['status'] {
    switch (status) {
      case SessionStatus.READY:
      case 'ready':
        return 'connected';
      case SessionStatus.INITIALIZING:
      case SessionStatus.AUTHENTICATING:
      case 'initializing':
      case 'authenticating':
      case 'connecting':
        return 'starting';
      case SessionStatus.QR_READY:
      case 'qr_ready':
        return 'qr_required';
      case SessionStatus.FAILED:
      case 'failed':
        return 'needs_reconnect';
      case SessionStatus.CREATED:
      case 'created':
      case SessionStatus.DISCONNECTED:
      case 'disconnected':
      default:
        return 'disconnected';
    }
  }
}
