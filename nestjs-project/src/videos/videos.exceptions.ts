import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotInDraftException extends DomainException {
  constructor() {
    super('VIDEO_NOT_IN_DRAFT', 409, 'Video upload is no longer open');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

export class UploadPartsInvalidException extends DomainException {
  constructor() {
    super(
      'UPLOAD_PARTS_INVALID',
      422,
      'Uploaded parts are invalid or incomplete',
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super('UPLOAD_SIZE_MISMATCH', 422, 'Uploaded file size is invalid');
  }
}

export class InvalidPartNumbersException extends DomainException {
  constructor(message: string) {
    super('VALIDATION_ERROR', 400, message);
  }
}
