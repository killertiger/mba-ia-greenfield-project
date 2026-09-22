import { HttpAdapterHost } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { MailerService } from '@nestjs-modules/mailer';
import { VideoProcessingProcessor } from '../video-processing/video-processing.processor';
import { VideoProcessingService } from '../video-processing/video-processing.service';
import { WorkerModule } from './worker.module';

/**
 * The module is only compiled, never booted: `init()` would start the BullMQ
 * worker, which then waits on the queue forever and hangs the test run.
 */
describe('WorkerModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  it('wires the processing service and the queue consumer', () => {
    expect(module.get(VideoProcessingService)).toBeDefined();
    expect(module.get(VideoProcessingProcessor)).toBeDefined();
  });

  it('has no HTTP layer', () => {
    // The token itself always exists (Nest core registers it); what matters is
    // that nothing in this graph ever attached an adapter to it.
    const adapterHost = module.get(HttpAdapterHost, { strict: false });
    expect(adapterHost.httpAdapter).toBeUndefined();
  });

  it('does not pull in the mailer', () => {
    expect(() => module.get(MailerService, { strict: false })).toThrow();
  });
});
