import { useEffect } from 'react';
import { useBranding } from './useBranding';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends the configured branding title suffix.
 */
export function useDocumentTitle(title: string) {
  const branding = useBranding();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | ${branding.tabTitle}`;

    return () => {
      document.title = previousTitle;
    };
  }, [branding.tabTitle, title]);
}
