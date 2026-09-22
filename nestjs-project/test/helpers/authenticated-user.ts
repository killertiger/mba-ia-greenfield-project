import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AuthService } from '../../src/auth/auth.service';
import { Channel } from '../../src/channels/entities/channel.entity';

interface ConfirmationMailer {
  sendConfirmationEmail(
    email: string,
    name: string,
    token: string,
  ): Promise<void>;
}

export interface AuthenticatedUser {
  userId: string;
  channelId: string;
  email: string;
  accessToken: string;
}

/**
 * Registers, confirms and logs in a user, returning its access token and channel.
 *
 * The confirmation token is captured by spying on MailService (the pattern used
 * by auth.e2e-spec.ts) instead of reading the Mailpit inbox — fewer moving parts
 * and no dependency on inbox state between suites.
 */
export async function createAuthenticatedUser(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<AuthenticatedUser> {
  const authService = app.get(AuthService);
  const mailService = (
    authService as unknown as { mailService: ConfirmationMailer }
  ).mailService;

  let confirmationToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email, _name, token) => {
      confirmationToken = token;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password })
    .expect(201);

  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token: confirmationToken })
    .expect(204);

  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);

  const dataSource = app.get(DataSource);
  const channel = await dataSource
    .getRepository(Channel)
    .createQueryBuilder('channel')
    .innerJoin('users', 'user', 'user.id = channel.user_id')
    .where('user.email = :email', { email })
    .getOneOrFail();

  return {
    userId: channel.user_id,
    channelId: channel.id,
    email,
    accessToken: (login.body as { access_token: string }).access_token,
  };
}
