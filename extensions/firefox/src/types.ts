export type ContentMessage =
  | { type: 'REGISTER'; tabId: number; url: string }
  | { type: 'CLICK'; selector: string }
  | { type: 'TYPE'; selector: string; text: string }
  | { type: 'FILL'; selector: string; value: string }
  | { type: 'SELECT'; selector: string; options: string[] }
  | { type: 'NAVIGATE'; url: string }
  | { type: 'EVALUATE'; script: string; args?: unknown[] }
  | { type: 'HOVER'; selector: string }
  | { type: 'GET_SNAPSHOT'; selector?: string }
  | { type: 'SCREENSHOT' }
  | { type: 'WAIT_FOR'; text: string; timeout?: number }
  | { type: 'PRESS_KEY'; key: string }
  | { type: 'GET_TEXT'; selector: string }
  | { type: 'GET_ATTRIBUTE'; selector: string; attribute: string }
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
};
