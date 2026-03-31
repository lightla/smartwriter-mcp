declare namespace browser {
  namespace runtime {
    function sendMessage(message: any): Promise<any>;
    const onMessage: {
      addListener(callback: (message: any, sender: any, sendResponse: (response: any) => void) => boolean | void): void;
    };
    function getId(): string;
  }
  namespace tabs {
    function query(queryInfo: any): Promise<any[]>;
    function sendMessage(tabId: number, message: any): Promise<any>;
    const onRemoved: {
      addListener(callback: (tabId: number) => void): void;
    };
    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: any, tab: any) => void): void;
    };
  }
}
