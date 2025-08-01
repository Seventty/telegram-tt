import { useEffect, useState } from '../../../../lib/teact/teact';
import { getActions } from '../../../../global';

import type { ApiAttachment, ApiMessage } from '../../../../api/types';

import { canReplaceMessageMedia, getAttachmentMediaType } from '../../../../global/helpers';
import { MEMO_EMPTY_ARRAY } from '../../../../util/memo';
import buildAttachment from '../helpers/buildAttachment';

import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

export default function useAttachmentModal({
  attachments,
  fileSizeLimit,
  setHtml,
  setAttachments,
  chatId,
  canSendAudios,
  canSendVideos,
  canSendPhotos,
  canSendDocuments,
  insertNextText,
  editedMessage,
  shouldSendInHighQuality,
}: {
  attachments: ApiAttachment[];
  fileSizeLimit: number;
  setHtml: (html: string) => void;
  setAttachments: (attachments: ApiAttachment[]) => void;
  chatId: string;
  canSendAudios?: boolean;
  canSendVideos?: boolean;
  canSendPhotos?: boolean;
  canSendDocuments?: boolean;
  insertNextText: VoidFunction;
  editedMessage: ApiMessage | undefined;
  shouldSendInHighQuality?: boolean;
}) {
  const lang = useLang();
  const { openLimitReachedModal, showAllowedMessageTypesNotification, showNotification } = getActions();
  const [shouldForceAsFile, setShouldForceAsFile] = useState<boolean>(false);
  const [shouldForceCompression, setShouldForceCompression] = useState<boolean>(false);

  const handleClearAttachments = useLastCallback(() => {
    setAttachments(MEMO_EMPTY_ARRAY);
    insertNextText();
  });

  const handleSetAttachments = useLastCallback(
    (newValue: ApiAttachment[] | ((current: ApiAttachment[]) => ApiAttachment[])) => {
      const newAttachments = typeof newValue === 'function' ? newValue(attachments) : newValue;
      if (!newAttachments.length) {
        handleClearAttachments();
        return;
      }

      if (newAttachments.some((attachment) => {
        const type = getAttachmentMediaType(attachment);

        return (type === 'audio' && !canSendAudios && !canSendDocuments)
          || (type === 'video' && !canSendVideos && !canSendDocuments)
          || (type === 'photo' && !canSendPhotos && !canSendDocuments)
          || (type === 'file' && !canSendDocuments);
      })) {
        showAllowedMessageTypesNotification({ chatId });
      } else if (newAttachments.some(({ size }) => size > fileSizeLimit)) {
        openLimitReachedModal({
          limit: 'uploadMaxFileparts',
        });
      } else {
        setAttachments(newAttachments);
        const shouldForce = newAttachments.some((attachment) => {
          const type = getAttachmentMediaType(attachment);

          return (type === 'audio' && !canSendAudios)
            || (type === 'video' && !canSendVideos)
            || (type === 'photo' && !canSendPhotos);
        });

        setShouldForceAsFile(Boolean(shouldForce && canSendDocuments));
        setShouldForceCompression(!canSendDocuments);
      }
    },
  );

  const handleAppendFiles = useLastCallback(async (files: File[], isSpoiler?: boolean) => {
    if (editedMessage) {
      const newAttachment = await buildAttachment(files[0].name, files[0]);
      const canReplace = editedMessage && canReplaceMessageMedia(editedMessage, newAttachment);

      if (editedMessage?.groupedId) {
        if (canReplace) {
          handleSetAttachments([newAttachment]);
        } else {
          showNotification({ message: lang('MediaReplaceInvalidError', undefined, { pluralValue: files.length }) });
        }
      } else {
        handleSetAttachments([newAttachment]);
      }
    } else {
      const newAttachments = await Promise.all(files.map((file) => (
        buildAttachment(file.name, file,
          { shouldSendAsSpoiler: isSpoiler || undefined, shouldSendInHighQuality })
      )));
      handleSetAttachments([...attachments, ...newAttachments]);
    }
  });

  const handleFileSelect = useLastCallback(async (files: File[]) => {
    if (editedMessage) {
      const newAttachment = await buildAttachment(files[0].name, files[0]);
      const canReplace = editedMessage && canReplaceMessageMedia(editedMessage, newAttachment);

      if (editedMessage?.groupedId) {
        if (canReplace) {
          handleSetAttachments([newAttachment]);
        } else {
          showNotification({ message: lang('MediaReplaceInvalidError', undefined, { pluralValue: files.length }) });
        }
      } else {
        handleSetAttachments([newAttachment]);
      }
    } else {
      const newAttachments = await Promise.all(files.map((file) =>
        buildAttachment(file.name, file, { shouldSendInHighQuality })));
      handleSetAttachments(newAttachments);
    }
  });

  const handleUpdateAttachmentsQuality = useLastCallback(async () => {
    const newAttachments = await Promise.all(attachments.map((attachment) =>
      buildAttachment(attachment.filename, attachment.blob, { shouldSendInHighQuality })));
    handleSetAttachments(newAttachments);
  });

  useEffect(() => {
    handleUpdateAttachmentsQuality();
  }, [shouldSendInHighQuality]);

  return {
    handleAppendFiles,
    handleFileSelect,
    onCaptionUpdate: setHtml,
    handleClearAttachments,
    handleSetAttachments,
    shouldForceCompression,
    shouldForceAsFile,
  };
}
