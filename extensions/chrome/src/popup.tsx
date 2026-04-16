import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Loader2,
  MousePointerClick,
  Plus,
  Settings,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';

import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { cn } from './lib/utils';

interface ServerStatus {
  port: number;
  name?: string;
  wsStatus: 'connected' | 'connecting' | 'waiting';
}

interface Status {
  servers: ServerStatus[];
  currentTabId: number | null;
  trackingActive: boolean;
}

type EditableServer = Pick<ServerStatus, 'port' | 'name'>;

const statusMeta = {
  connected: {
    label: 'Connected',
    dotClass: 'bg-teal-500',
    textClass: 'text-teal-700',
    icon: Wifi,
  },
  connecting: {
    label: 'Connecting',
    dotClass: 'bg-amber-500 animate-pulse',
    textClass: 'text-amber-700',
    icon: Loader2,
  },
  waiting: {
    label: 'Waiting',
    dotClass: 'bg-amber-500 animate-pulse',
    textClass: 'text-amber-700',
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
      <div className="px-3 py-3 text-sm text-stone-400">
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
              <div className="truncate text-sm font-semibold text-stone-400">{label}</div>
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
        className={cn('h-8 px-2 text-xs', !editing && 'bg-stone-800 text-stone-400 shadow-none border-stone-700')}
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
        className={cn('h-8 min-w-0 px-2 text-xs', !editing && 'bg-stone-800 text-stone-400 shadow-none border-stone-700')}
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
        className="text-stone-400 hover:bg-rose-900 hover:text-rose-300"
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
    <section className="border-b border-stone-700 bg-stone-800 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-amber-600">MCP Servers</div>
          <div className="text-xs text-stone-500">Click a row to edit.</div>
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

      {error && <div className="mt-2 text-xs text-rose-600">{error}</div>}
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
}: {
  activeTab: chrome.tabs.Tab | null;
  currentStatus: Status | null;
  currentTab: chrome.tabs.Tab | null;
  onConnectToggle: () => Promise<void>;
  onFocusConnected: () => Promise<void>;
  onTrackingToggle: () => Promise<void>;
}) {
  if (!currentStatus) {
    return (
      <section className="border-t border-stone-700 bg-stone-800 px-3 py-3">
        <div className="h-4 w-40 animate-pulse rounded bg-stone-700" />
        <div className="mt-3 h-9 w-full animate-pulse rounded-md bg-stone-700" />
      </section>
    );
  }

  const isCurrentTabConnected = Boolean(currentStatus.currentTabId && currentStatus.currentTabId === activeTab?.id);
  const hasConnectedTab = Boolean(currentStatus.currentTabId);
  const title = isCurrentTabConnected
    ? 'This tab is connected'
    : hasConnectedTab
      ? currentTab?.title || 'Connected to another tab'
      : activeTab?.title || 'Current tab';

  return (
    <section className="border-t border-stone-700 bg-stone-700 px-3 py-3">
      <div className="mb-2 flex items-start gap-2">
        <MousePointerClick className={cn('mt-0.5 h-4 w-4 shrink-0', isCurrentTabConnected ? 'text-teal-400' : 'text-stone-500')} />
        <div className="min-w-0">
          <div className={cn('truncate text-sm font-medium', isCurrentTabConnected ? 'text-teal-400' : 'text-stone-400')} title={title}>
            {title}
          </div>
          {hasConnectedTab && !isCurrentTabConnected && (
            <div className="mt-0.5 text-xs text-stone-500">Another tab is connected.</div>
          )}
        </div>
      </div>

      <Button
        className="w-full"
        onClick={onConnectToggle}
        type="button"
        variant={isCurrentTabConnected ? 'destructive' : 'default'}
      >
        {isCurrentTabConnected ? 'Disconnect' : 'Connect This Tab'}
      </Button>

      {hasConnectedTab && !isCurrentTabConnected && (
        <Button className="mt-2 w-full" onClick={onFocusConnected} type="button" variant="outline">
          Focus Connected Tab
        </Button>
      )}

      {hasConnectedTab && (
        <>
          <Button
            className="mt-2 w-full"
            onClick={onTrackingToggle}
            type="button"
            variant={currentStatus.trackingActive ? 'success' : 'secondary'}
          >
            {currentStatus.trackingActive ? 'Tracking ON' : 'Enable Tracking'}
          </Button>
          {currentStatus.trackingActive && (
            <div className="mt-2 text-center text-xs text-stone-400">
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

  const refresh = React.useCallback(async () => {
    try {
      const [nextActiveTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const nextStatus = (await chrome.runtime.sendMessage({ type: 'GET_STATUS' })) as Status;

      setActiveTab(nextActiveTab ?? null);
      setStatus(nextStatus);
      setLoadError(null);

      if (nextStatus.currentTabId) {
        const nextCurrentTab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
          chrome.tabs.get(nextStatus.currentTabId!, (tab) => {
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

  const toggleConnection = React.useCallback(async () => {
    if (!status) return;
    const nextTabId = status.currentTabId === activeTab?.id ? null : activeTab?.id ?? null;
    await chrome.runtime.sendMessage({ type: 'CONNECT_TAB', tabId: nextTabId });
    await refresh();
  }, [activeTab?.id, refresh, status]);

  const focusConnectedTab = React.useCallback(async () => {
    if (!status?.currentTabId) return;
    await chrome.tabs.update(status.currentTabId, { active: true });
    window.close();
  }, [status?.currentTabId]);

  const toggleTracking = React.useCallback(async () => {
    const response = (await chrome.runtime.sendMessage({ type: 'TOGGLE_TRACKING' })) as { active: boolean };
    setStatus((current) => (current ? { ...current, trackingActive: response.active } : current));
  }, []);

  return (
    <div className="w-[280px] overflow-hidden rounded-none bg-stone-900 text-stone-400 shadow-none">
      <header className="flex items-center justify-between bg-stone-950 px-3 py-2.5 text-amber-600">
        <div>
          <div className="text-sm font-bold leading-5">Smartwriter MCP</div>
          <div className="text-xs text-stone-400">Browser bridge</div>
        </div>
        <Button
          aria-label="Settings"
          className="text-stone-500 hover:bg-stone-800 hover:text-amber-500"
          onClick={() => setSettingsOpen((open) => !open)}
          size="icon"
          type="button"
          variant="ghost"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </header>

      {settingsOpen && status && (
        <SettingsPanel
          onAdd={addServer}
          onRemove={removeServer}
          onUpdate={updateServer}
          servers={status.servers}
        />
      )}

      {loadError ? (
        <div className="bg-stone-900 px-3 py-3 text-sm text-rose-400">{loadError}</div>
      ) : (
        <ServerStatusList servers={status?.servers ?? []} />
      )}

      <TabControls
        activeTab={activeTab}
        currentStatus={status}
        currentTab={currentTab}
        onConnectToggle={toggleConnection}
        onFocusConnected={focusConnectedTab}
        onTrackingToggle={toggleTracking}
      />
    </div>
  );
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Popup root element not found.');
}

createRoot(root).render(<PopupApp />);
