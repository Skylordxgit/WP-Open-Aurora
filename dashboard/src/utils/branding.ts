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

export const defaultBranding: BrandingConfig = {
  appName: 'OpenWA',
  appSubtitle: 'WhatsApp API',
  loginTitle: 'OpenWA Technical Dashboard',
  loginSubtitle: 'Internal API key access for session control, logs, plugins, and engine tools.',
  tabTitle: 'OpenWA',
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
    return {
      ...defaultBranding,
      ...parsed,
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
