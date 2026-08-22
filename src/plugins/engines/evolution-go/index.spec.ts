import { EvolutionGoAdapter } from '../../../engine/adapters/evolution-go.adapter';
import { PluginType } from '../../../core/plugins';
import type { PluginContext } from '../../../core/plugins';
import { EvolutionGoPlugin } from './index';

describe('EvolutionGoPlugin', () => {
  it('creates a sidecar adapter from the isolated engine config namespace', async () => {
    const plugin = new EvolutionGoPlugin();
    await plugin.onLoad({
      config: {
        evolutionGo: {
          baseUrl: 'http://evolution-go:8080',
          apiKey: 'key',
          instanceTokenSecret: 'secret',
        },
      },
      logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    } as unknown as PluginContext);

    expect(plugin.type).toBe(PluginType.ENGINE);
    expect(plugin.createEngine({ sessionId: 'support' })).toBeInstanceOf(EvolutionGoAdapter);
    expect(plugin.getEngineLibrary()).toEqual({ name: 'Evolution Go (whatsmeow)', version: '0.7.2' });
    await expect(plugin.healthCheck()).resolves.toMatchObject({ healthy: true });
  });
});
