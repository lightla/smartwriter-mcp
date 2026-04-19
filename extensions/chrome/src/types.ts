export type ContentMessage =
  | { type: 'REGISTER'; tabId: number; url: string }
  | { type: 'CLICK'; selector?: string; elementRef?: string }
  | { type: 'TYPE'; selector?: string; elementRef?: string; text: string }
  | { type: 'FILL'; selector?: string; elementRef?: string; value: string }
  | { type: 'SELECT'; selector?: string; elementRef?: string; options: string[] }
  | { type: 'NAVIGATE'; url: string }
  | { type: 'GO_BACK' }
  | { type: 'GO_FORWARD' }
  | { type: 'RELOAD' }
  | { type: 'EVALUATE'; script: string; args?: unknown[]; marker?: string; index?: number }
  | { type: 'HOVER'; selector?: string; elementRef?: string }
  | { type: 'CHECK'; selector?: string; elementRef?: string }
  | { type: 'UNCHECK'; selector?: string; elementRef?: string }
  | { type: 'GET_SNAPSHOT'; selector?: string; elementRef?: string }
  | { type: 'SCREENSHOT' }
  | { type: 'WAIT_FOR'; text: string; timeout?: number }
  | { type: 'PRESS_KEY'; key: string }
  | { type: 'GET_TEXT'; selector?: string; elementRef?: string }
  | { type: 'GET_ATTRIBUTE'; selector?: string; elementRef?: string; attribute: string }
  | { type: 'GET_ELEMENT_BY_MARKER'; selector?: string; elementRef?: string }
  | { type: 'GET_COMPONENT_ORIGIN'; selector?: string; elementRef?: string }
  | { type: 'RESOLVE_TARGET'; target: string; force?: boolean }
  | { type: 'TOGGLE_TRACKING'; active: boolean; flowMarker?: string }
  | { type: 'TAB_FLOW_STATE_CHANGE'; enabled: boolean; flowMarker?: string }
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
  connectedTabId: number | null;
};

// ==================== ANNOTATION TYPES ====================

export type AnnotationType = 'step' | 'change' | 'bug';

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
  tabId?: number;
  url: string;
  timestamp: string;
  type: AnnotationType;
  note: string;
  stepNumber?: number;
  selectors: AnnotationSelectors;
  element: AnnotationElement;
  framework: AnnotationFramework;
}
