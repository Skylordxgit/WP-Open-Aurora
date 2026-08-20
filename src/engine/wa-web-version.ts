import { createLogger } from '../common/services/logger.service';

const logger = createLogger('WebVersion');

export type WebVersionPin = {
  webVersion: string;
  webVersionCache: { type: 'remote'; remotePath: string };
};

export const WA_VERSION_REGISTRY_URL =
  'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json';

const DEFAULT_REMOTE_TEMPLATE = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';
const FAILURE_BACKOFF_MS = 60_000;
export const WEB_VERSION_SETTLE_MS = 12 * 60 * 60 * 1000;

let cachedCurrentVersion: string | undefined;
let inFlight: Promise<string | null> | null = null;
let lastFailureAt = 0;
let warnedRemoteTrust = false;

export function __resetWebVersionCache(): void {
  cachedCurrentVersion = undefined;
  inFlight = null;
  lastFailureAt = 0;
  warnedRemoteTrust = false;
}

function buildRemotePin(version: string): WebVersionPin {
  const template = process.env.WWEBJS_WEB_VERSION_REMOTE_PATH?.trim() || DEFAULT_REMOTE_TEMPLATE;
  return {
    webVersion: version,
    webVersionCache: { type: 'remote', remotePath: template.replace('{version}', version) },
  };
}

function warnRemoteTrustOnce(pin: WebVersionPin): void {
  if (warnedRemoteTrust) return;
  warnedRemoteTrust = true;
  logger.warn('WhatsApp Web is using remotely hosted pinned HTML without an integrity check', {
    action: 'web_version_remote_pin',
    webVersion: pin.webVersion,
    remotePath: pin.webVersionCache.remotePath,
    optOut: 'Set WWEBJS_WEB_VERSION=off to use the build served directly by WhatsApp.',
  });
}

type WaVersionEntry = {
  version?: unknown;
  beta?: unknown;
  released?: unknown;
  expire?: unknown;
};

/** Prefer the newest stable, unexpired build that has had time to settle. */
export function pickSettledWebVersion(versions: unknown, now: number, currentVersion: string | null): string | null {
  if (!Array.isArray(versions)) return currentVersion;

  const settledCutoff = now - WEB_VERSION_SETTLE_MS;
  let best: { version: string; released: number } | null = null;

  for (const raw of versions) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as WaVersionEntry;
    if (typeof entry.version !== 'string' || !/^\d/.test(entry.version) || entry.beta === true) continue;

    const released = typeof entry.released === 'string' ? Date.parse(entry.released) : NaN;
    if (!Number.isFinite(released) || released > settledCutoff) continue;

    const expires = typeof entry.expire === 'string' ? Date.parse(entry.expire) : NaN;
    if (Number.isFinite(expires) && expires <= now) continue;

    if (!best || best.released < released) {
      best = { version: entry.version, released };
    }
  }

  return best?.version ?? currentVersion;
}

export async function resolveCurrentWebVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  if (cachedCurrentVersion) return cachedCurrentVersion;
  if (inFlight) return inFlight;
  if (lastFailureAt && Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) return null;

  inFlight = (async (): Promise<string | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    timer.unref?.();

    try {
      const response = await fetcher(WA_VERSION_REGISTRY_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = (await response.json()) as { currentVersion?: unknown; versions?: unknown };
      const currentVersion =
        typeof body.currentVersion === 'string' && /^\d/.test(body.currentVersion) ? body.currentVersion : null;
      const resolved = pickSettledWebVersion(body.versions, Date.now(), currentVersion);

      if (resolved) {
        cachedCurrentVersion = resolved;
        return resolved;
      }

      throw new Error('registry contained no usable WhatsApp Web build');
    } catch (error) {
      lastFailureAt = Date.now();
      logger.warn('Could not resolve a settled WhatsApp Web build; falling back to native selection', {
        action: 'web_version_resolve_failed',
        registry: WA_VERSION_REGISTRY_URL,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Exact versions remain operator-controlled. Unset/auto/latest chooses a settled
 * registry build; `off` uses whatsapp-web.js native selection.
 */
export async function resolveWebVersionPin(fetcher: typeof fetch = fetch): Promise<WebVersionPin | undefined> {
  const raw = process.env.WWEBJS_WEB_VERSION?.trim();
  const normalized = raw?.toLowerCase();

  if (raw && !['off', 'latest', 'auto'].includes(normalized ?? '')) {
    const pin = buildRemotePin(raw);
    warnRemoteTrustOnce(pin);
    return pin;
  }

  if (normalized === 'off') return undefined;

  const resolved = await resolveCurrentWebVersion(fetcher);
  if (!resolved) return undefined;

  const pin = buildRemotePin(resolved);
  warnRemoteTrustOnce(pin);
  return pin;
}
