export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active?: boolean;
}

export interface BrowserCommand {
  type: string;
  requestId: string;
  tabId: number | null;
  command: string;
  args: Record<string, unknown>;
}

export interface BrowserResponse {
  requestId: string;
  result?: unknown;
  error?: string;
}

export interface TabsUpdate {
  type: 'TABS_UPDATE';
  tabs: TabInfo[];
}

export type ExtensionMessage = BrowserCommand | TabsUpdate;

export interface BrowserAction {
  type: 'click' | 'type' | 'fill' | 'navigate' | 'screenshot' | 'evaluate' | 'waitFor' | 'snapshot' |
        'hover' | 'focus' | 'blur' | 'press_key' | 'double_click' | 'select' | 'clear' | 'drag' |
        'wait_for_selector' | 'wait_for_function' | 'scroll_into_view' | 'scroll' | 'reload' |
        'get_text' | 'get_attribute' | 'is_visible' | 'is_enabled' | 'is_checked' | 'check' | 'uncheck';
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  script?: string;
  marker?: string;
  index?: number;
  args?: unknown[];
  timeout?: number;
  key?: string;
  delay?: number;
  attribute?: string;
  fromSelector?: string;
  toSelector?: string;
  fullPage?: boolean;
  x?: number;
  y?: number;
  waitUntil?: string;
}
