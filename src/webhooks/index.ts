import { FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { type AppConfig } from '../config';
import { StorageService } from '../services/StorageService';
import { UsersService } from '../services/UsersService';
import handleSubscriptionCanceled from './handleSubscriptionCanceled';
import handleSubscriptionUpdated from './handleSubscriptionUpdated';
import { PaymentService } from '../services/PaymentService';
import handleCheckoutSessionCompleted from './handleCheckoutSessionCompleted';
import CacheService from '../services/CacheService';
import handleLifetimeRefunded from './handleLifetimeRefunded';
import handleSetupIntentSucceded from './handleSetupIntentSucceded';

export default function (
  stripe: Stripe,
  storageService: StorageService,
  usersService: UsersService,
  paymentService: PaymentService,
  config: AppConfig,
  cacheService: CacheService,
) {
  return async function (fastify: FastifyInstance) {
    fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, function (req, body, done) {
      done(null, body);
    });

    fastify.post<{ Body: Buffer }>('/webhook', async (req, rep) => {
      const sig = req.headers['stripe-signature'] as string;

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, config.STRIPE_WEBHOOK_KEY);
      } catch (err) {
        if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
          fastify.log.info('Stripe event could not be verified');
          return rep.status(401).send();
        } else {
          throw err;
        }
      }
      fastify.log.info(`Stripe event received: ${event.type}, id: ${event.id}`);

      switch (event.type) {
        case 'customer.subscription.deleted':
          await handleSubscriptionCanceled(
            storageService,
            usersService,
            paymentService,
            event.data.object as Stripe.Subscription,
            cacheService,
            fastify.log,
            config,
          );
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(
            storageService,
            usersService,
            event.data.object as Stripe.Subscription,
            cacheService,
            paymentService,
            fastify.log,
            config,
          );
          break;
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(
            event.data.object as Stripe.Checkout.Session,
            stripe,
            usersService,
            paymentService,
            fastify.log,
            cacheService,
            config,
          );
          break;
        case 'setup_intent.succeeded':
          await handleSetupIntentSucceded(
            event.data.object as Stripe.SetupIntent,
            paymentService,
          );
          break;
        case 'checkout.session.async_payment_succeeded':
          await handleCheckoutSessionCompleted(
            event.data.object as Stripe.Checkout.Session,
            stripe,
            usersService,
            paymentService,
            fastify.log,
            cacheService,
            config,
          );
          break;
        case 'charge.refunded':
          await handleLifetimeRefunded(
            storageService,
            usersService,
            (event.data.object as Stripe.Charge).customer as string,
            cacheService,
            fastify.log,
            config,
          );
          break;
        default:
          fastify.log.info(`No handler registered for event: ${event.type}, id: ${event.id}`);
      }

      return rep.status(204).send();
    });
  };
}
