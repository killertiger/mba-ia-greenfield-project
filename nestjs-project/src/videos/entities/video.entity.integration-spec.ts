import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);

    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${++counter}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: `owner${counter}`,
      nickname: `owner${counter}`,
      user_id: user.id,
    });
  });

  function buildVideo(overrides: Partial<Video> = {}): Video {
    const id = randomUUID();
    return videoRepository.create({
      id,
      channel_id: channel.id,
      slug: `slug${String(++counter).padStart(7, '0')}`,
      title: 'clip',
      original_file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: '1024',
      storage_key: `videos/${id}/original.mp4`,
      part_size_bytes: 104857600,
      part_count: 1,
      ...overrides,
    });
  }

  it('should persist a video without status as draft', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject two videos with the same slug', async () => {
    await videoRepository.save(buildVideo({ slug: 'dupSlug0001' }));

    await expect(
      videoRepository.save(buildVideo({ slug: 'dupSlug0001' })),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);
  });

  it('should remove the videos of a channel when the channel is deleted', async () => {
    const saved = await videoRepository.save(buildVideo());

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    await expect(
      videoRepository.findOneBy({ id: saved.id }),
    ).resolves.toBeNull();
  });

  it('should persist a size above 2^31 bytes without loss', async () => {
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: '10737418240' }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe('10737418240');
  });

  it('should round-trip metadata as jsonb', async () => {
    const metadata = {
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrate: 867211,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      frameRate: '24/1',
    };
    const saved = await videoRepository.save(buildVideo({ metadata }));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.metadata).toEqual(metadata);
  });
});
