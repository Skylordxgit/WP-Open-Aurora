import { IEnginePlugin, PluginContext, PluginType } from '../../../core/plugins';
import { EvolutionGoAdapter } from '../../../engine/adapters/evolution-go.adapter';
import { IWhatsAppEngine } from '../../../engine/interfaces/whatsapp-engine.interface';

interface EvolutionGoPluginConfig {
  evolutionGo?: {
    baseUrl?: string;
    apiKey?: string;
    instanceTokenSecret?: string;
    requestTimeoutMs?: number;
    healthCheckIntervalMs?: number;
    websocketReconnectBaseDelayMs?: number;
  };
}

export class EvolutionGoPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

  onLoad(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.log('Evolution Go engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    context.logger.log('Evolution Go engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('Evolution Go engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(config: Record<string, unknown>): IWhatsAppEngine {
    const engineConfig = (this.context?.config ?? {}) as EvolutionGoPluginConfig;
    const evolution = engineConfig.evolutionGo ?? {};
    return new EvolutionGoAdapter({
      sessionId: config.sessionId as string,
      proxyUrl: config.proxyUrl as string | undefined,
      proxyType: config.proxyType as 'http' | 'https' | 'socks4' | 'socks5' | undefined,
      baseUrl: evolution.baseUrl ?? '',
      apiKey: evolution.apiKey ?? '',
      instanceTokenSecret: evolution.instanceTokenSecret ?? '',
      requestTimeoutMs: evolution.requestTimeoutMs,
      healthCheckIntervalMs: evolution.healthCheckIntervalMs,
      websocketReconnectBaseDelayMs: evolution.websocketReconnectBaseDelayMs,
    });
  }

  getFeatures(): string[] {
    return [
      'multi-session',
      'qr-login',
      'pairing-code-login',
      'automatic-reconnect',
      'history-sync',
      'text-messages',
      'media-messages',
      'location-messages',
      'contact-messages',
      'message-replies',
      'message-forwarding',
      'message-reactions',
      'message-deletion',
      'read-receipts',
      'typing-indicator',
      'contact-sync',
      'group-management',
      'labels',
      'channels',
      'status-updates',
    ];
  }

  getEngineLibrary(): { name: string; version: string } {
    return { name: 'Evolution Go (whatsmeow)', version: '0.7.2' };
  }

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const evolution = ((this.context?.config ?? {}) as EvolutionGoPluginConfig).evolutionGo;
    const configured = Boolean(evolution?.baseUrl && evolution.apiKey && evolution.instanceTokenSecret);
    return Promise.resolve({
      healthy: configured,
      message: configured
        ? 'Evolution Go sidecar configuration is present'
        : 'Evolution Go requires base URL, API key, and instance token secret',
    });
  }
}

export default EvolutionGoPlugin;
