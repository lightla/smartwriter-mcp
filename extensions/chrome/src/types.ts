export type ContentMessage =
  | { type: 'REGISTER'; tabId: number; url: string }
  | { type: 'CLICK'; selector: string }
  | { type: 'TYPE'; selector: string; text: string }
  | { type: 'FILL'; selector: string; value: string }
  | { type: 'SELECT'; selector: string; options: string[] }
  | { type: 'NAVIGATE'; url: string }
  | { type: 'GO_BACK' }
  | { type: 'GO_FORWARD' }
  | { type: 'RELOAD' }
  | { type: 'EVALUATE'; script: string; args?: unknown[] }
  | { type: 'HOVER'; selector: string }
  | { type: 'CHECK'; selector: string }
  | { type: 'UNCHECK'; selector: string }
  | { type: 'GET_SNAPSHOT'; selector?: string }
  | { type: 'SCREENSHOT' }
  | { type: 'WAIT_FOR'; text: string; timeout?: number }
  | { type: 'PRESS_KEY'; key: string }
  | { type: 'GET_TEXT'; selector: string }
  | { type: 'GET_ATTRIBUTE'; selector: string; attribute: string }
  | { type: 'TOGGLE_TRACKING'; active: boolean }
  | { type: 'UNREGISTER' };

export type ContentResponse = {
  success: boolean;
  data?: unknown;
  error?: string;
};

export type TabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
};

export type McpCommand = {
  type: 'COMMAND';
  requestId: string;
  tabId: number;
  command: string;
  args: Record<string, unknown>;
};

export type McpResponse = {
  requestId: string;
  result?: unknown;
  error?: string;
};

export type TabsUpdate = {
  type: 'TABS_UPDATE';
  tabs: TabInfo[];
  currentTabId: number | null;
};

// ==================== ANNOTATION TYPES ====================

export type AnnotationType = 'fix' | 'step' | 'bug';

export interface AnnotationSelectors {
  primary: string;
  testId?: string;
  id?: string;
  cssPath: string;
  xpath: string;
  text?: string;
}

export interface AnnotationElement {
  tag: string;
  text?: string;
  classList: string[];
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

export interface AnnotationFramework {
  type: 'react' | 'vue' | 'next' | 'nuxt' | 'unknown';
  componentName?: string;
  componentChain?: string[];
}

export interface Annotation {
  id: string;
  url: string;
  timestamp: string;
  type: AnnotationType;
  note: string;
  stepNumber?: number;
  selectors: AnnotationSelectors;
  element: AnnotationElement;
  framework: AnnotationFramework;
}
