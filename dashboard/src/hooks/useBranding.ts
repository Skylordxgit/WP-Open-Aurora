import { useEffect, useState } from 'react';
import {
  applyFavicon,
  BRANDING_UPDATED_EVENT,
  defaultBranding,
  getBrandingConfig,
  type BrandingConfig,
} from '../utils/branding';

export function useBranding() {
  const [branding, setBranding] = useState<BrandingConfig>(() => {
    if (typeof window === 'undefined') return defaultBranding;
    return getBrandingConfig();
  });

  useEffect(() => {
    applyFavicon(branding.faviconSrc);
    const currentTitle = document.title?.trim();
    if (!currentTitle || currentTitle === 'OpenWA' || currentTitle === 'AuroraWA') {
      document.title = branding.tabTitle;
    }
  }, [branding.faviconSrc, branding.tabTitle]);

  useEffect(() => {
    const syncBranding = () => {
      setBranding(getBrandingConfig());
    };

    const handleCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<BrandingConfig>).detail;
      setBranding(detail ?? getBrandingConfig());
    };

    window.addEventListener('storage', syncBranding);
    window.addEventListener(BRANDING_UPDATED_EVENT, handleCustomEvent as EventListener);
    return () => {
      window.removeEventListener('storage', syncBranding);
      window.removeEventListener(BRANDING_UPDATED_EVENT, handleCustomEvent as EventListener);
    };
  }, []);

  return branding;
}
