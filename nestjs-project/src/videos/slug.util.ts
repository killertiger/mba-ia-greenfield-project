import { customAlphabet } from 'nanoid';
import { VIDEO_SLUG } from './videos.constants';

const generate = customAlphabet(VIDEO_SLUG.ALPHABET, VIDEO_SLUG.LENGTH);

export function generateVideoSlug(): string {
  return generate();
}
