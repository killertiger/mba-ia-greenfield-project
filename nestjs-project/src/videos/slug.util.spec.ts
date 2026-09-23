import { generateVideoSlug } from './slug.util';

describe('generateVideoSlug', () => {
  it('should return 11 characters from [0-9A-Za-z]', () => {
    const slug = generateVideoSlug();

    expect(slug).toMatch(/^[0-9A-Za-z]{11}$/);
  });

  it('should return distinct values across calls', () => {
    const slugs = new Set(Array.from({ length: 1000 }, generateVideoSlug));

    expect(slugs.size).toBe(1000);
  });
});
