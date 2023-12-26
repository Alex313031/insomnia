import { v4 as uuidv4 } from 'uuid';

import { RENDER_PURPOSE_SEND } from '../common/render';
import { RenderedRequest } from '../common/render';
import type { ResponseTimelineEntry } from '../main/network/libcurl-promise';
import { CaCertificate } from '../models/ca-certificate';
import { ClientCertificate } from '../models/client-certificate';
import { Environment } from '../models/environment';
import type { Request } from '../models/request';
import { Settings } from '../models/settings';
import { sendCurlAndWriteTimeline } from '../network/network';
import { tryToInterpolateRequest, tryToTransformRequestWithPlugins } from '../network/network';
import { RawObject } from '../renderers/hidden-browser-window/inso-object';
import { getWindowMessageHandler } from '../ui/window-message-handlers';

// run id should be saved to where?
// input/output of steps?
// centerized vars: runId, certificate, timeline

// pre request script?
//     run manager
//         runId
//         callback - wrapper
//             writeTimeline?
//             render step

// run manager
//     runId
//         find runId
//         callback - wrapper

// render step
//     render request
//     render plugin

// SendRequest
//     sendCurlAndWriteTimeline

// ResponseHandler
//     responseTransform
//     writeToDownloadPath

interface PreRequestScriptInput {
    insomnia: RawObject;
}

export class RequestSender {
    private request: Request;
    private shouldPromptForPathAfterResponse: boolean | undefined;
    private environment: Environment;
    private settings: Settings;
    private clientCertificates: ClientCertificate[];
    private caCert: CaCertificate | null;
    private preRequestScript: string;

    private timeline: ResponseTimelineEntry[];

    constructor(
        req: Request,
        shouldPromptForPathAfterResponse: boolean | undefined,
        environment: Environment,
        settings: Settings,
        clientCertificates: ClientCertificate[],
        caCert: CaCertificate | null,
        preRequestScript: string,
    ) {
        this.request = req;
        this.shouldPromptForPathAfterResponse = shouldPromptForPathAfterResponse;
        this.environment = environment;
        this.settings = settings;
        this.clientCertificates = clientCertificates;
        this.caCert = caCert;
        this.preRequestScript = preRequestScript;

        this.timeline = [];
    }

    start = async () => {
        const envData = this.environment.data;
        const insomniaObject: PreRequestScriptInput = {
            insomnia: {
                globals: {}, // TODO:
                environment: envData,
                collectionVariables: envData,
                iterationData: {}, // TODO:
                requestInfo: {}, // TODO:
            },
        };

        if (this.preRequestScript !== '') {
            this.runPreRequestScript(insomniaObject, this.preRequestScript);
        } else { // skip script
            // TODO: start rendering
        }
    };

    runPreRequestScript = (context: object, code: string) => {
        // TODO: populate environment into context

        const scriptRunId = uuidv4();
        const winMsgHandler = getWindowMessageHandler();
        winMsgHandler.runPreRequestScript(
            scriptRunId,
            code,
            context,
            this.runPreRequestScriptCallback,
        );
    };

    runPreRequestScriptCallback = async (ev: MessageEvent) => {
        if (ev.data.error) {
            // TODO: alert it in UI and timeline
            this.timeline.push({
                value: `failed to execute script: ${ev.data.error}`,
                name: 'Text',
                timestamp: Date.now(),
            });
            return;
        }

        this.timeline.push({
            value: 'Pre-request script execution done',
            name: 'Text',
            timestamp: Date.now(),
        });
        const result = ev.data.result;
        this.environment.data = result.environment;

        const renderedRequest = await this.renderRequest(this.request);
        await this.sendRequest(renderedRequest);
    };

    renderRequest = async (req: Request) => {
        const renderedResult = await tryToInterpolateRequest(req, this.environment, RENDER_PURPOSE_SEND);
        const renderedRequest = await tryToTransformRequestWithPlugins(renderedResult);

        // TODO: remove this temporary hack to support GraphQL variables in the request body properly
        if (renderedRequest && renderedRequest.body?.text && renderedRequest.body?.mimeType === 'application/graphql') {
            try {
                const parsedBody = JSON.parse(renderedRequest.body.text);
                if (typeof parsedBody.variables === 'string') {
                    parsedBody.variables = JSON.parse(parsedBody.variables);
                    renderedRequest.body.text = JSON.stringify(parsedBody, null, 2);
                }
            } catch (e) {
                console.error('Failed to parse GraphQL variables', e);
            }
        }

        return renderedRequest;
    };

    sendRequest = async (req: RenderedRequest) => {
        const response = await sendCurlAndWriteTimeline(
            req,
            this.clientCertificates,
            this.caCert,
            this.settings,
        );

        console.log('received response', response);
    };
}
