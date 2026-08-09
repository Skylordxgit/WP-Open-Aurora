import * as path from 'path';
import { resolvePluginMainPath } from './plugin-loader.service';

/** Regression lock: a plugin's manifest.main must not escape its plugin directory. */
describe('resolvePluginMainPath', () => {
  const dir = '/app/data/plugins';

  it('allows a normal entry inside the plugin directory', () => {
    expect(resolvePluginMainPath(dir, 'my-plugin', 'index.js')).toBe(path.resolve(dir, 'my-plugin', 'index.js'));
    expect(resolvePluginMainPath(dir, 'my-plugin', 'dist/main.js')).toBe(
      path.resolve(dir, 'my-plugin', 'dist/main.js'),
    );
  });

  it('rejects a path-traversal escape (../../)', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '../../etc/passwd')).toThrow(/escapes/);
  });

  it('rejects an absolute path', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '/etc/passwd')).toThrow(/escapes/);
  });

  it('rejects climbing into a sibling plugin', () => {
    expect(() => resolvePluginMainPath(dir, 'my-plugin', '../other-plugin/evil.js')).toThrow(/escapes/);
  });
});

import { PluginLoaderService } from './plugin-loader.service';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { HookManager } from '../hooks';
import { PluginStorageService } from './plugin-storage.service';
import { IPlugin, PluginManifest, PluginType } from './plugin.interfaces';

describe('PluginLoaderService.registerBuiltInPlugin config', () => {
  function makeLoader(): PluginLoaderService {
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const pluginStorage = {} as unknown as PluginStorageService;
    return new PluginLoaderService(configService, new HookManager(), pluginStorage, {} as unknown as ModuleRef);
  }
  const manifest: PluginManifest = {
    id: 'cfg-test',
    name: 'Cfg Test',
    version: '1.0.0',
    type: PluginType.ENGINE,
    main: 'index.ts',
  };
  const instance = {} as unknown as IPlugin;

  it('stores the supplied config on the plugin instance', () => {
    const loader = makeLoader();
    loader.registerBuiltInPlugin(manifest, instance, { sessionDataPath: '/d', puppeteer: { headless: false } });
    expect(loader.getPlugin('cfg-test')?.config).toEqual({ sessionDataPath: '/d', puppeteer: { headless: false } });
  });

  it('defaults to an empty config when none is supplied (back-compat)', () => {
    const loader = makeLoader();
    loader.registerBuiltInPlugin(manifest, instance);
    expect(loader.getPlugin('cfg-test')?.config).toEqual({});
  });
});
