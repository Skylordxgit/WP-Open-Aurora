import { validateEnv } from './env.validation';

/** Regression locks for boot-time env validation (no silent coercion). */
describe('validateEnv', () => {
  it('passes the zero-config default (sqlite, no pg vars)', () => {
    expect(() => validateEnv({ DATABASE_TYPE: 'sqlite' })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('rejects a DATABASE_TYPE typo instead of silently falling back to SQLite', () => {
    expect(() => validateEnv({ DATABASE_TYPE: 'postgre' })).toThrow(/DATABASE_TYPE/);
  });

  it('requires host/username/password when DATABASE_TYPE=postgres', () => {
    expect(() => validateEnv({ DATABASE_TYPE: 'postgres' })).toThrow(/DATABASE_PASSWORD/);
    expect(() =>
      validateEnv({ DATABASE_TYPE: 'postgres', DATABASE_HOST: 'db', DATABASE_USERNAME: 'u', DATABASE_PASSWORD: 'p' }),
    ).not.toThrow();
  });

  it('rejects a non-integer / out-of-range port', () => {
    expect(() => validateEnv({ DATABASE_PORT: 'abc' })).toThrow(/DATABASE_PORT/);
    expect(() => validateEnv({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => validateEnv({ PORT: '2785' })).not.toThrow();
  });

  it('requires explicit Evolution Go credentials when that engine is selected', () => {
    expect(() => validateEnv({ ENGINE_TYPE: 'evolution-go' })).toThrow(/EVOLUTION_GO_API_KEY/);
    expect(() =>
      validateEnv({
        ENGINE_TYPE: 'evolution-go',
        EVOLUTION_GO_BASE_URL: 'http://evolution-go:8080',
        EVOLUTION_GO_API_KEY: 'api-key',
        EVOLUTION_GO_INSTANCE_TOKEN_SECRET: 'token-secret',
      }),
    ).not.toThrow();
    expect(() => validateEnv({ ENGINE_TYPE: 'unknown' })).toThrow(/ENGINE_TYPE/);
  });
});
