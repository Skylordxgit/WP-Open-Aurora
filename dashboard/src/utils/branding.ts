export interface BrandingConfig {
  appName: string;
  appSubtitle: string;
  loginTitle: string;
  loginSubtitle: string;
  tabTitle: string;
  logoSrc: string;
  faviconSrc: string;
}

const BRANDING_STORAGE_KEY = 'openwa_branding_config';
export const BRANDING_UPDATED_EVENT = 'openwa:branding-updated';
const DEFAULT_LOGO_SRC = '/openwa_logo.png';
const LEGACY_LOGIN_TITLE = 'OpenWA Technical Dashboard';
const LEGACY_LOGIN_SUBTITLE = 'Internal API key access for session control, logs, plugins, and engine tools.';

export const defaultBranding: BrandingConfig = {
  appName: 'AuroraWA',
  appSubtitle: 'WhatsApp API',
  loginTitle: 'Login',
  loginSubtitle: '',
  tabTitle: 'AuroraWA',
  logoSrc: DEFAULT_LOGO_SRC,
  faviconSrc: DEFAULT_LOGO_SRC,
};

function isBrandingConfig(value: unknown): value is Partial<BrandingConfig> {
  return !!value && typeof value === 'object';
}

export function getBrandingConfig(): BrandingConfig {
  try {
    const raw = localStorage.getItem(BRANDING_STORAGE_KEY);
    if (!raw) return defaultBranding;
    const parsed = JSON.parse(raw) as unknown;
    if (!isBrandingConfig(parsed)) return defaultBranding;
    const config = {
      ...defaultBranding,
      ...parsed,
    };

    if (
      config.loginTitle === LEGACY_LOGIN_TITLE ||
      /technical\s+dashboard/i.test(config.loginTitle)
    ) {
      config.loginTitle = defaultBranding.loginTitle;
    }

    if (config.loginSubtitle === LEGACY_LOGIN_SUBTITLE) {
      config.loginSubtitle = defaultBranding.loginSubtitle;
    }

    return {
      ...config,
    };
  } catch {
    return defaultBranding;
  }
}

export function saveBrandingConfig(config: BrandingConfig) {
  localStorage.setItem(BRANDING_STORAGE_KEY, JSON.stringify(config));
  window.dispatchEvent(new CustomEvent(BRANDING_UPDATED_EVENT, { detail: config }));
}

export function resetBrandingConfig() {
  localStorage.removeItem(BRANDING_STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(BRANDING_UPDATED_EVENT, { detail: defaultBranding }));
}

export function applyFavicon(href: string) {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) {
    existing.href = href;
    existing.type = href.endsWith('.png') || href.startsWith('data:image/png') ? 'image/png' : 'image/x-icon';
    return;
  }

  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = href;
  link.type = href.endsWith('.png') || href.startsWith('data:image/png') ? 'image/png' : 'image/x-icon';
  document.head.appendChild(link);
}
