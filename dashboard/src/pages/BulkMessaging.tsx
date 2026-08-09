import { useEffect, useMemo, useState } from 'react';
import { Loader2, Megaphone, OctagonX, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  contactApi,
  messageApi,
  type BulkMessageBatchResponse,
  type BulkMessageBatchStatus,
  type BulkMessageContent,
  type SavedContactRecord,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionGroupsQuery, useSessionsQuery } from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import './BulkMessaging.css';

const messageTypes = ['text', 'image', 'video', 'audio', 'document'] as const;

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

export function BulkMessaging() {
  const { t } = useTranslation();
  useDocumentTitle(t('bulkMessaging.title'));
  const { canWrite } = useRole();
  const { data: allSessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const sessions = allSessions.filter(session => session.status === 'ready');

  const [sessionId, setSessionId] = useState('');
  const [recipientType, setRecipientType] = useState<'personal' | 'group'>('personal');
  const [recipientsInput, setRecipientsInput] = useState('');
  const [selectedSavedContactIds, setSelectedSavedContactIds] = useState<string[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [messageType, setMessageType] = useState<typeof messageTypes[number]>('text');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [delayBetweenMessages, setDelayBetweenMessages] = useState(3000);
  const [randomizeDelay, setRandomizeDelay] = useState(true);
  const [stopOnError, setStopOnError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchResponse, setBatchResponse] = useState<BulkMessageBatchResponse | null>(null);
  const [batchStatus, setBatchStatus] = useState<BulkMessageBatchStatus | null>(null);
  const [savedContacts, setSavedContacts] = useState<SavedContactRecord[]>([]);

  const { data: groups = [], isLoading: loadingGroups } = useSessionGroupsQuery(sessionId, recipientType === 'group');

  useEffect(() => {
    if (sessions.length > 0 && !sessionId) {
      setSessionId(sessions[0].id);
    }
  }, [sessions, sessionId]);

  useEffect(() => {
    if (recipientType !== 'group') {
      setSelectedGroups([]);
    }
  }, [recipientType]);

  useEffect(() => {
    if (!sessionId) {
      setSavedContacts([]);
      return;
    }

    let cancelled = false;
    contactApi
      .listSaved(sessionId)
      .then(result => {
        if (!cancelled) {
          setSavedContacts(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSavedContacts([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !batchResponse?.batchId) return;

    let cancelled = false;
    const isTerminal = (status?: string) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status ?? '');

    const poll = async () => {
      try {
        const next = await messageApi.getBatchStatus(sessionId, batchResponse.batchId);
        if (cancelled) return;
        setBatchStatus(next);
        if (!isTerminal(next.status)) {
          window.setTimeout(poll, 3000);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load batch status');
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [batchResponse?.batchId, sessionId]);

  const personalRecipients = useMemo(
    () =>
      Array.from(
        new Set(
          recipientsInput
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean),
        ),
      ),
    [recipientsInput],
  );

  const selectedSavedContacts = useMemo(
    () => savedContacts.filter(contact => selectedSavedContactIds.includes(contact.id)),
    [savedContacts, selectedSavedContactIds],
  );

  const recipientCount =
    recipientType === 'group'
      ? selectedGroups.length
      : new Set([...personalRecipients, ...selectedSavedContacts.map(contact => contact.number)]).size;
  const activeStatus = batchStatus?.status ?? batchResponse?.status ?? null;
  const batchIsActive = activeStatus === 'PENDING' || activeStatus === 'PROCESSING';

  const resolveChatIds = async () => {
    if (recipientType === 'group') {
      return selectedGroups;
    }

    if (personalRecipients.length === 0) {
      if (selectedSavedContacts.length === 0) {
        throw new Error(t('bulkMessaging.missingRecipients'));
      }
    }

    const rawRecipients = Array.from(new Set([...personalRecipients, ...selectedSavedContacts.map(contact => contact.number)]));
    const resolved = await Promise.all(
      rawRecipients.map(async recipient => {
        if (recipient.includes('@')) {
          return { input: recipient, chatId: recipient };
        }

        const lookup = await contactApi.checkNumber(sessionId, recipient.replace(/[^0-9]/g, ''));
        return { input: recipient, chatId: lookup.exists ? lookup.whatsappId : null };
      }),
    );

    const invalid = resolved.filter(item => !item.chatId).map(item => item.input);
    if (invalid.length > 0) {
      throw new Error(`${t('bulkMessaging.resolveFailed')}: ${invalid.slice(0, 5).join(', ')}`);
    }

    return resolved.map(item => item.chatId!).filter(Boolean);
  };

  const buildContent = (): BulkMessageContent => {
    if (messageType === 'text') {
      return { text: content };
    }

    if (messageType === 'image') {
      return { image: { url: mediaUrl }, caption: content || undefined };
    }

    if (messageType === 'video') {
      return { video: { url: mediaUrl }, caption: content || undefined };
    }

    if (messageType === 'audio') {
      return { audio: { url: mediaUrl } };
    }

    return { document: { url: mediaUrl, filename: content || undefined } };
  };

  const handleSubmit = async () => {
    if (!sessionId || recipientCount === 0) {
      setError(t('bulkMessaging.missingRecipients'));
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const chatIds = await resolveChatIds();
      const response = await messageApi.sendBulk(sessionId, {
        messages: chatIds.map(chatId => ({
          chatId,
          type: messageType,
          content: buildContent(),
        })),
        options: {
          delayBetweenMessages,
          randomizeDelay,
          stopOnError,
        },
      });

      setBatchResponse(response);
      setBatchStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create batch');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelBatch = async () => {
    if (!batchResponse?.batchId || !sessionId) return;

    setIsCancelling(true);
    setError(null);
    try {
      const result = await messageApi.cancelBatch(sessionId, batchResponse.batchId);
      setBatchStatus(current =>
        current
          ? { ...current, status: result.status, progress: result.progress, completedAt: new Date().toISOString() }
          : null,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel batch');
    } finally {
      setIsCancelling(false);
    }
  };

  if (loadingSessions) {
    return (
      <div className="bulk-messaging bulk-messaging--loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="bulk-messaging">
      <PageHeader
        title={t('bulkMessaging.title')}
        subtitle={t('bulkMessaging.subtitle')}
        actions={
          batchResponse?.batchId ? (
            <button className="bulk-toolbar-button" type="button" onClick={() => void messageApi.getBatchStatus(sessionId, batchResponse.batchId).then(setBatchStatus)}>
              <RefreshCw size={16} />
              <span>{t('common.refresh')}</span>
            </button>
          ) : undefined
        }
      />

      <div className="bulk-panels">
        <section className="bulk-card">
          <h2>{t('bulkMessaging.compose')}</h2>

          <div className="bulk-form-group">
            <label>{t('bulkMessaging.session')}</label>
            <select value={sessionId} onChange={event => setSessionId(event.target.value)}>
              {sessions.length === 0 && <option value="">{t('bulkMessaging.noReadySessions')}</option>}
              {sessions.map(session => (
                <option key={session.id} value={session.id}>
                  {session.name} ({session.phone || t('bulkMessaging.sessionOptionPhoneNone')})
                </option>
              ))}
            </select>
          </div>

          <div className="bulk-form-group">
            <label>{t('bulkMessaging.recipientType')}</label>
            <div className="bulk-toggle-group">
              <button type="button" className={recipientType === 'personal' ? 'active' : ''} onClick={() => setRecipientType('personal')}>
                {t('bulkMessaging.personal')}
              </button>
              <button type="button" className={recipientType === 'group' ? 'active' : ''} onClick={() => setRecipientType('group')}>
                {t('bulkMessaging.group')}
              </button>
            </div>
          </div>

          {recipientType === 'group' ? (
            <div className="bulk-form-group">
              <label>{t('bulkMessaging.groups')}</label>
              <div className="bulk-checkbox-list">
                {loadingGroups && <p className="bulk-hint">{t('bulkMessaging.loadingGroups')}</p>}
                {!loadingGroups && groups.length === 0 && <p className="bulk-hint">{t('bulkMessaging.noGroupsFound')}</p>}
                {groups.map(group => {
                  const checked = selectedGroups.includes(group.id);
                  return (
                    <label key={group.id} className="bulk-checkbox-item">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedGroups(current =>
                            checked ? current.filter(item => item !== group.id) : [...current, group.id],
                          )
                        }
                      />
                      <span>{group.name}</span>
                    </label>
                  );
                })}
              </div>
              <span className="bulk-hint">{t('bulkMessaging.groupsHint')}</span>
            </div>
          ) : (
            <>
              <div className="bulk-form-group">
                <label>{t('bulkMessaging.recipients')}</label>
                <textarea
                  rows={8}
                  value={recipientsInput}
                  onChange={event => setRecipientsInput(event.target.value)}
                  placeholder={'+15551234567\n+15557654321\n628123456789@c.us'}
                />
                <span className="bulk-hint">{t('bulkMessaging.recipientsHint')}</span>
              </div>
              <div className="bulk-form-group">
                <label>{t('contacts.savedTitle')}</label>
                <div className="bulk-checkbox-list">
                  {savedContacts.length === 0 && <p className="bulk-hint">{t('contacts.savedEmpty')}</p>}
                  {savedContacts.map(contact => {
                    const checked = selectedSavedContactIds.includes(contact.id);
                    return (
                      <label key={contact.id} className="bulk-checkbox-item">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedSavedContactIds(current =>
                              checked ? current.filter(item => item !== contact.id) : [...current, contact.id],
                            )
                          }
                        />
                        <span>{contact.name || contact.number}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          <div className="bulk-form-group">
            <label>{t('bulkMessaging.messageType')}</label>
            <div className="bulk-toggle-group bulk-toggle-group--compact">
              {messageTypes.map(type => (
                <button key={type} type="button" className={messageType === type ? 'active' : ''} onClick={() => setMessageType(type)}>
                  {t(`bulkMessaging.types.${type}`)}
                </button>
              ))}
            </div>
          </div>

          {messageType === 'text' ? (
            <div className="bulk-form-group">
              <label>{t('bulkMessaging.messageContent')}</label>
              <textarea
                rows={6}
                value={content}
                onChange={event => setContent(event.target.value)}
                placeholder={t('bulkMessaging.messagePlaceholder')}
              />
            </div>
          ) : (
            <>
              <div className="bulk-form-group">
                <label>{t('bulkMessaging.mediaUrl')}</label>
                <input value={mediaUrl} onChange={event => setMediaUrl(event.target.value)} placeholder="https://example.com/file.jpg" />
              </div>
              {messageType !== 'audio' && (
                <div className="bulk-form-group">
                  <label>{messageType === 'document' ? t('bulkMessaging.filename') : t('bulkMessaging.caption')}</label>
                  <input
                    value={content}
                    onChange={event => setContent(event.target.value)}
                    placeholder={messageType === 'document' ? t('bulkMessaging.filenamePlaceholder') : t('bulkMessaging.captionPlaceholder')}
                  />
                </div>
              )}
            </>
          )}

          <div className="bulk-options-grid">
            <div className="bulk-form-group">
              <label>{t('bulkMessaging.delayBetweenMessages')}</label>
              <input
                type="number"
                min={1000}
                max={60000}
                step={500}
                value={delayBetweenMessages}
                onChange={event => setDelayBetweenMessages(Number(event.target.value))}
              />
            </div>
            <label className="bulk-switch">
              <input type="checkbox" checked={randomizeDelay} onChange={event => setRandomizeDelay(event.target.checked)} />
              <span>{t('bulkMessaging.randomizeDelay')}</span>
            </label>
            <label className="bulk-switch">
              <input type="checkbox" checked={stopOnError} onChange={event => setStopOnError(event.target.checked)} />
              <span>{t('bulkMessaging.stopOnError')}</span>
            </label>
          </div>

          <div className="bulk-compose-footer">
            <span className="bulk-count">{t('bulkMessaging.recipientCount', { count: recipientCount })}</span>
            <button
              className="bulk-send-btn"
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canWrite || isSubmitting || !sessionId || recipientCount === 0}
            >
              {isSubmitting ? <Loader2 className="animate-spin" size={18} /> : <Megaphone size={18} />}
              <span>{isSubmitting ? t('bulkMessaging.sending') : canWrite ? t('bulkMessaging.send') : t('messageTester.viewOnly')}</span>
            </button>
          </div>

          {error && <div className="bulk-error">{error}</div>}
        </section>

        <section className="bulk-card">
          <div className="bulk-card-header">
            <h2>{t('bulkMessaging.statusTitle')}</h2>
            {batchIsActive && batchResponse?.batchId && (
              <button className="bulk-cancel-btn" type="button" onClick={() => void handleCancelBatch()} disabled={isCancelling}>
                {isCancelling ? <Loader2 className="animate-spin" size={16} /> : <OctagonX size={16} />}
                <span>{isCancelling ? t('bulkMessaging.cancelling') : t('bulkMessaging.cancel')}</span>
              </button>
            )}
          </div>

          {!batchResponse ? (
            <div className="bulk-empty">
              <p>{t('bulkMessaging.responseEmpty')}</p>
            </div>
          ) : (
            <>
              <div className="bulk-status-grid">
                <div className="bulk-status-row"><span>{t('bulkMessaging.batchId')}</span><strong>{batchResponse.batchId}</strong></div>
                <div className="bulk-status-row"><span>{t('bulkMessaging.status')}</span><strong>{batchStatus?.status ?? batchResponse.status}</strong></div>
                <div className="bulk-status-row">
                  <span>{t('bulkMessaging.progress')}</span>
                  <strong>
                    {batchStatus
                      ? `${batchStatus.progress.sent}/${batchStatus.progress.total}`
                      : `0/${batchResponse.totalMessages}`}
                  </strong>
                </div>
                <div className="bulk-status-row"><span>{t('bulkMessaging.startedAt')}</span><strong>{formatDate(batchStatus?.startedAt)}</strong></div>
                <div className="bulk-status-row"><span>{t('bulkMessaging.completedAt')}</span><strong>{formatDate(batchStatus?.completedAt)}</strong></div>
              </div>

              {batchStatus && (
                <div className="bulk-progress-chips">
                  <span className="bulk-chip success">{t('bulkMessaging.sent')}: {batchStatus.progress.sent}</span>
                  <span className="bulk-chip warning">{t('bulkMessaging.pending')}: {batchStatus.progress.pending}</span>
                  <span className="bulk-chip danger">{t('bulkMessaging.failed')}: {batchStatus.progress.failed}</span>
                  <span className="bulk-chip neutral">{t('bulkMessaging.cancelled')}: {batchStatus.progress.cancelled}</span>
                </div>
              )}

              <div className="bulk-results">
                <h3>{t('bulkMessaging.results')}</h3>
                <div className="bulk-result-list">
                  {(batchStatus?.results ?? []).slice(-8).reverse().map((result, index) => (
                    <div key={`${result.chatId}-${index}`} className="bulk-result-item">
                      <div>
                        <strong>{result.chatId}</strong>
                        <p>{result.error?.message ?? result.messageId ?? 'Sent successfully'}</p>
                      </div>
                      <span className={`bulk-result-badge bulk-result-badge--${result.status.toLowerCase()}`}>
                        {result.status}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
