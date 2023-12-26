
type MessageHandler = (ev: MessageEvent) => Promise<void>;;
interface ExecuteScriptCallback {
    id: string;
    cb: (ev: MessageEvent) => void;
}

// WindowMessageHandler handles entities in followings domains:
// - handle window message events
// - handle message port events
// - trigger message callbacks
class WindowMessageHandler {
    private hiddenBrowserWindowPort: MessagePort | undefined;
    private actionHandlers: Map<string, MessageHandler> = new Map();
    private runScriptCallbacks: ExecuteScriptCallback[];

    constructor() {
        this.runScriptCallbacks = [];
    }

    publishPortHandler = async (ev: MessageEvent) => {
        if (ev.ports.length === 0) {
            console.error('no port is found in the publishing port event');
            return;
        }

        this.hiddenBrowserWindowPort = ev.ports[0];

        this.hiddenBrowserWindowPort.onmessage = ev => {
            if (ev.data.action === 'message-channel://caller/respond') {
                if (!ev.data.id) {
                    console.error('id is not specified in the executing script response message');
                    return;
                }

                const callbackIndex = this.runScriptCallbacks.findIndex(callback => callback.id === ev.data.id);
                if (callbackIndex < 0) {
                    console.error(`id(${ev.data.id}) is not found in the callback list`);
                    return;
                }

                this.runScriptCallbacks[callbackIndex].cb(ev);
                // skip previous ones for keeping it simple
                this.runScriptCallbacks = this.runScriptCallbacks.slice(callbackIndex + 1);
            } else if (ev.data.action === 'message-channel://caller/debug/respond') {
                if (ev.data.result) {
                    window.localStorage.setItem(`test_result:${ev.data.id}`, JSON.stringify(ev.data.result));
                    console.log(ev.data.result);
                } else {
                    window.localStorage.setItem(`test_error:${ev.data.id}`, JSON.stringify(ev.data.error));
                    console.error(ev.data.error);
                }
            } else {
                console.error(`unknown action ${ev}`);
            }
        };
    };

    debugEventHandler = async (ev: MessageEvent) => {
        if (!this.hiddenBrowserWindowPort) {
            console.error('hidden browser window port is not inited');
            return;
        }

        console.info('sending script to hidden browser window');
        this.hiddenBrowserWindowPort.postMessage({
            action: 'message-channel://hidden.browser-window/debug',
            options: {
                id: ev.data.id,
                code: ev.data.code,
                context: ev.data.context,
            },
        });
    };

    register = (actionName: string, handler: MessageHandler) => {
        this.actionHandlers.set(actionName, handler);
    };

    start = () => {
        window.hiddenBrowserWindow.start();

        this.register('message-event://renderers/publish-port', this.publishPortHandler);
        this.register('message-event://hidden.browser-window/debug', this.debugEventHandler);
        this.register('message-event://hidden.browser-window/execute', this.debugEventHandler);

        window.onmessage = (ev: MessageEvent) => {
            const action = ev.data.action;
            if (!action) {
                // could be react events
                return;
            }

            const handler = this.actionHandlers.get(action);
            if (!handler) {
                console.error(`no handler is found for action ${action}`);
                return;
            }

            try {
                handler(ev);
            } catch (e) {
                console.error(`failed to handle event message (${ev.data.action}): ${e.message}`);
            }
        };
    };

    stop = () => {
        this.actionHandlers.clear();
    };

    runPreRequestScript = (id: string, code: string, context: object, cb: (ev: MessageEvent) => void): boolean => {
        if (!this.hiddenBrowserWindowPort) {
            console.error('hidden browser window port is not inited');
            return false;
        }

        this.runScriptCallbacks.push({
            id,
            cb,
        });

        this.hiddenBrowserWindowPort.postMessage({
            action: 'message-channel://hidden.browser-window/execute',
            options: {
                id,
                code,
                context,
            },
        });

        return true;
    };
}

const windowMessageHandler = new WindowMessageHandler();
export function getWindowMessageHandler() {
    return windowMessageHandler;
}
