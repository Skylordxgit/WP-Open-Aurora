import { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useBranding } from '../hooks/useBranding';
import './Login.css';

interface ForcePasswordResetProps {
  fullName: string;
  onSubmit: (nextPassword: string) => Promise<void>;
  onLogout: () => void;
}

export function ForcePasswordReset({ fullName, onSubmit, onLogout }: ForcePasswordResetProps) {
  const branding = useBranding();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = branding.tabTitle;
  }, [branding.tabTitle]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (password.trim().length < 8) {
      setError('Please use at least 8 characters for the new password.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setIsSaving(true);
    setError('');

    try {
      await onSubmit(password);
      setPassword('');
      setConfirmPassword('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to update password');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-logo">
          <img src={branding.logoSrc} alt={branding.appName} className="logo-icon" />
          <h1 className="login-title">Change your password</h1>
          <p className="login-subtitle">
            {fullName}, this is your first login or a temporary password was set for your account. Set a new password to
            continue.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="input-group">
            <label htmlFor="new-password">New password</label>
            <div className="input-wrapper">
              <input
                id="new-password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="Enter a new password"
                className={error ? 'error' : ''}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setShowPassword(current => !current)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="confirm-password">Confirm password</label>
            <div className="input-wrapper">
              <input
                id="confirm-password"
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={event => setConfirmPassword(event.target.value)}
                placeholder="Re-enter the new password"
                className={error ? 'error' : ''}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => setShowConfirmPassword(current => !current)}
                aria-label={showConfirmPassword ? 'Hide password confirmation' : 'Show password confirmation'}
              >
                {showConfirmPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {error ? <span className="error-message">{error}</span> : null}
          </div>

          <button type="submit" className="connect-btn" disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save new password'}
          </button>
        </form>

        <button type="button" className="connect-btn" onClick={onLogout} style={{ marginTop: '0.9rem' }}>
          Sign out
        </button>
      </div>
    </div>
  );
}
