import { useEffect, useMemo, useState } from 'react';
import { Download, Loader2, Trash2, Upload, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery } from '../hooks/queries';
import { contactApi, type SavedContactRecord, type Session } from '../services/api';
import { contactsToCsv, parseContactsCsv } from '../utils/contactCsv';
import './Contacts.css';

type SessionContact = {
  id: string;
  name?: string;
  pushName?: string;
  number: string;
  isMyContact: boolean;
  isBlocked: boolean;
};

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function Contacts() {
  const { t } = useTranslation();
  useDocumentTitle(t('contacts.title'));

  const { data: allSessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const sessions = allSessions.filter((session: Session) => session.status === 'ready');

  const [sessionId, setSessionId] = useState('');
  const [sessionContacts, setSessionContacts] = useState<SessionContact[]>([]);
  const [savedContacts, setSavedContacts] = useState<SavedContactRecord[]>([]);
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessions.length > 0 && !sessionId) {
      setSessionId(sessions[0].id);
    }
  }, [sessions, sessionId]);

  useEffect(() => {
    if (!sessionId) return;

    let cancelled = false;
    setIsLoadingContacts(true);
    setError(null);

    contactApi
      .list(sessionId)
      .then(result => {
        if (!cancelled) {
          setSessionContacts(result);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load contacts');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingContacts(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setSavedContacts([]);
      return;
    }

    let cancelled = false;
    setIsLoadingSaved(true);
    contactApi
      .listSaved(sessionId)
      .then(result => {
        if (!cancelled) {
          setSavedContacts(result);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load saved contacts');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSaved(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const filteredSavedContacts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return savedContacts.filter(contact => {
      const matchesSearch =
        !needle ||
        contact.number.toLowerCase().includes(needle) ||
        (contact.name ?? '').toLowerCase().includes(needle);
      return matchesSearch;
    });
  }, [savedContacts, search]);

  const filteredSessionContacts = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sessionContacts.filter(contact => {
      if (!needle) return true;
      return (
        contact.number.toLowerCase().includes(needle) ||
        (contact.name ?? '').toLowerCase().includes(needle) ||
        (contact.pushName ?? '').toLowerCase().includes(needle)
      );
    });
  }, [sessionContacts, search]);

  const handleImportCsv = async (file: File | null) => {
    if (!file) return;

    setError(null);
    const text = await file.text();
    const parsed = parseContactsCsv(text);
    if (parsed.length === 0) {
      setError('No valid contacts found in CSV');
      return;
    }

    if (!sessionId) return;

    const next = await contactApi.saveBulk(
      sessionId,
      parsed.map(contact => ({
        ...contact,
        source: 'imported',
      })),
    );
    setSavedContacts(next);
  };

  const handleImportFromSession = async () => {
    if (!sessionId) return;

    const next = await contactApi.saveBulk(
      sessionId,
      sessionContacts.map(contact => ({
        name: contact.name || contact.pushName,
        number: contact.number,
        source: 'session',
      })),
    );
    setSavedContacts(next);
  };

  const handleExport = () => {
    const contacts = filteredSavedContacts;
    if (contacts.length === 0) return;
    const filename = sessionId ? `openwa-contacts-${sessionId}.csv` : 'openwa-contacts.csv';
    downloadCsv(filename, contactsToCsv(contacts));
  };

  const handleClear = () => {
    if (!sessionId) return;
    void contactApi.clearSaved(sessionId).then(() => setSavedContacts([]));
  };

  if (loadingSessions) {
    return (
      <div className="contacts-page contacts-page--loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="contacts-page">
      <PageHeader
        title={t('contacts.title')}
        subtitle={t('contacts.subtitle')}
        actions={
          <div className="contacts-toolbar">
            <button className="contacts-toolbar-button" type="button" onClick={handleImportFromSession} disabled={!sessionId || sessionContacts.length === 0}>
              <Users size={16} />
              <span>{t('contacts.importSession')}</span>
            </button>
            <label className="contacts-toolbar-button contacts-toolbar-button--label">
              <Upload size={16} />
              <span>{t('contacts.importCsv')}</span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={event => void handleImportCsv(event.target.files?.[0] ?? null)}
                hidden
              />
            </label>
            <button className="contacts-toolbar-button" type="button" onClick={handleExport} disabled={filteredSavedContacts.length === 0}>
              <Download size={16} />
              <span>{t('contacts.exportCsv')}</span>
            </button>
          </div>
        }
      />

      <div className="contacts-controls">
        <select value={sessionId} onChange={event => setSessionId(event.target.value)}>
          {sessions.length === 0 && <option value="">{t('contacts.noReadySessions')}</option>}
          {sessions.map(session => (
            <option key={session.id} value={session.id}>
              {session.name} ({session.phone || t('contacts.sessionOptionPhoneNone')})
            </option>
          ))}
        </select>
        <input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder={t('contacts.searchPlaceholder')}
        />
        <button className="contacts-clear-button" type="button" onClick={handleClear} disabled={filteredSavedContacts.length === 0}>
          <Trash2 size={16} />
          <span>{t('contacts.clearSaved')}</span>
        </button>
      </div>

      {error && <div className="contacts-error">{error}</div>}

      <div className="contacts-grid">
        <section className="contacts-card">
          <div className="contacts-card-header">
            <div>
              <h2>{t('contacts.savedTitle')}</h2>
              <p>{t('contacts.savedSubtitle')}</p>
            </div>
            <span className="contacts-count">{filteredSavedContacts.length}</span>
          </div>

          <div className="contacts-list">
            {filteredSavedContacts.length === 0 && <p className="contacts-empty">{t('contacts.savedEmpty')}</p>}
            {isLoadingSaved && <p className="contacts-empty">{t('contacts.loading')}</p>}
            {filteredSavedContacts.map(contact => (
              <div key={contact.id} className="contacts-item">
                <div>
                  <strong>{contact.name || contact.number}</strong>
                  <p>{contact.number}</p>
                </div>
                <button
                  className="contacts-delete"
                  type="button"
                  onClick={() => {
                    if (!sessionId) return;
                    void contactApi.deleteSaved(sessionId, contact.id).then(() =>
                      setSavedContacts(current => current.filter(item => item.id !== contact.id)),
                    );
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="contacts-card">
          <div className="contacts-card-header">
            <div>
              <h2>{t('contacts.sessionTitle')}</h2>
              <p>{t('contacts.sessionSubtitle')}</p>
            </div>
            <span className="contacts-count">{filteredSessionContacts.length}</span>
          </div>

          <div className="contacts-list">
            {isLoadingContacts && <p className="contacts-empty">{t('contacts.loading')}</p>}
            {!isLoadingContacts && filteredSessionContacts.length === 0 && <p className="contacts-empty">{t('contacts.sessionEmpty')}</p>}
            {filteredSessionContacts.map(contact => (
              <div key={contact.id} className="contacts-item">
                <div>
                  <strong>{contact.name || contact.pushName || contact.number}</strong>
                  <p>{contact.number}</p>
                </div>
                <span className={`contacts-badge ${contact.isBlocked ? 'danger' : 'neutral'}`}>
                  {contact.isBlocked ? t('contacts.blocked') : t('contacts.available')}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
