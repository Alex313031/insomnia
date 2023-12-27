import { createWriteStream } from 'node:fs';
import path from 'node:path';

import * as contentDisposition from 'content-disposition';
import orderedJSON from 'json-order';
import { extension as mimeExtension } from 'mime-types';
import { v4 as uuidv4 } from 'uuid';

import { JSON_ORDER_PREFIX, JSON_ORDER_SEPARATOR } from '../common/constants';
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

interface PreRequestScriptMessage {
    insomnia: RawObject;
}

export class RequestSender {
    private request: Request;
    private shouldPromptForPathAfterResponse: boolean | undefined;
    private baseEnvironment: Environment;
    private environment: Environment;
    private settings: Settings;
    private clientCertificates: ClientCertificate[];
    private caCert: CaCertificate | null;
    private preRequestScript: string;

    private timeline: ResponseTimelineEntry[];

    constructor(
        req: Request,
        shouldPromptForPathAfterResponse: boolean | undefined,
        baseEnvironment: Environment,
        environment: Environment,
        settings: Settings,
        clientCertificates: ClientCertificate[],
        caCert: CaCertificate | null,
        preRequestScript: string,
    ) {
        this.request = req;
        this.shouldPromptForPathAfterResponse = shouldPromptForPathAfterResponse;
        this.baseEnvironment = baseEnvironment;
        this.environment = environment;
        this.settings = settings;
        this.clientCertificates = clientCertificates;
        this.caCert = caCert;
        this.preRequestScript = preRequestScript;

        this.timeline = [];
    }

    start = async () => {
        const insomniaObject: PreRequestScriptMessage = {
            insomnia: {
                globals: {}, // TODO:
                environment: this.environment.data,
                collectionVariables: this.baseEnvironment.data,
                iterationData: {}, // TODO:
                requestInfo: {}, // TODO:
            },
        };

        if (this.preRequestScript !== '') {
            try {
                const rawObjectOrError = await this.runPreRequestScript(insomniaObject, this.preRequestScript);
                if (!rawObjectOrError) {
                    console.error('no response returned');
                    return;
                }

                const rawObj = rawObjectOrError as Record<string, any>;
                const envJsonMap = orderedJSON.parse(
                    JSON.stringify(rawObj.environment),
                    JSON_ORDER_PREFIX,
                    JSON_ORDER_SEPARATOR,
                );
                const baseEnvJsonMap = orderedJSON.parse(
                    JSON.stringify(rawObj.collectionVariables),
                    JSON_ORDER_PREFIX,
                    JSON_ORDER_SEPARATOR,
                );

                // map raw object to insomnia's environment hierarchy
                this.environment.data = rawObj.environment;
                this.environment.dataPropertyOrder = envJsonMap.map;
                this.baseEnvironment.data = rawObj.collectionVariables;
                this.baseEnvironment.dataPropertyOrder = baseEnvJsonMap.map;

            } catch (e) {
                if (!e.message) {
                    console.error(`no message found in error: ${JSON.stringify(e)}`);
                }

                this.timeline.push({
                    value: `Pre-request script execution failed: ${e.message}`,
                    name: 'Text',
                    timestamp: Date.now(),
                });
                return;
            }
        }

        this.timeline.push({
            value: 'Pre-request script execution done',
            name: 'Text',
            timestamp: Date.now(),
        });

        const { renderedRequest, renderedResult } = await this.renderRequest(this.request);
        await this.sendRequest(renderedRequest, renderedResult);
    };

    runPreRequestScript = async (context: object, code: string) => {
        const scriptRunId = uuidv4();
        const winMsgHandler = getWindowMessageHandler();
        return await winMsgHandler.runPreRequestScript(
            scriptRunId,
            code,
            context,
        );
    };

    renderRequest = async (req: Request) => {
        const renderedResult = await tryToInterpolateRequest(req, this.environment, RENDER_PURPOSE_SEND, undefined, this.baseEnvironment);
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
