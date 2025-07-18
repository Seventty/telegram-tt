import {
  Api as GramJs,
  sessions,
  type Update,
} from '../../../lib/gramjs';
import type { TwoFaParams } from '../../../lib/gramjs/client/2fa';
import TelegramClient from '../../../lib/gramjs/client/TelegramClient';
import { RPCError } from '../../../lib/gramjs/errors';
import { Logger as GramJsLogger } from '../../../lib/gramjs/extensions/index';

import type { ThreadId } from '../../../types';
import type {
  ApiInitialArgs,
  ApiMediaFormat,
  ApiOnProgress,
  ApiSessionData,
} from '../../types';

import {
  APP_CODE_NAME,
  DEBUG, DEBUG_GRAMJS, IS_TEST, LANG_PACK, UPLOAD_WORKERS,
} from '../../../config';
import { pause } from '../../../util/schedulers';
import {
  buildApiMessage,
  setMessageBuilderCurrentUserId,
} from '../apiBuilders/messages';
import { buildApiPeerId } from '../apiBuilders/peers';
import { buildApiStory } from '../apiBuilders/stories';
import { buildApiUser, buildApiUserFullInfo } from '../apiBuilders/users';
import { buildInputChannelFromLocalDb, buildInputPeerFromLocalDb, getEntityTypeById } from '../gramjsBuilders';
import {
  addStoryToLocalDb, addUserToLocalDb,
} from '../helpers/localDb';
import {
  isResponseUpdate, log,
} from '../helpers/misc';
import localDb, { clearLocalDb, type RepairInfo } from '../localDb';
import { sendApiUpdate } from '../updates/apiUpdateEmitter';
import { processAndUpdateEntities, processMessageAndUpdateThreadInfo } from '../updates/entityProcessor';
import {
  getDifference,
  init as initUpdatesManager,
  processUpdate,
  reset as resetUpdatesManager,
  scheduleGetChannelDifference,
  updateChannelState,
} from '../updates/updateManager';
import {
  onAuthError, onAuthReady, onCurrentUserUpdate, onRequestCode, onRequestPassword, onRequestPhoneNumber,
  onRequestQrCode, onRequestRegistration, onWebAuthTokenFailed,
} from './auth';
import downloadMediaWithClient, { parseMediaUrl } from './media';

import { ChatAbortController } from '../ChatAbortController';

const DEFAULT_USER_AGENT = 'Unknown UserAgent';
const DEFAULT_PLATFORM = 'Unknown platform';

GramJsLogger.setLevel(DEBUG_GRAMJS ? 'debug' : 'warn');

const gramJsUpdateEventBuilder = { build: (update: Update) => update };

const CHAT_ABORT_CONTROLLERS = new Map<string, ChatAbortController>();
const ABORT_CONTROLLERS = new Map<string, AbortController>();

let client: TelegramClient;
let currentUserId: string | undefined;

export async function init(initialArgs: ApiInitialArgs) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('>>> START INIT API');
  }

  const {
    userAgent, platform, sessionData, isWebmSupported, maxBufferSize, webAuthToken, dcId,
    mockScenario, shouldForceHttpTransport, shouldAllowHttpTransport,
    shouldDebugExportedSenders, langCode, isTestServerRequested, accountIds,
  } = initialArgs;

  const session = new sessions.CallbackSession(sessionData, onSessionUpdate);

  (self as any).isWebmSupported = isWebmSupported;

  (self as any).maxBufferSize = maxBufferSize;

  client = new TelegramClient(
    session,
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    {
      deviceModel: navigator.userAgent || userAgent || DEFAULT_USER_AGENT,
      systemVersion: platform || DEFAULT_PLATFORM,
      appVersion: `${APP_VERSION} ${APP_CODE_NAME}`,
      useWSS: true,
      additionalDcsDisabled: IS_TEST,
      shouldDebugExportedSenders,
      shouldForceHttpTransport,
      shouldAllowHttpTransport,
      dcId,
      langPack: LANG_PACK,
      langCode,
      systemLangCode: navigator.language,
      isTestServerRequested,
    } as any,
  );

  client.addEventHandler(handleGramJsUpdate, gramJsUpdateEventBuilder);

  try {
    if (DEBUG) {
      log('CONNECTING');

      (self as any).invoke = invokeRequest;

      (self as any).GramJs = GramJs;
    }

    try {
      client.setPingCallback(getDifference);
      await client.start({
        phoneNumber: onRequestPhoneNumber,
        phoneCode: onRequestCode,
        password: onRequestPassword,
        firstAndLastNames: onRequestRegistration,
        qrCode: onRequestQrCode,
        onError: onAuthError,
        initialMethod: platform === 'iOS' || platform === 'Android' ? 'phoneNumber' : 'qrCode',
        shouldThrowIfUnauthorized: Boolean(sessionData),
        webAuthToken,
        webAuthTokenFailed: onWebAuthTokenFailed,
        mockScenario,
        accountIds,
      });
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(err);

      if (err.message !== 'Disconnect' && err.message !== 'Cannot send requests while disconnected') {
        sendApiUpdate({
          '@type': 'updateConnectionState',
          connectionState: 'connectionStateBroken',
        });

        return;
      }
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('>>> FINISH INIT API');
      log('CONNECTED');
    }

    onAuthReady();
    onSessionUpdate(session.getSessionData());
    sendApiUpdate({ '@type': 'updateApiReady' });

    initUpdatesManager(invokeRequest);

    void fetchCurrentUser();
  } catch (err) {
    if (DEBUG) {
      log('CONNECTING ERROR', err);
    }

    throw err;
  }
}

export function setIsPremium({ isPremium }: { isPremium: boolean }) {
  client.setIsPremium(isPremium);
}

const LOG_OUT_TIMEOUT = 2500;
export async function destroy(noLogOut = false, noClearLocalDb = false) {
  if (!noLogOut && client.isConnected()) {
    await Promise.race([
      invokeRequest(new GramJs.auth.LogOut()),
      pause(LOG_OUT_TIMEOUT),
    ]);
  }

  if (!noClearLocalDb) {
    clearLocalDb();
    resetUpdatesManager();
  }

  await client.destroy();
}

export async function disconnect() {
  await client.disconnect();
}

export function getClient() {
  return client;
}

function onSessionUpdate(sessionData?: ApiSessionData) {
  sendApiUpdate({
    '@type': 'updateSession',
    sessionData,
  });
}

type UpdateConfig = GramJs.UpdateConfig & { _entities?: (GramJs.TypeUser | GramJs.TypeChat)[] };

export function handleGramJsUpdate(update: any) {
  processUpdate(update);

  if (update instanceof GramJs.UpdatesTooLong) {
    void handleTerminatedSession();
  } else {
    const updates = 'updates' in update ? update.updates : [update];
    updates.forEach((nestedUpdate: any) => {
      if (!(nestedUpdate instanceof GramJs.UpdateConfig)) return;

      const currentUser = (nestedUpdate as UpdateConfig)._entities
        ?.find((entity) => entity instanceof GramJs.User && buildApiPeerId(entity.id, 'user') === currentUserId);
      if (!(currentUser instanceof GramJs.User)) return;

      setIsPremium({ isPremium: Boolean(currentUser.premium) });
    });
  }
}

type InvokeRequestParams = {
  shouldThrow?: boolean;
  shouldIgnoreUpdates?: boolean;
  dcId?: number;
  shouldIgnoreErrors?: boolean;
  abortControllerChatId?: string;
  abortControllerThreadId?: ThreadId;
  abortControllerGroup?: 'call';
  shouldRetryOnTimeout?: boolean;
};

export async function invokeRequest<T extends GramJs.AnyRequest>(
  request: T,
  params?: InvokeRequestParams & { shouldReturnTrue?: false },
): Promise<T['__response'] | undefined>;

export async function invokeRequest<T extends GramJs.AnyRequest>(
  request: T,
  params?: InvokeRequestParams & { shouldReturnTrue: true },
): Promise<true | undefined>;

export async function invokeRequest<T extends GramJs.AnyRequest>(
  request: T,
  params: InvokeRequestParams & { shouldReturnTrue?: boolean } = {},
) {
  const {
    shouldThrow, shouldIgnoreUpdates, dcId, shouldIgnoreErrors, abortControllerChatId, abortControllerThreadId,
    shouldRetryOnTimeout, abortControllerGroup,
  } = params;
  const shouldReturnTrue = Boolean(params.shouldReturnTrue);

  let abortSignal: AbortSignal | undefined;
  if (abortControllerChatId) {
    let controller = CHAT_ABORT_CONTROLLERS.get(abortControllerChatId);
    if (!controller) {
      controller = new ChatAbortController();
      CHAT_ABORT_CONTROLLERS.set(abortControllerChatId, controller);
    }

    abortSignal = abortControllerThreadId ? controller.getThreadSignal(abortControllerThreadId) : controller.signal;
  }

  if (abortControllerGroup) {
    let controller = ABORT_CONTROLLERS.get(abortControllerGroup);
    if (!controller) {
      controller = new AbortController();
      ABORT_CONTROLLERS.set(abortControllerGroup, controller);
    }
    abortSignal = controller.signal;
  }

  try {
    if (DEBUG) {
      log('INVOKE', request.className);
    }

    const result = await client.invoke(request, dcId, abortSignal, shouldRetryOnTimeout);

    processAndUpdateEntities(result);

    if (DEBUG) {
      log('RESPONSE', request.className, result);
    }

    if (!shouldIgnoreUpdates && isResponseUpdate(result)) {
      processUpdate(result);
    }

    return shouldReturnTrue ? result && true : result;
  } catch (err: any) {
    if (shouldIgnoreErrors) return undefined;
    if (DEBUG) {
      log('INVOKE ERROR', request.className);
      // eslint-disable-next-line no-console
      console.debug('invokeRequest failed with payload', request);
      // eslint-disable-next-line no-console
      console.error(err);
    }

    const message = err instanceof RPCError ? err.errorMessage : err.message;

    if (message.includes('FROZEN_METHOD_INVALID')) {
      dispatchNotSupportedInFrozenAccountUpdate(err, request);
    }

    if (shouldThrow) {
      throw err;
    }

    dispatchErrorUpdate(err, request);

    return undefined;
  }
}

export function invokeRequestBeacon<T extends GramJs.AnyRequest>(
  request: T,
  dcId?: number,
) {
  if (DEBUG) {
    log('BEACON', request.className);
  }

  client.invokeBeacon(request, dcId);
}

export async function downloadMedia(
  args: {
    url: string; mediaFormat: ApiMediaFormat; start?: number; end?: number; isHtmlAllowed?: boolean;
  },
  onProgress?: ApiOnProgress,
) {
  try {
    return (await downloadMediaWithClient(args, client, onProgress));
  } catch (err: unknown) {
    if (err instanceof RPCError) {
      if (err.errorMessage.startsWith('FILE_REFERENCE')) {
        const isFileReferenceRepaired = await repairFileReference({ url: args.url });
        if (isFileReferenceRepaired) {
          return downloadMediaWithClient(args, client, onProgress);
        }

        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.error('Failed to repair file reference', args.url);
        }
      }

      if (err.errorMessage === 'FILE_ID_INVALID' && args.url.includes('avatar')) {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.warn('Inaccessible avatar image', args.url);
        }
        return undefined;
      }
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.error('Failed to download media', args.url, err);
    }

    throw err;
  }
}

export function uploadFile(file: File, onProgress?: ApiOnProgress) {
  return client.uploadFile({ file, onProgress, workers: UPLOAD_WORKERS });
}

export function updateTwoFaSettings(params: TwoFaParams) {
  return client.updateTwoFaSettings(params);
}

export function getTmpPassword(currentPassword: string, ttl?: number) {
  return client.getTmpPassword(currentPassword, ttl);
}

export function getCurrentPassword(currentPassword?: string) {
  return client.getCurrentPassword(currentPassword);
}

export function abortChatRequests(params: { chatId: string; threadId?: ThreadId }) {
  const { chatId, threadId } = params;
  const controller = CHAT_ABORT_CONTROLLERS.get(chatId);
  if (!threadId) {
    controller?.abort('Chat change');
    CHAT_ABORT_CONTROLLERS.delete(chatId);
    return;
  }

  controller?.abortThread(threadId, 'Thread change');
}

export function abortRequestGroup(group: string) {
  ABORT_CONTROLLERS.get(group)?.abort();
  ABORT_CONTROLLERS.delete(group);
}

export async function fetchCurrentUser() {
  const userFull = await invokeRequest(new GramJs.users.GetFullUser({
    id: new GramJs.InputUserSelf(),
  }));

  if (!userFull || !(userFull.users[0] instanceof GramJs.User)) {
    return;
  }

  const user = userFull.users[0];

  addUserToLocalDb(user);
  const currentUserFullInfo = buildApiUserFullInfo(userFull);
  const currentUser = buildApiUser(user)!;

  setMessageBuilderCurrentUserId(currentUser.id);
  onCurrentUserUpdate(currentUser, currentUserFullInfo);

  currentUserId = currentUser.id;
  setIsPremium({ isPremium: Boolean(currentUser.isPremium) });
}

export function dispatchErrorUpdate<T extends GramJs.AnyRequest>(err: Error, request: T) {
  const message = err instanceof RPCError ? err.errorMessage : err.message;
  const isSlowMode = message === 'FLOOD' && (
    request instanceof GramJs.messages.SendMessage
    || request instanceof GramJs.messages.SendMedia
    || request instanceof GramJs.messages.SendMultiMedia
  );

  sendApiUpdate({
    '@type': 'error',
    error: {
      message,
      isSlowMode,
      hasErrorKey: true,
    },
  });
}

function dispatchNotSupportedInFrozenAccountUpdate<T extends GramJs.AnyRequest>(err: Error, request: T) {
  if (!(err instanceof RPCError)) return;
  const message = err.errorMessage;

  if (
    request instanceof GramJs.messages.GetPinnedDialogs
    || request instanceof GramJs.phone.GetGroupParticipants
    || request instanceof GramJs.channels.GetParticipant
    || request instanceof GramJs.channels.GetParticipants
    || request instanceof GramJs.channels.GetForumTopics) {
    return;
  }

  sendApiUpdate({
    '@type': 'notSupportedInFrozenAccount',
    error: {
      message,
    },
  });
}

async function handleTerminatedSession() {
  try {
    await invokeRequest(new GramJs.users.GetFullUser({
      id: new GramJs.InputUserSelf(),
    }), {
      shouldThrow: true,
    });
  } catch (err: any) {
    if (
      err.errorMessage === 'AUTH_KEY_UNREGISTERED'
      || err.errorMessage === 'SESSION_REVOKED'
      || err.errorMessage === 'USER_DEACTIVATED'
    ) {
      sendApiUpdate({
        '@type': 'updateConnectionState',
        connectionState: 'connectionStateBroken',
      });
    }
  }
}

export async function repairFileReference({
  url,
}: {
  url: string;
}) {
  const parsed = parseMediaUrl(url);
  if (!parsed) return undefined;

  const {
    entityId, mediaMatchType,
  } = parsed;

  if (mediaMatchType === 'document' || mediaMatchType === 'photo' || mediaMatchType === 'webDocument') {
    const entity = mediaMatchType === 'document'
      ? localDb.documents[entityId] : mediaMatchType === 'webDocument'
        ? localDb.webDocuments[entityId] : localDb.photos[entityId];
    if (!entity) return false;
    const repairableEntity = entity as RepairInfo;
    if (!repairableEntity.localRepairInfo) return false;
    const { localRepairInfo } = repairableEntity;

    if (localRepairInfo.type === 'story') {
      const result = await repairStoryMedia(localRepairInfo.peerId, localRepairInfo.id);
      return result;
    }

    if (localRepairInfo.type === 'message') {
      const result = await repairMessageMedia(localRepairInfo.peerId, localRepairInfo.id);
      return result;
    }
  }

  return false;
}

async function repairMessageMedia(peerId: string, messageId: number) {
  const type = getEntityTypeById(peerId);
  const inputChannel = buildInputChannelFromLocalDb(peerId);
  if (!inputChannel) return false;
  const result = await invokeRequest(
    type === 'channel'
      ? new GramJs.channels.GetMessages({
        channel: inputChannel,
        id: [new GramJs.InputMessageID({ id: messageId })],
      })
      : new GramJs.messages.GetMessages({
        id: [new GramJs.InputMessageID({ id: messageId })],
      }),
    {
      shouldIgnoreErrors: true,
    },
  );

  if (!result || result instanceof GramJs.messages.MessagesNotModified) return false;

  if (inputChannel && 'pts' in result) {
    updateChannelState(peerId, result.pts);
  }

  const message = result.messages[0];
  if (message instanceof GramJs.MessageEmpty) return false;

  processMessageAndUpdateThreadInfo(message);

  const apiMessage = buildApiMessage(message);
  if (apiMessage) {
    sendApiUpdate({
      '@type': 'updateMessage',
      chatId: apiMessage.chatId,
      id: apiMessage.id,
      message: apiMessage,
    });
  }
  return true;
}

async function repairStoryMedia(peerId: string, storyId: number) {
  const peer = buildInputPeerFromLocalDb(peerId);
  if (!peer) return false;

  const result = await invokeRequest(new GramJs.stories.GetStoriesByID({
    peer,
    id: [storyId],
  }), {
    shouldIgnoreErrors: true,
  });
  if (!result) return false;

  result.stories.forEach((story) => {
    const apiStory = buildApiStory(peerId, story);
    if (!apiStory || 'isDeleted' in apiStory) return;

    addStoryToLocalDb(story, peerId);
    sendApiUpdate({
      '@type': 'updateStory',
      peerId,
      story: apiStory,
    });
  });
  return true;
}

export function setForceHttpTransport(forceHttpTransport: boolean) {
  client.setForceHttpTransport(forceHttpTransport);
}

export function setAllowHttpTransport(allowHttpTransport: boolean) {
  client.setAllowHttpTransport(allowHttpTransport);
}

export function setShouldDebugExportedSenders(value: boolean) {
  client.setShouldDebugExportedSenders(value);
}

export function requestChannelDifference(channelId: string) {
  scheduleGetChannelDifference(channelId);
}
