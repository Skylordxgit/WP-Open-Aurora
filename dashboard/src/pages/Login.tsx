import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages } from 'lucide-react';
import { useBranding } from '../hooks/useBranding';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import './Login.css';

interface LoginProps {
  onLogin: (identifier: string, password: string) => Promise<void>;
}

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const branding = useBranding();
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  useEffect(() => {
    document.title = branding.tabTitle;
  }, [branding.tabTitle]);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password.trim()) {
      setError(t('common.errorGeneric', { defaultValue: 'Please fill in all required fields' }));
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      await onLogin(identifier, password);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : t('login.connectionError'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src={branding.logoSrc} alt={branding.appName} className="logo-icon" />
          <h1 className="login-title">{branding.loginTitle}</h1>
          <p className="login-subtitle">{branding.loginSubtitle}</p>
          <span className="version-info">
            {t('login.version', {
              version: __APP_VERSION__,
              date: new Date(__BUILD_TIME__).toLocaleDateString(),
            })}
          </span>
        </div>

        <div className="login-language">
          <Languages size={18} />
          <select
            value={currentLang}
            onChange={event => changeLanguage(event.target.value as SupportedLanguage)}
            aria-label={t('common.language')}
          >
            {languageOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <label htmlFor="identifier">{t('common.username', { defaultValue: 'Email' })}</label>
            <div className="input-wrapper">
              <input
                id="identifier"
                type="text"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                placeholder={t('clientPortal.emailPlaceholder', { defaultValue: 'name@company.com' })}
                className={error ? 'error' : ''}
                autoComplete="username"
              />
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="password">{t('common.password', { defaultValue: 'Password' })}</label>
            <div className="input-wrapper">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('clientPortal.passwordPlaceholder', { defaultValue: 'Enter your password' })}
                className={error ? 'error' : ''}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? t('common.hideApiKey') : t('common.showApiKey')}
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error && <span className="error-message">{error}</span>}
          </div>

          <button type="submit" className="connect-btn" disabled={isLoading}>
            {isLoading ? t('login.connecting') : t('login.connect')}
          </button>
        </form>
      </div>
    </div>
  );
}
