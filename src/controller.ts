import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AppConfig } from './config';
import { UserNotFoundError, UsersService } from './services/UsersService';
import { CouponCodeError, PaymentService } from './services/PaymentService';
import fastifyJwt from '@fastify/jwt';
import { User, UserSubscription } from './core/users/User';
import CacheService from './services/CacheService';
import Stripe from 'stripe';
import {
  InvalidLicenseCodeError,
  LicenseCodeAlreadyAppliedError,
  LicenseCodesService,
} from './services/LicenseCodesService';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rateLimit = require('fastify-rate-limit');

type AllowedMethods = 'GET' | 'POST';

export const allowedCurrency = ['eur', 'usd'];

const allowedRoutes: {
  [key: string]: AllowedMethods[];
} = {
  '/prices': ['GET'],
  '/is-unique-code-available': ['GET'],
};

export default function (
  paymentService: PaymentService,
  usersService: UsersService,
  config: AppConfig,
  cacheService: CacheService,
  licenseCodesService: LicenseCodesService,
) {
  async function assertUser(req: FastifyRequest, rep: FastifyReply): Promise<User> {
    const { uuid } = req.user.payload;
    try {
      return await usersService.findUserByUuid(uuid);
    } catch (err) {
      if (err instanceof UserNotFoundError) {
        req.log.info(`User with uuid ${uuid} was not found`);
        return rep.status(404).send({ message: 'User not found' });
      }
      throw err;
    }
  }

  return async function (fastify: FastifyInstance) {
    fastify.register(fastifyJwt, { secret: config.JWT_SECRET });
    fastify.register(rateLimit, {
      max: 1000,
      timeWindow: '1 minute',
    });
    fastify.addHook('onRequest', async (request, reply) => {
      try {
        const config: { url?: string; method?: AllowedMethods } = request.context.config;
        if (
          config.method &&
          config.url &&
          allowedRoutes[config.url] &&
          allowedRoutes[config.url].includes(config.method)
        ) {
          return;
        }
        await request.jwtVerify();
      } catch (err) {
        request.log.warn(`JWT verification failed with error: ${(err as Error).message}`);
        reply.status(401).send();
      }
    });

    fastify.get<{ Querystring: { limit: number; starting_after?: string } }>(
      '/invoices',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { limit: { type: 'number', default: 10 }, starting_after: { type: 'string' } },
          },
        },
      },
      async (req, rep) => {
        const { limit, starting_after: startingAfter } = req.query;

        const user = await assertUser(req, rep);

        const invoices = await paymentService.getInvoicesFromUser(user.customerId, { limit, startingAfter });

        const invoicesMapped = invoices
          .filter(
            (invoice) =>
              invoice.created && invoice.invoice_pdf && invoice.lines?.data?.[0]?.price?.metadata?.maxSpaceBytes,
          )
          .map((invoice) => {
            return {
              id: invoice.id,
              created: invoice.created,
              pdf: invoice.invoice_pdf,
              bytesInPlan: invoice.lines.data[0].price!.metadata.maxSpaceBytes,
            };
          });

        return rep.send(invoicesMapped);
      },
    );

    fastify.delete('/subscriptions', async (req, rep) => {
      const user = await assertUser(req, rep);
      await usersService.cancelUserIndividualSubscriptions(user.customerId);

      return rep.status(204).send();
    });

    fastify.put<{ Body: { price_id: string; couponCode: string } }>(
      '/subscriptions',
      {
        schema: {
          body: {
            type: 'object',
            required: ['price_id'],
            properties: { price_id: { type: 'string' }, couponCode: { type: 'string' } },
          },
        },
      },
      async (req, rep) => {
        const { price_id: priceId, couponCode } = req.body;

        const user = await assertUser(req, rep);
        const userUpdated = await paymentService.updateSubscriptionPrice({
          customerId: user.customerId,
          priceId: priceId,
          couponCode: couponCode,
        });

        const updatedSubscription = await paymentService.getUserSubscription(user.customerId);
        return rep.send({
          userSubscription: updatedSubscription,
          request3DSecure: userUpdated.is3DSecureRequired,
          clientSecret: userUpdated.clientSecret,
        });
      },
    );

    fastify.get('/setup-intent', async (req, rep) => {
      const user = await assertUser(req, rep);
      const { client_secret: clientSecret } = await paymentService.getSetupIntent(user.customerId);

      return { clientSecret };
    });

    fastify.get('/default-payment-method', async (req, rep) => {
      const user = await assertUser(req, rep);
      return paymentService.getDefaultPaymentMethod(user.customerId);
    });

    fastify.get('/subscriptions', async (req, rep) => {
      let response: UserSubscription;

      const user: User = await assertUser(req, rep);

      let subscriptionInCache: UserSubscription | null | undefined;
      try {
        subscriptionInCache = await cacheService.getSubscription(user.customerId);
      } catch (err) {
        req.log.error(`Error while trying to retrieve ${user.customerId} subscription from cache`);
        req.log.error(err);
      }

      if (subscriptionInCache) {
        req.log.info(`Cache hit for ${user.customerId} subscription`);
        return subscriptionInCache;
      }

      if (user.lifetime) {
        response = { type: 'lifetime' };
      } else {
        response = await paymentService.getUserSubscription(user.customerId);
      }

      cacheService.setSubscription(user.customerId, response).catch((err) => {
        req.log.error(`Error while trying to set subscription cache for ${user.customerId}`);
        req.log.error(err);
      });

      return response;
    });

    function checkCurrency(currency?: string): { currencyValue: string; isError: boolean; errorMessage?: string } {
      let currencyValue: string;

      if (!currency) {
        currencyValue = 'eur';
      } else {
        const validatedCurrency = allowedCurrency.includes(currency.toLowerCase());
        if (!validatedCurrency) {
          return { currencyValue: '', isError: true, errorMessage: 'Bad request' };
        } else {
          currencyValue = currency.toLowerCase();
        }
      }

      return { currencyValue, isError: false };
    }

    fastify.get<{
      Querystring: { currency?: string };
      schema: {
        querystring: {
          type: 'object';
          properties: { currency: { type: 'string' } };
        };
      };
    }>('/prices', async (req, rep) => {
      const { currency } = req.query;

      const { currencyValue, isError, errorMessage } = checkCurrency(currency);

      if (isError) {
        return rep.status(400).send({ message: errorMessage });
      }

      return paymentService.getPrices(currencyValue);
    });

    fastify.get('/request-prevent-cancellation', async (req) => {
      const { uuid } = req.user.payload;
      try {
        const user = await usersService.findUserByUuid(uuid);

        return paymentService.isUserElegibleForTrial(user, {
          name: 'prevent-cancellation',
        });
      } catch (err) {
        const error = err as Error;
        req.log.error(
          `[REQUEST-PREVENT-CANCELLATION/ERROR]: Error for user ${uuid} ${error.message}. ${error.stack || 'NO STACK'}`,
        );
        throw err;
      }
    });

    fastify.put('/prevent-cancellation', async (req, rep) => {
      const { uuid } = req.user.payload;
      const user = await usersService.findUserByUuid(uuid);

      try {
        await paymentService.applyFreeTrialToUser(user, {
          name: 'prevent-cancellation',
        });
        return rep.status(200).send({ message: 'Coupon applied' });
      } catch (err) {
        if (err instanceof CouponCodeError) {
          return rep.status(403).send({ message: err.message });
        } else {
          req.log.error(err);
          return rep.status(500).send({ message: 'Internal server error' });
        }
      }
    });

    fastify.post<{
      Body: {
        price_id: string;
        success_url: string;
        coupon_code: string;
        cancel_url: string;
        customer_email: string;
        trial_days?: number;
        mode?: string;
        currency?: string;
      };
    }>(
      '/checkout-session',
      {
        schema: {
          body: {
            type: 'object',
            required: ['price_id', 'success_url', 'cancel_url', 'customer_email'],
            properties: {
              mode: { type: 'string' },
              price_id: { type: 'string' },
              trial_days: { type: 'number' },
              coupon_code: { type: 'string' },
              success_url: { type: 'string' },
              cancel_url: { type: 'string' },
              customer_email: { type: 'string' },
              currency: { type: 'string' },
            },
          },
        },
      },
      async (req, rep) => {
        const { uuid } = req.user.payload;
        const { price_id, success_url, cancel_url, customer_email, trial_days, mode, coupon_code, currency } = req.body;

        const { currencyValue, isError, errorMessage } = checkCurrency(currency);

        if (isError) {
          return rep.status(400).send({ message: errorMessage });
        }

        let user: User | undefined;

        try {
          user = await usersService.findUserByUuid(uuid);
        } catch (err) {
          req.log.info(`User with uuid ${uuid} not found in DB`);
        }

        const { id } = await paymentService.getCheckoutSession({
          priceId: price_id,
          successUrl: success_url,
          cancelUrl: cancel_url,
          prefill: user ?? customer_email,
          mode: (mode as Stripe.Checkout.SessionCreateParams.Mode) || 'subscription',
          trialDays: trial_days,
          couponCode: coupon_code,
          currency: currencyValue,
        });

        return { sessionId: id };
      },
    );

    fastify.get<{ Querystring: { code: string; provider: string } }>(
      '/is-unique-code-available',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: { code: { type: 'string' }, provider: { type: 'string' } },
          },
        },
        config: {
          rateLimit: {
            max: 5,
            timeWindow: '1 minute',
          },
        },
      },
      async (req, res) => {
        const { code, provider } = req.query;
        try {
          await licenseCodesService.isLicenseCodeAvailable(code, provider);
          return res.status(200).send({ message: 'Code is available' });
        } catch (error) {
          const err = error as Error;
          if (err instanceof LicenseCodeAlreadyAppliedError || err instanceof InvalidLicenseCodeError) {
            return res.status(404).send({ message: err.message });
          }

          req.log.error(`[LICENSE/CHECK/ERROR]: ${err.message}. STACK ${err.stack || 'NO STACK'}`);
          return res.status(500).send({ message: 'Internal Server Error' });
        }
      },
    );

    fastify.post<{
      Body: {
        code: string;
        provider: string;
      };
    }>(
      '/licenses',
      {
        schema: {
          body: {
            type: 'object',
            required: ['code', 'provider'],
            properties: {
              code: { type: 'string' },
              provider: { type: 'string' },
            },
          },
        },
        config: {
          rateLimit: {
            max: 5,
            timeWindow: '1 minute',
          },
        },
      },
      async (req, rep) => {
        const { email, uuid, name, lastname } = req.user.payload;
        const { code, provider } = req.body;

        try {
          await licenseCodesService.redeem({ email, uuid, name: `${name} ${lastname}` }, code, provider);

          return rep.status(200).send({ message: 'Code redeemed' });
        } catch (error) {
          const err = error as Error;

          if (err instanceof InvalidLicenseCodeError) {
            return rep.status(400).send({ message: err.message });
          }

          if (err instanceof LicenseCodeAlreadyAppliedError) {
            return rep.status(403).send({ message: err.message });
          }

          req.log.error(`[LICENSE/REDEEM/ERROR]: ${err.message}. STACK ${err.stack || 'NO STACK'}`);
          return rep.status(500).send({ message: 'Internal Server Error' });
        }
      },
    );
  };
}
