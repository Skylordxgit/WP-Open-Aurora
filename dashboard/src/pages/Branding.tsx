import { useEffect, useMemo, useState } from 'react';
import { Globe, Image as ImageIcon, MonitorSmartphone, Palette, RotateCcw, Save, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { useBranding } from '../hooks/useBranding';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { defaultBranding, resetBrandingConfig, saveBrandingConfig, type BrandingConfig } from '../utils/branding';
import './Branding.css';

export function Branding() {
  const { t } = useTranslation();
  const toast = useToast();
  const branding = useBranding();
  const title = t('branding.title', { defaultValue: 'Branding' });
  const subtitle = t('branding.subtitle', {
    defaultValue: 'Manage the visible brand assets used by the local dashboard.',
  });
  const [draft, setDraft] = useState<BrandingConfig>(branding);

  useDocumentTitle(title);

  useEffect(() => {
    setDraft(branding);
  }, [branding]);

  const brandingAssets = useMemo(
    () => [
      {
        title: 'Dashboard logo',
        path: draft.logoSrc.startsWith('data:') ? 'Uploaded in browser storage' : draft.logoSrc,
        description: 'Used in the sidebar and login screen.',
        icon: MonitorSmartphone,
      },
      {
        title: 'Browser tab icon',
        path: draft.faviconSrc.startsWith('data:') ? 'Uploaded in browser storage' : draft.faviconSrc,
        description: 'Used as the local favicon for the dashboard.',
        icon: Globe,
      },
      {
        title: 'Repo source asset',
        path: draft.logoSrc.startsWith('data:') ? 'Embedded from saved branding settings' : draft.logoSrc,
        description: 'Shared fallback used whenever the live branding settings do not provide a newer asset.',
        icon: ImageIcon,
      },
    ],
    [draft.faviconSrc, draft.logoSrc],
  );

  const updateDraft = (key: keyof BrandingConfig, value: string) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Invalid file', 'Please upload an image file for the logo.');
      return;
    }

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Failed to read the selected file.'));
        reader.readAsDataURL(file);
      });

      setDraft(prev => ({
        ...prev,
        logoSrc: dataUrl,
        faviconSrc: dataUrl,
      }));
      event.target.value = '';
    } catch (error) {
      toast.error('Upload failed', error instanceof Error ? error.message : 'Failed to process the selected image.');
    }
  };

  const handleSave = () => {
    saveBrandingConfig(draft);
    toast.success('Branding saved', 'Your branding changes are now applied across the available dashboards in this app.');
  };

  const handleReset = () => {
    resetBrandingConfig();
    setDraft(defaultBranding);
    toast.info('Branding reset', 'All dashboards in this app have been restored to the default branding.');
  };

  return (
    <div className="branding-page">
      <PageHeader title={title} subtitle={subtitle} />

      <section className="branding-hero-card">
        <div className="branding-hero-copy">
          <div className="branding-badge">
            <Palette size={16} />
            <span>Global branding editor</span>
          </div>
          <h2>Update the dashboard brand without editing code</h2>
          <p>
            Changes saved here update the shared app branding for the admin dashboard, employee workspace, login
            screens, browser tab title, and favicon.
          </p>
        </div>
        <div className="branding-hero-preview">
          <img src={draft.logoSrc} alt="Current branding logo" className="branding-hero-logo" />
        </div>
      </section>

      <section className="branding-editor-card">
        <div className="branding-form-grid">
          <div className="branding-form-group">
            <label htmlFor="branding-app-name">Sidebar App Name</label>
            <input
              id="branding-app-name"
              type="text"
              value={draft.appName}
              onChange={event => updateDraft('appName', event.target.value)}
            />
          </div>

          <div className="branding-form-group">
            <label htmlFor="branding-app-subtitle">Sidebar Subtitle</label>
            <input
              id="branding-app-subtitle"
              type="text"
              value={draft.appSubtitle}
              onChange={event => updateDraft('appSubtitle', event.target.value)}
            />
          </div>

          <div className="branding-form-group">
            <label htmlFor="branding-login-title">Login Title</label>
            <input
              id="branding-login-title"
              type="text"
              value={draft.loginTitle}
              onChange={event => updateDraft('loginTitle', event.target.value)}
            />
          </div>

          <div className="branding-form-group">
            <label htmlFor="branding-login-subtitle">Login Subtitle</label>
            <input
              id="branding-login-subtitle"
              type="text"
              value={draft.loginSubtitle}
              onChange={event => updateDraft('loginSubtitle', event.target.value)}
            />
          </div>

          <div className="branding-form-group">
            <label htmlFor="branding-tab-title">Browser Tab Title</label>
            <input
              id="branding-tab-title"
              type="text"
              value={draft.tabTitle}
              onChange={event => updateDraft('tabTitle', event.target.value)}
            />
          </div>

          <div className="branding-form-group branding-form-group--full">
            <label htmlFor="branding-logo-upload">Logo Upload</label>
            <label className="branding-upload" htmlFor="branding-logo-upload">
              <Upload size={18} />
              <span>Choose logo image</span>
            </label>
            <input id="branding-logo-upload" type="file" accept="image/*" onChange={handleLogoUpload} hidden />
            <small>Uploading a logo also updates the browser tab icon automatically.</small>
          </div>
        </div>

        <div className="branding-actions">
          <button type="button" className="branding-button branding-button--secondary" onClick={handleReset}>
            <RotateCcw size={16} />
            Reset Default
          </button>
          <button type="button" className="branding-button branding-button--primary" onClick={handleSave}>
            <Save size={16} />
            Save Branding
          </button>
        </div>
      </section>

      <section className="branding-assets-grid">
        {brandingAssets.map(({ title: assetTitle, path, description, icon: Icon }) => (
          <article key={assetTitle} className="branding-asset-card">
            <div className="branding-asset-header">
              <Icon size={18} />
              <h3>{assetTitle}</h3>
            </div>
            <code>{path}</code>
            <p>{description}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
