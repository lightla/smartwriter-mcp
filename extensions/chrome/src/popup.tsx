import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Loader2,
  Plus,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
  Activity,
} from 'lucide-react';

import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { cn } from './lib/utils';
import { theme } from './theme';

interface ServerStatus {
  port: number;
  name?: string;
  wsStatus: 'connected' | 'connecting' | 'waiting';
}

interface Status {
  servers: ServerStatus[];
  connectedTabId: number | null;
  trackingActive: boolean;
}

type EditableServer = Pick<ServerStatus, 'port' | 'name'>;

const statusMeta = {
  connected: {
    label: 'Connected',
    dotClass: theme.dotConnected,
    textClass: theme.textSuccess,
    icon: Wifi,
  },
  connecting: {
    label: 'Connecting',
    dotClass: theme.dotConnecting,
    textClass: theme.textWarning,
    icon: Loader2,
  },
  waiting: {
    label: 'Waiting',
    dotClass: theme.dotWaiting,
    textClass: theme.textWarning,
    icon: WifiOff,
  },
} satisfies Record<ServerStatus['wsStatus'], {
  label: string;
  dotClass: string;
  textClass: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}>;

function mapEditableServers(servers: ServerStatus[]): EditableServer[] {
  return servers.map((server) => ({ port: server.port, name: server.name }));
}

function trimName(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function ServerStatusList({ servers }: { servers: ServerStatus[] }) {
  if (servers.length === 0) {
    return (
      <div className={cn('px-3 py-3 text-sm', theme.textMuted)}>
        No servers configured. Add one in settings.
      </div>
    );
  }

  return (
    <div className="space-y-2 px-3 py-3">
      {servers.map((server) => {
        const meta = statusMeta[server.wsStatus];
        const Icon = meta.icon;
        const label = server.name || `Port ${server.port}`;

        return (
          <div className="flex min-w-0 items-center gap-3" key={server.port}>
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', meta.dotClass)} />
            <div className="min-w-0 flex-1">
              <div className={cn('truncate text-sm font-semibold', theme.textSecondary)}>{label}</div>
              <div className={cn('mt-0.5 flex min-w-0 items-center gap-1.5 text-xs', meta.textClass)}>
                <Icon className={cn('h-3.5 w-3.5 shrink-0', server.wsStatus === 'connecting' && 'animate-spin')} />
                <span className="truncate">
                  {meta.label} · ws://localhost:{server.port}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ServerEditor({
  server,
  servers,
  onRemove,
  onUpdate,
}: {
  server: ServerStatus;
  servers: ServerStatus[];
  onRemove: (port: number) => Promise<void>;
  onUpdate: (originalPort: number, next: EditableServer) => Promise<void>;
}) {
  const [editing, setEditing] = React.useState(false);
  const [portValue, setPortValue] = React.useState(String(server.port));
  const [nameValue, setNameValue] = React.useState(server.name ?? '');
  const [focusTarget, setFocusTarget] = React.useState<'port' | 'name' | null>(null);
  const rowRef = React.useRef<HTMLDivElement>(null);
  const portRef = React.useRef<HTMLInputElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) return;
    setPortValue(String(server.port));
    setNameValue(server.name ?? '');
  }, [editing, server.name, server.port]);

  React.useEffect(() => {
    if (!editing || !focusTarget) return;
    const input = focusTarget === 'port' ? portRef.current : nameRef.current;
    input?.focus();
    setFocusTarget(null);
  }, [editing, focusTarget]);

  const startEdit = (target: 'port' | 'name') => {
    setEditing(true);
    setFocusTarget(target);
  };

  const cancelEdit = () => {
    setEditing(false);
    setPortValue(String(server.port));
    setNameValue(server.name ?? '');
    setFocusTarget(null);
  };

  const applyEdit = async () => {
    if (!editing) return;

    const nextPort = Number(portValue);
    const nextName = trimName(nameValue);

    if (!isValidPort(nextPort)) {
      cancelEdit();
      return;
    }

    const duplicate = nextPort !== server.port && servers.some((item) => item.port === nextPort);
    if (duplicate) {
      cancelEdit();
      return;
    }

    const unchanged = nextPort === server.port && (nextName ?? '') === (server.name ?? '');
    setEditing(false);

    if (!unchanged) {
      await onUpdate(server.port, { port: nextPort, name: nextName });
    }
  };

  const handleBlur = async (event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (!rowRef.current?.contains(nextTarget)) {
      await applyEdit();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div
      className="grid grid-cols-[76px_minmax(0,1fr)_2rem] items-center gap-2"
      onBlur={handleBlur}
      ref={rowRef}
      title="Click to edit"
    >
      <Input
        aria-label={`Port ${server.port}`}
        className={cn('h-8 px-2 text-xs', !editing && 'bg-[#cee1de] text-[#405551] shadow-none border-[#9eb8b3]')}
        min={1024}
        max={65535}
        onClick={() => startEdit('port')}
        onChange={(event) => setPortValue(event.target.value)}
        onKeyDown={handleKeyDown}
        readOnly={!editing}
        ref={portRef}
        tabIndex={editing ? 0 : -1}
        type="number"
        value={portValue}
      />
      <Input
        aria-label={`Name for port ${server.port}`}
        className={cn('h-8 min-w-0 px-2 text-xs', !editing && 'bg-[#cee1de] text-[#405551] shadow-none border-[#9eb8b3]')}
        onClick={() => startEdit('name')}
        onChange={(event) => setNameValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="name (optional)"
        readOnly={!editing}
        ref={nameRef}
        tabIndex={editing ? 0 : -1}
        type="text"
        value={nameValue}
      />
      <Button
        aria-label={`Remove port ${server.port}`}
        className="text-[#4f625e] hover:bg-[#ddb8b2] hover:text-[#842a27]"
        onClick={() => onRemove(server.port)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

function SettingsPanel({
  servers,
  onAdd,
  onRemove,
  onUpdate,
}: {
  servers: ServerStatus[];
  onAdd: (server: EditableServer) => Promise<boolean>;
  onRemove: (port: number) => Promise<void>;
  onUpdate: (originalPort: number, next: EditableServer) => Promise<void>;
}) {
  const [port, setPort] = React.useState('');
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [tabFlow, setTabFlow] = React.useState(false);

  React.useEffect(() => {
    chrome.storage.local.get('smartwriterTabFlow', (res) => {
      setTabFlow(!!res.smartwriterTabFlow);
    });
  }, []);

  const toggleTabFlow = (val: boolean) => {
    setTabFlow(val);
    chrome.storage.local.set({ smartwriterTabFlow: val });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const nextPort = Number(port);
    if (!isValidPort(nextPort)) {
      setError('Use a port from 1024 to 65535.');
      return;
    }

    const added = await onAdd({ port: nextPort, name: trimName(name) });
    if (!added) {
      setError(`Port ${nextPort} already exists.`);
      return;
    }

    setPort('');
    setName('');
    setError(null);
  };

  return (
    <section className={theme.section}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className={cn('text-sm font-semibold', theme.textAccent)}>MCP Servers</div>
          <div className={cn('text-xs', theme.textFaint)}>Click a row to edit.</div>
        </div>
      </div>

      {servers.length > 0 && (
        <div className="mb-3 space-y-2">
          {servers.map((server) => (
            <ServerEditor
              key={server.port}
              onRemove={onRemove}
              onUpdate={onUpdate}
              server={server}
              servers={servers}
            />
          ))}
        </div>
      )}

      <form className="grid grid-cols-[80px_minmax(0,1fr)_64px] gap-2" onSubmit={submit}>
        <Input
          aria-label="New server port"
          className="h-9 min-w-0"
          min={1024}
          max={65535}
          onChange={(event) => setPort(event.target.value)}
          placeholder="Port"
          type="number"
          value={port}
        />
        <Input
          aria-label="New server name"
          className="h-9 min-w-0"
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
          type="text"
          value={name}
        />
        <Button className="h-9 px-0" type="submit">
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </form>

      {error && <div className={cn('mt-2 text-xs', theme.textDanger)}>{error}</div>}
    </section>
  );
}

function TabControls({
  activeTab,
  currentStatus,
  currentTab,
  onConnectToggle,
  onFocusConnected,
  onTrackingToggle,
  tabFlowEnabled,
}: {
  activeTab: chrome.tabs.Tab | null;
  currentStatus: Status | null;
  currentTab: chrome.tabs.Tab | null;
  onConnectToggle: () => Promise<void>;
  onFocusConnected: () => Promise<void>;
  onTrackingToggle: () => Promise<void>;
  tabFlowEnabled: boolean;
}) {
  if (!currentStatus) {
    return (
      <section className={theme.sectionAlt}>
        <div className={cn('h-4 w-40', theme.skeleton)} />
        <div className={cn('mt-3 h-9 w-full rounded-md', theme.skeleton)} />
      </section>
    );
  }

  const isCurrentTabConnected = Boolean(currentStatus.connectedTabId && currentStatus.connectedTabId === activeTab?.id);
  const hasConnectedTab = Boolean(currentStatus.connectedTabId);

  if (tabFlowEnabled) {
    return (
      <section className={theme.sectionAlt}>
        <div className={cn('text-center text-sm font-semibold', theme.textAccent)}>
          Tab Flow Mode: ON
        </div>
        <div className={cn('mt-2 text-center text-xs', theme.textMuted)}>
          Agent is orchestrating multiple tabs.
        </div>
      </section>
    );
  }

  return (
    <section className={theme.sectionAlt}>
      <Button
        className="w-full"
        onClick={onConnectToggle}
        type="button"
        variant={isCurrentTabConnected ? 'success' : 'secondary'}
      >
        {`Connect This Tab: ${isCurrentTabConnected ? 'ON' : 'OFF'}`}
      </Button>

      {hasConnectedTab && !isCurrentTabConnected && (
        <Button className="mt-2 w-full" onClick={onFocusConnected} type="button" variant="outline">
          Focus Connected Tab
        </Button>
      )}

      {isCurrentTabConnected && (
        <>
          <Button
            className="mt-2 w-full"
            onClick={onTrackingToggle}
            type="button"
            variant={currentStatus.trackingActive ? 'success' : 'secondary'}
          >
            {`Tracking: ${currentStatus.trackingActive ? 'ON' : 'OFF'}`}
          </Button>
          {currentStatus.trackingActive && (
            <div className={cn('mt-2 text-center text-xs', theme.textMuted)}>
              Click elements on the page to capture annotations.
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PopupApp() {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [activeTab, setActiveTab] = React.useState<chrome.tabs.Tab | null>(null);
  const [currentTab, setCurrentTab] = React.useState<chrome.tabs.Tab | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [tabFlowEnabled, setTabFlowEnabled] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const [nextActiveTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const nextStatus = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as Status;
      const res = await chrome.storage.local.get('smartwriterTabFlow');
      setTabFlowEnabled(!!res.smartwriterTabFlow);

      setActiveTab(nextActiveTab ?? null);
      setStatus(nextStatus);
      setLoadError(null);

      if (nextStatus.connectedTabId) {
        const nextCurrentTab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
          chrome.tabs.get(nextStatus.connectedTabId!, (tab) => {
            resolve(chrome.runtime.lastError ? null : tab);
          });
        });
        setCurrentTab(nextCurrentTab);
      } else {
        setCurrentTab(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load extension status.';
      setLoadError(message);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const handleToggleTabFlow = async () => {
    const next = !tabFlowEnabled;
    setTabFlowEnabled(next);
    await chrome.storage.local.set({ smartwriterTabFlow: next });
    await chrome.runtime.sendMessage({ type: 'TAB_FLOW_CHANGED', enabled: next });
    await refresh();
  };

  const setServers = React.useCallback(
    async (servers: EditableServer[]) => {
      await chrome.runtime.sendMessage({ type: 'SET_SERVERS', servers });
      await refresh();
    },
    [refresh]
  );

  const addServer = React.useCallback(
    async (server: EditableServer) => {
      if (!status || status.servers.some((item) => item.port === server.port)) return false;
      await setServers([...mapEditableServers(status.servers), server]);
      return true;
    },
    [setServers, status]
  );

  const removeServer = React.useCallback(
    async (port: number) => {
      if (!status) return;
      await setServers(mapEditableServers(status.servers).filter((server) => server.port !== port));
    },
    [setServers, status]
  );

  const updateServer = React.useCallback(
    async (originalPort: number, next: EditableServer) => {
      if (!status) return;
      const nextServers = mapEditableServers(status.servers).map((server) =>
        server.port === originalPort ? next : server
      );
      await setServers(nextServers);
    },
    [setServers, status]
  );

  const handleConnectToggle = React.useCallback(async () => {
    if (!status) return;
    const nextTabId = status.connectedTabId === activeTab?.id ? null : activeTab?.id ?? null;
    await chrome.runtime.sendMessage({ type: 'CONNECT_TAB', tabId: nextTabId });
    await refresh();
  }, [activeTab?.id, refresh, status]);

  const handleFocusConnected = React.useCallback(async () => {
    if (!status?.connectedTabId) return;
    await chrome.tabs.update(status.connectedTabId, { active: true });
    window.close();
  }, [status?.connectedTabId]);

  const handleTrackingToggle = React.useCallback(async () => {
    const response = (await chrome.runtime.sendMessage({ type: 'TOGGLE_TRACKING' })) as { active: boolean };
    setStatus((current) => (current ? { ...current, trackingActive: response.active } : current));
  }, []);

  return (
    <div className={theme.popup}>
      <header className={theme.header}>
        <div>
          <div className={theme.headerTitle}>Smartwriter MCP</div>
          <div className={theme.headerSub}>Browser bridge</div>
        </div>
        <Button
          aria-label="Settings"
          className={cn('bg-[#a9c5c0] text-[#16312e] hover:bg-[#bdd4d0] hover:text-[#061918]')}
          onClick={() => setSettingsOpen((open) => !open)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        <div className={cn('p-3 rounded-xl border flex items-center justify-between', theme.cardBg, theme.cardBorder)}>
          <div className="flex items-center gap-3">
            <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center', tabFlowEnabled ? 'bg-blue-500/20 text-blue-400' : theme.iconMuted)}>
              <Activity size={20} />
            </div>
            <div>
              <div className={cn('text-sm font-bold', theme.text)}>Tab Flow Mode</div>
              <div className={cn('text-[10px] uppercase tracking-wider font-extrabold', tabFlowEnabled ? 'text-blue-400' : theme.textMuted)}>
                {tabFlowEnabled ? 'Orchestration Active' : 'Single Tab Mode'}
              </div>
            </div>
          </div>
          <button
            onClick={handleToggleTabFlow}
            className={cn(
              'w-12 h-6 rounded-full transition-all duration-300 relative',
              tabFlowEnabled ? 'bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]' : 'bg-gray-700'
            )}
          >
            <div
              className={cn(
                'absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-300 transform',
                tabFlowEnabled ? 'translate-x-7' : 'translate-x-1'
              )}
            />
          </button>
        </div>

        {settingsOpen && status && (
          <SettingsPanel
            onAdd={addServer}
            onRemove={removeServer}
            onUpdate={updateServer}
            servers={status.servers}
          />
        )}

        {loadError ? (
          <div className={cn('bg-[#ddb8b2] px-3 py-3 text-sm', theme.textDanger)}>{loadError}</div>
        ) : (
          <ServerStatusList servers={status?.servers ?? []} />
        )}

        {tabFlowEnabled ? (
          <div className={cn('p-4 rounded-xl border border-dashed flex flex-col items-center justify-center gap-2 py-8', theme.cardBorder)}>
            <div className="animate-pulse flex space-x-2">
              <div className="h-2 w-2 bg-blue-400 rounded-full"></div>
              <div className="h-2 w-2 bg-blue-400 rounded-full"></div>
              <div className="h-2 w-2 bg-blue-400 rounded-full"></div>
            </div>
            <div className={cn('text-xs font-semibold mt-2', theme.textAccent)}>Agent is in Flow Mode</div>
            <div className={cn('text-[10px] text-center max-w-[180px]', theme.textMuted)}>
              Use the "Link" icon on page widgets to add tabs to the sequence.
            </div>
          </div>
        ) : (
          <TabControls
            activeTab={activeTab}
            currentStatus={status}
            currentTab={currentTab}
            onConnectToggle={handleConnectToggle}
            onFocusConnected={handleFocusConnected}
            onTrackingToggle={handleTrackingToggle}
            tabFlowEnabled={tabFlowEnabled}
          />
        )}
      </div>
    </div>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Popup root element not found.');
}

createRoot(root).render(<PopupApp />);
