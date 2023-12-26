import { createWriteStream } from 'node:fs';
import path from 'node:path';

import * as contentDisposition from 'content-disposition';
import { extension as mimeExtension } from 'mime-types';
import { redirect } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';

import { getContentDispositionHeader } from '../common/misc';
import { RENDER_PURPOSE_SEND } from '../common/render';
import { RenderedRequest } from '../common/render';
import type { ResponseTimelineEntry } from '../main/network/libcurl-promise';
import { ResponsePatch } from '../main/network/libcurl-promise';
import * as models from '../models';
import { CaCertificate } from '../models/ca-certificate';
import { ClientCertificate } from '../models/client-certificate';
import { Environment } from '../models/environment';
import type { Request } from '../models/request';
import { RequestMeta } from '../models/request-meta';
import { Settings } from '../models/settings';
import { responseTransform, sendCurlAndWriteTimeline } from '../network/network';
import { tryToInterpolateRequest, tryToTransformRequestWithPlugins } from '../network/network';
import { RawObject } from '../renderers/hidden-browser-window/inso-object';
import { getWindowMessageHandler } from '../ui/window-message-handlers';
import { invariant } from '../utils/invariant';

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
    private redirectUrl: string;

    private timeline: ResponseTimelineEntry[];

    constructor(
        req: Request,
        shouldPromptForPathAfterResponse: boolean | undefined,
        environment: Environment,
        settings: Settings,
        clientCertificates: ClientCertificate[],
        caCert: CaCertificate | null,
        preRequestScript: string,
        redirectUrl: string,
    ) {
        this.request = req;
        this.shouldPromptForPathAfterResponse = shouldPromptForPathAfterResponse;
        this.environment = environment;
        this.settings = settings;
        this.clientCertificates = clientCertificates;
        this.caCert = caCert;
        this.preRequestScript = preRequestScript;
        this.redirectUrl = redirectUrl;

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

        const { renderedRequest, renderedResult } = await this.renderRequest(this.request);
        await this.sendRequest(renderedRequest, renderedResult);

        // handle error
        // const navigate = useNavigate();
        // navigate(this.redirectUrl);
        const callbackUrl = new URL(this.redirectUrl);
        callbackUrl.searchParams.set('callback', this.request._id);
        redirect(`${callbackUrl.pathname}?${callbackUrl.searchParams}`);
        // redirect(this.redirectUrl);
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

        return { renderedRequest, renderedResult };
    };

    sendRequest = async (req: RenderedRequest, renderedResult: Record<string, any>) => {
        const response = await sendCurlAndWriteTimeline(
            req,
            this.clientCertificates,
            this.caCert,
            this.settings,
            this.timeline,
        );

        console.log('received response', response);

        const requestMeta = await models.requestMeta.getByParentId(this.request._id);
        invariant(requestMeta, 'RequestMeta not found');

        const responsePatch = await responseTransform(response, this.environment._id, req, renderedResult.context);
        const is2XXWithBodyPath = responsePatch.statusCode && responsePatch.statusCode >= 200 && responsePatch.statusCode < 300 && responsePatch.bodyPath;
        const shouldWriteToFile = this.shouldPromptForPathAfterResponse && is2XXWithBodyPath;
        if (!shouldWriteToFile) {
            const response = await models.response.create(responsePatch, this.settings.maxHistoryResponses);
            await models.requestMeta.update(requestMeta, { activeResponseId: response._id });
            // setLoading(false);
            return null;
        }
        if (requestMeta.downloadPath) {
            const header = getContentDispositionHeader(responsePatch.headers || []);
            const name = header
                ? contentDisposition.parse(header.value).parameters.filename
                : `${req.name.replace(/\s/g, '-').toLowerCase()}.${responsePatch.contentType && mimeExtension(responsePatch.contentType) || 'unknown'}`;
            return this.writeToDownloadPath(path.join(requestMeta.downloadPath, name), responsePatch, requestMeta, this.settings.maxHistoryResponses);
        } else {
            const defaultPath = window.localStorage.getItem('insomnia.sendAndDownloadLocation');
            const { filePath } = await window.dialog.showSaveDialog({
                title: 'Select Download Location',
                buttonLabel: 'Save',
                // NOTE: An error will be thrown if defaultPath is supplied but not a String
                ...(defaultPath ? { defaultPath } : {}),
            });
            if (!filePath) {
                // setLoading(false);
                return null;
            }
            window.localStorage.setItem('insomnia.sendAndDownloadLocation', filePath);
            return this.writeToDownloadPath(filePath, responsePatch, requestMeta, this.settings.maxHistoryResponses);
        }
    };

    writeToDownloadPath = (downloadPathAndName: string, responsePatch: ResponsePatch, requestMeta: RequestMeta, maxHistoryResponses: number) => {
        invariant(downloadPathAndName, 'filename should be set by now');

        const to = createWriteStream(downloadPathAndName);
        const readStream = models.response.getBodyStream(responsePatch);
        if (!readStream || typeof readStream === 'string') {
            return null;
        }
        readStream.pipe(to);

        return new Promise(resolve => {
            readStream.on('end', async () => {
                responsePatch.error = `Saved to ${downloadPathAndName}`;
                const response = await models.response.create(responsePatch, maxHistoryResponses);
                await models.requestMeta.update(requestMeta, { activeResponseId: response._id });
                resolve(null);
            });
            readStream.on('error', async err => {
                console.warn('Failed to download request after sending', responsePatch.bodyPath, err);
                const response = await models.response.create(responsePatch, maxHistoryResponses);
                await models.requestMeta.update(requestMeta, { activeResponseId: response._id });
                resolve(null);
            });
        });

    };
}
