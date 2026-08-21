import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellRing,
  ExternalLink,
  Eye,
  GitBranchPlus,
  Pencil,
  Plus,
  RotateCcw,
  Smartphone,
  VolumeX,
  X,
} from 'lucide-react';
import { PageHeader } from '../../components/PageHeader';
import { useToast } from '../../components/Toast';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { omegaApi } from '../api';

type NotifyMode = 'team' | 'on_duty' | 'specific';
type BotNodeType = 'start' | 'assign' | 'notify' | 'auto_reply_off';
type BotView = 'list' | 'editor';
type BotTab = 'flows' | 'variables';

type CanvasNode = {
  id: string;
  type: BotNodeType;
  x: number;
  y: number;
};

type BotRule = {
  id: string;
  name: string;
  sessionId: string;
  sessionName: string;
  teamId: string;
  teamName: string;
  notifyMode: NotifyMode;
  notifyUserIds: string[];
  channel: 'whatsapp' | 'telegram';
  trigger: 'new_conversation';
  active: boolean;
  version: string;
  updatedAt: string;
  nodes: CanvasNode[];
};

type DragState = {
  id: string;
  offsetX: number;
  offsetY: number;
} | null;

const BOT_RULES_STORAGE_KEY = 'omega_bot_rules';
const NODE_WIDTH = 240;
const NODE_HEIGHT = 124;

function defaultCanvasNodes(): CanvasNode[] {
  return [
    { id: crypto.randomUUID(), type: 'start', x: 92, y: 118 },
    { id: crypto.randomUUID(), type: 'assign', x: 414, y: 174 },
    { id: crypto.randomUUID(), type: 'notify', x: 734, y: 214 },
  ];
}

function normalizeRule(rule: Partial<BotRule>): BotRule {
  return {
    id: rule.id ?? crypto.randomUUID(),
    name: rule.name ?? 'Untitled flow',
    sessionId: rule.sessionId ?? '',
    sessionName: rule.sessionName ?? '',
    teamId: rule.teamId ?? '',
    teamName: rule.teamName ?? '',
    notifyMode: rule.notifyMode ?? 'on_duty',
    notifyUserIds: rule.notifyUserIds ?? [],
    channel: rule.channel ?? 'whatsapp',
    trigger: 'new_conversation',
    active: rule.active ?? true,
    version: rule.version ?? '1.0',
    updatedAt: rule.updatedAt ?? new Date().toISOString(),
    nodes: rule.nodes?.length ? rule.nodes : defaultCanvasNodes(),
  };
}

function loadBotRules(): BotRule[] {
  try {
    const raw = localStorage.getItem(BOT_RULES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<BotRule>[];
    return parsed.map(normalizeRule);
  } catch {
    return [];
  }
}

function saveBotRules(rules: BotRule[]) {
  localStorage.setItem(BOT_RULES_STORAGE_KEY, JSON.stringify(rules));
}

function formatNotifyMode(mode: NotifyMode) {
  if (mode === 'team') return 'All team agents';
  if (mode === 'on_duty') return 'On-duty agents only';
  return 'Specific agents';
}

function nodeAccent(type: BotNodeType) {
  if (type === 'start') return 'omega-bot-node-start';
  if (type === 'assign') return 'omega-bot-node-flow';
  if (type === 'notify') return 'omega-bot-node-notify';
  return 'omega-bot-node-danger';
}

function versionAfterSave(version: string) {
  const parsed = Number.parseFloat(version);
  if (!Number.isFinite(parsed)) {
    return '1.1';
  }
  return (parsed + 0.1).toFixed(1);
}

export function OmegaBot() {
  useDocumentTitle('Bot');
  const toast = useToast();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLDivElement>(null);

  const [dragState, setDragState] = useState<DragState>(null);
  const [view, setView] = useState<BotView>('list');
  const [activeTab, setActiveTab] = useState<BotTab>('flows');
  const [rules, setRules] = useState<BotRule[]>(() => loadBotRules());
  const [activeRuleId, setActiveRuleId] = useState('');
  const [editorNodes, setEditorNodes] = useState<CanvasNode[]>(defaultCanvasNodes);
  const [form, setForm] = useState({
    name: '',
    sessionId: '',
    teamId: '',
    notifyMode: 'on_duty' as NotifyMode,
    notifyUserIds: [] as string[],
    channel: 'whatsapp' as 'whatsapp' | 'telegram',
  });

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery({
    queryKey: ['omega-bot-sessions'],
    queryFn: () => omegaApi.sessions({ status: 'connected' }),
  });
  const { data: teams = [], isLoading: teamsLoading } = useQuery({
    queryKey: ['omega-bot-teams'],
    queryFn: omegaApi.teams,
  });
  const { data: users = [] } = useQuery({
    queryKey: ['omega-bot-users'],
    queryFn: omegaApi.users,
  });

  const connectedSessions = useMemo(() => sessions.filter(session => session.status === 'connected'), [sessions]);

  const selectedSession = connectedSessions.find(session => session.id === form.sessionId) ?? null;
  const selectedTeam = teams.find(team => team.id === form.teamId) ?? null;
  const selectedWorkspaceId = selectedTeam?.clientId ?? null;
  const activeRule = rules.find(rule => rule.id === activeRuleId) ?? null;

  const teamAgents = useMemo(
    () =>
      users.filter(
        user => user.teamId === form.teamId && (user.role === 'client_agent' || user.role === 'client_admin'),
      ),
    [form.teamId, users],
  );

  const workspaceScopedSessions = useMemo(() => {
    if (!selectedWorkspaceId) {
      return connectedSessions;
    }

    return connectedSessions.filter(session => !session.clientId || session.clientId === selectedWorkspaceId);
  }, [connectedSessions, selectedWorkspaceId]);

  const workspaceScopedTeams = useMemo(() => {
    if (!selectedSession?.clientId) {
      return teams;
    }

    return teams.filter(team => team.clientId === selectedSession.clientId);
  }, [selectedSession, teams]);

  const notifyTargets = useMemo(() => {
    if (form.notifyMode === 'team') return teamAgents;
    if (form.notifyMode === 'on_duty') return teamAgents.filter(user => user.isOnDuty);
    return teamAgents.filter(user => form.notifyUserIds.includes(user.id));
  }, [form.notifyMode, form.notifyUserIds, teamAgents]);

  const assignWorkflowMutation = useMutation({
    mutationFn: async (payload: { sessionId: string; workspaceId: string }) =>
      omegaApi.assignSession(payload.sessionId, { clientId: payload.workspaceId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['omega-bot-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['omega-clients'] }),
        queryClient.invalidateQueries({ queryKey: ['omega-bot-teams'] }),
      ]);
    },
  });

  useEffect(() => {
    if (!selectedSession || !selectedTeam) {
      return;
    }

    if (selectedSession.clientId && selectedSession.clientId !== selectedTeam.clientId) {
      setForm(prev => ({ ...prev, sessionId: '', notifyUserIds: [] }));
    }
  }, [selectedSession, selectedTeam]);

  useEffect(() => {
    if (!selectedSession || !selectedTeam) {
      return;
    }

    if (selectedSession.clientId && selectedSession.clientId !== selectedTeam.clientId) {
      setForm(prev => ({ ...prev, teamId: '', notifyUserIds: [] }));
    }
  }, [selectedSession, selectedTeam]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handleMove = (event: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const nextX = Math.max(24, Math.min(event.clientX - rect.left - dragState.offsetX, rect.width - NODE_WIDTH - 24));
      const nextY = Math.max(
        24,
        Math.min(event.clientY - rect.top - dragState.offsetY, rect.height - NODE_HEIGHT - 24),
      );

      setEditorNodes(current =>
        current.map(node => (node.id === dragState.id ? { ...node, x: nextX, y: nextY } : node)),
      );
    };

    const handleUp = () => setDragState(null);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragState]);

  const openNewEditor = () => {
    setActiveRuleId('');
    setEditorNodes(defaultCanvasNodes());
    setForm({
      name: '',
      sessionId: '',
      teamId: '',
      notifyMode: 'on_duty',
      notifyUserIds: [],
      channel: 'whatsapp',
    });
    setView('editor');
    setActiveTab('flows');
  };

  const openExistingEditor = (ruleId: string) => {
    const rule = rules.find(item => item.id === ruleId);
    if (!rule) return;
    setActiveRuleId(rule.id);
    setEditorNodes(rule.nodes.length ? rule.nodes : defaultCanvasNodes());
    setForm({
      name: rule.name,
      sessionId: rule.sessionId,
      teamId: rule.teamId,
      notifyMode: rule.notifyMode,
      notifyUserIds: rule.notifyUserIds,
      channel: rule.channel,
    });
    setView('editor');
    setActiveTab('flows');
  };

  const closeEditor = () => {
    setView('list');
    setActiveRuleId('');
    setDragState(null);
  };

  const handleSaveWorkflow = async () => {
    if (!selectedSession || !selectedTeam) {
      toast.error('Missing details', 'Select a connected session and a target team first.');
      return;
    }

    try {
      await assignWorkflowMutation.mutateAsync({ sessionId: selectedSession.id, workspaceId: selectedTeam.clientId });

      const existingRule = activeRule;
      const nextRule = normalizeRule({
        id: existingRule?.id,
        name: form.name.trim() || `${selectedTeam.name} auto-assign`,
        sessionId: selectedSession.id,
        sessionName: selectedSession.openwaSessionName || selectedSession.openwaSessionId,
        teamId: selectedTeam.id,
        teamName: selectedTeam.name,
        notifyMode: form.notifyMode,
        notifyUserIds: form.notifyUserIds,
        channel: form.channel,
        active: true,
        version: existingRule ? versionAfterSave(existingRule.version) : '1.0',
        updatedAt: new Date().toISOString(),
        nodes: editorNodes,
      });

      const nextRules = existingRule
        ? rules.map(rule => (rule.id === existingRule.id ? nextRule : rule))
        : [nextRule, ...rules];

      setRules(nextRules);
      saveBotRules(nextRules);
      setActiveRuleId(nextRule.id);

      toast.success(
        existingRule ? 'Workflow updated' : 'Workflow saved',
        `Session routed to ${selectedTeam.workspaceName ?? 'workspace'} / ${selectedTeam.name}. Notify target: ${formatNotifyMode(nextRule.notifyMode)}.`,
      );

      setView('list');
    } catch (error) {
      toast.error('Workflow failed', error instanceof Error ? error.message : 'Unable to save the workflow.');
    }
  };

  const handleRemoveRule = (id: string) => {
    const nextRules = rules.filter(rule => rule.id !== id);
    setRules(nextRules);
    saveBotRules(nextRules);
    if (activeRuleId === id) {
      closeEditor();
    }
  };

  const addNode = (type: Exclude<BotNodeType, 'start'>) => {
    setEditorNodes(current => [
      ...current,
      {
        id: crypto.randomUUID(),
        type,
        x: 140 + current.length * 48,
        y: 120 + current.length * 36,
      },
    ]);
  };

  const resetCanvas = () => {
    setEditorNodes(defaultCanvasNodes());
  };

  const renderedNodes = editorNodes.map(node => {
    if (node.type === 'start') {
      return {
        ...node,
        label: selectedSession?.openwaSessionName || selectedSession?.openwaSessionId || 'Connected session',
        meta: form.channel === 'telegram' ? 'Telegram' : 'WhatsApp',
        body: 'When a new conversation arrives',
        icon: <Smartphone size={16} />,
        eyebrow: 'Start',
      };
    }
    if (node.type === 'assign') {
      return {
        ...node,
        label: 'Auto-assign team',
        meta: selectedTeam
          ? `${selectedTeam.workspaceName ?? 'Workspace'} / ${selectedTeam.name}`
          : 'Pick a team to route the chats',
        body: 'Assign incoming chats to the selected team',
        icon: <GitBranchPlus size={16} />,
        eyebrow: 'Flow',
      };
    }
    if (node.type === 'notify') {
      return {
        ...node,
        label: 'Notify agent',
        meta: formatNotifyMode(form.notifyMode),
        body: notifyTargets.length
          ? notifyTargets.map(user => user.fullName).join(', ')
          : 'Choose who should receive the assignment notification',
        icon: <BellRing size={16} />,
        eyebrow: 'Flow',
      };
    }
    return {
      ...node,
      label: 'Turn off auto-reply',
      meta: 'Optional final action',
      body: 'Stop generic replies after human takeover',
      icon: <VolumeX size={16} />,
      eyebrow: 'Flow',
    };
  });

  const orderedNodes = [...renderedNodes].sort((a, b) => a.x - b.x || a.y - b.y);
  const canvasWidth = Math.max(1200, ...editorNodes.map(node => node.x + NODE_WIDTH + 80));
  const canvasHeight = Math.max(560, ...editorNodes.map(node => node.y + NODE_HEIGHT + 80));

  return (
    <div className="omega-page">
      <PageHeader
        title="Workflow"
        subtitle="Manage published flows first, then open the whiteboard editor only when you create or edit a workflow."
      />

      {view === 'list' ? (
        <section className="omega-card omega-bot-list-shell">
          <div className="omega-bot-topbar">
            <div className="omega-bot-tabbar">
              <button
                className={`omega-bot-tab ${activeTab === 'flows' ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveTab('flows')}
              >
                Flows List
              </button>
              <button
                className={`omega-bot-tab ${activeTab === 'variables' ? 'active' : ''}`}
                type="button"
                onClick={() => setActiveTab('variables')}
              >
                Dynamic variables
              </button>
            </div>

            {activeTab === 'flows' ? (
              <div className="omega-bot-list-actions">
                <button className="omega-ghost-button" type="button">
                  Import workflow
                </button>
                <button className="omega-primary-button" type="button" onClick={openNewEditor}>
                  <Plus size={16} />
                  Add new flow
                </button>
              </div>
            ) : null}
          </div>

          {activeTab === 'flows' ? (
            <div className="omega-bot-table">
              <div className="omega-bot-table-head">
                <span>Name</span>
                <span>Published version</span>
                <span>Status</span>
                <span>Updated at</span>
                <span>Actions</span>
              </div>

              <div className="omega-bot-table-body">
                {rules.map(rule => (
                  <div key={rule.id} className="omega-bot-table-row">
                    <strong>{rule.name}</strong>
                    <span>{rule.version}</span>
                    <span>
                      <em className={`omega-bot-rule-status ${rule.active ? 'active' : ''}`}>
                        {rule.active ? 'Published' : 'Draft'}
                      </em>
                    </span>
                    <span>{new Date(rule.updatedAt).toLocaleString()}</span>
                    <div className="omega-bot-table-actions">
                      <button className="omega-ghost-icon-button" type="button" title="Preview">
                        <Eye size={16} />
                      </button>
                      <button
                        className="omega-ghost-icon-button"
                        type="button"
                        title="Edit flow"
                        onClick={() => openExistingEditor(rule.id)}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="omega-ghost-icon-button"
                        type="button"
                        title="Open in editor"
                        onClick={() => openExistingEditor(rule.id)}
                      >
                        <ExternalLink size={16} />
                      </button>
                      <button
                        className="omega-ghost-icon-button omega-danger-icon-button"
                        type="button"
                        title="Delete flow"
                        onClick={() => handleRemoveRule(rule.id)}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ))}

                {rules.length === 0 ? (
                  <p className="omega-empty">No workflows created yet. Start with Add new flow.</p>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="omega-card omega-bot-variable-card">
              <h3>Dynamic variables</h3>
              <p>Prepare reusable placeholders here later for WhatsApp and Telegram automation variables.</p>
              <div className="omega-bot-variable-grid">
                <div>
                  <strong>{'{{team_name}}'}</strong>
                  <span>Selected team name</span>
                </div>
                <div>
                  <strong>{'{{session_name}}'}</strong>
                  <span>Connected session name</span>
                </div>
                <div>
                  <strong>{'{{agent_name}}'}</strong>
                  <span>Assigned agent name</span>
                </div>
                <div>
                  <strong>{'{{channel}}'}</strong>
                  <span>Current bot channel</span>
                </div>
              </div>
            </div>
          )}
        </section>
      ) : (
        <section className="omega-card omega-bot-builder">
          <div className="omega-bot-editor-header">
            <div>
              <h2>{activeRule ? `Edit ${activeRule.name}` : 'Create new flow'}</h2>
              <p>Move blocks freely on the whiteboard, then save the workflow.</p>
            </div>
            <div className="omega-bot-editor-actions">
              <button className="omega-ghost-button" type="button" onClick={closeEditor}>
                Close editor
              </button>
              <button
                className="omega-primary-button"
                type="button"
                onClick={() => void handleSaveWorkflow()}
                disabled={assignWorkflowMutation.isPending || !form.sessionId || !form.teamId}
              >
                {assignWorkflowMutation.isPending ? 'Saving workflow...' : 'Save changes'}
              </button>
            </div>
          </div>

          <div className="omega-bot-grid">
            <label>
              <span>Workflow name</span>
              <input
                value={form.name}
                onChange={event => setForm(prev => ({ ...prev, name: event.target.value }))}
                placeholder="BDT support auto-assign"
              />
            </label>

            <label>
              <span>Channel</span>
              <select
                value={form.channel}
                onChange={event =>
                  setForm(prev => ({ ...prev, channel: event.target.value as 'whatsapp' | 'telegram' }))
                }
              >
                <option value="whatsapp">WhatsApp</option>
                <option value="telegram">Telegram</option>
              </select>
            </label>

            <label>
              <span>Connected session</span>
              <select
                value={form.sessionId}
                onChange={event => setForm(prev => ({ ...prev, sessionId: event.target.value }))}
                disabled={sessionsLoading}
              >
                <option value="">Select connected session</option>
                {workspaceScopedSessions.map(session => (
                  <option key={session.id} value={session.id}>
                    {session.openwaSessionName || session.openwaSessionId}
                    {session.companyName ? ` - ${session.companyName}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Assign to team</span>
              <select
                value={form.teamId}
                onChange={event => setForm(prev => ({ ...prev, teamId: event.target.value, notifyUserIds: [] }))}
                disabled={teamsLoading}
              >
                <option value="">Select team</option>
                {workspaceScopedTeams.map(team => (
                  <option key={team.id} value={team.id}>
                    {team.workspaceName ? `${team.workspaceName} / ${team.name}` : team.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Notify</span>
              <select
                value={form.notifyMode}
                onChange={event =>
                  setForm(prev => ({ ...prev, notifyMode: event.target.value as NotifyMode, notifyUserIds: [] }))
                }
              >
                <option value="team">All team agents</option>
                <option value="on_duty">On-duty agents only</option>
                <option value="specific">Specific agents</option>
              </select>
            </label>
          </div>

          {form.notifyMode === 'specific' ? (
            <div className="omega-bot-agent-picker">
              {teamAgents.map(agent => (
                <label key={agent.id} className="omega-bot-agent-chip">
                  <input
                    type="checkbox"
                    checked={form.notifyUserIds.includes(agent.id)}
                    onChange={event =>
                      setForm(prev => ({
                        ...prev,
                        notifyUserIds: event.target.checked
                          ? [...prev.notifyUserIds, agent.id]
                          : prev.notifyUserIds.filter(id => id !== agent.id),
                      }))
                    }
                  />
                  <span>
                    {agent.fullName} - {agent.isOnDuty ? 'On duty' : 'Off duty'}
                  </span>
                </label>
              ))}
              {teamAgents.length === 0 ? (
                <p className="omega-empty">No agents available in the selected team.</p>
              ) : null}
            </div>
          ) : null}

          <div className="omega-bot-workbench">
            <aside className="omega-bot-toolbox">
              <small>Flow</small>
              <button className="omega-bot-tool" type="button" onClick={() => addNode('assign')}>
                <GitBranchPlus size={16} />
                <span>Assign team</span>
              </button>
              <button className="omega-bot-tool" type="button" onClick={() => addNode('notify')}>
                <BellRing size={16} />
                <span>Notify agent</span>
              </button>
              <button className="omega-bot-tool" type="button" onClick={() => addNode('auto_reply_off')}>
                <VolumeX size={16} />
                <span>Turn off auto-reply</span>
              </button>
              <button className="omega-bot-tool omega-bot-tool-secondary" type="button" onClick={resetCanvas}>
                <RotateCcw size={16} />
                <span>Reset canvas</span>
              </button>
            </aside>

            <div className="omega-bot-canvas-shell">
              <div
                ref={canvasRef}
                className="omega-bot-free-canvas"
                style={{ width: canvasWidth, height: canvasHeight }}
              >
                <svg
                  className="omega-bot-links"
                  width={canvasWidth}
                  height={canvasHeight}
                  viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
                >
                  {orderedNodes.slice(0, -1).map((node, index) => {
                    const next = orderedNodes[index + 1];
                    const startX = node.x + NODE_WIDTH;
                    const startY = node.y + 58;
                    const endX = next.x;
                    const endY = next.y + 58;
                    const midX = startX + (endX - startX) / 2;
                    const path = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`;
                    return <path key={`${node.id}-${next.id}`} d={path} className="omega-bot-link-path" />;
                  })}
                </svg>

                {renderedNodes.map(node => (
                  <article
                    key={node.id}
                    className={`omega-bot-node ${nodeAccent(node.type)} ${dragState?.id === node.id ? 'dragging' : ''}`}
                    style={{ left: node.x, top: node.y }}
                  >
                    <button
                      className="omega-bot-node-handle"
                      type="button"
                      onMouseDown={event => {
                        const rect = event.currentTarget.parentElement?.getBoundingClientRect();
                        if (!rect) return;
                        setDragState({
                          id: node.id,
                          offsetX: event.clientX - rect.left,
                          offsetY: event.clientY - rect.top,
                        });
                      }}
                    >
                      <span />
                      <span />
                      <span />
                    </button>
                    <small>{node.eyebrow}</small>
                    <strong>
                      {node.icon}
                      {node.label}
                    </strong>
                    <span>{node.meta}</span>
                    <p>{node.body}</p>
                  </article>
                ))}

                <button className="omega-bot-canvas-add" type="button" onClick={() => addNode('notify')}>
                  <Plus size={18} />
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export default OmegaBot;
