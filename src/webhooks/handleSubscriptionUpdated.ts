import { FastifyLoggerInstance } from 'fastify';
import Stripe from 'stripe';
import { FREE_PLAN_BYTES_SPACE } from '../constants';
import CacheService from '../services/CacheService';
import { Notifications } from '../services/NotificationService';
import { PaymentService, PriceMetadata } from '../services/PaymentService';
import { StorageService } from '../services/StorageService';
import { UsersService } from '../services/UsersService';

export default async function handleSubscriptionUpdated(
  storageService: StorageService,
  usersService: UsersService,
  paymentService: PaymentService,
  subscription: Stripe.Subscription,
  cacheService: CacheService,
  log: FastifyLoggerInstance,
): Promise<void> {
  const customerId = subscription.customer as string;
  const { uuid } = await usersService.findUserByCustomerID(customerId);

  const bytesSpace =
    subscription.status === 'canceled'
      ? FREE_PLAN_BYTES_SPACE
      : parseInt((subscription.items.data[0].price.metadata as unknown as PriceMetadata).maxSpaceBytes);

  try {
    await cacheService.clearSubscription(customerId);
  } catch (err) {
    log.error(`Error in handleSubscriptionUpdated after trying to clear ${customerId} subscription`);
  }

  await storageService.changeStorage(uuid, bytesSpace);
  const updatedSubscription = await paymentService.getUserSubscription(customerId);
  return Notifications.getInstance().subscriptionChanged({
    userId: uuid,
    subscription: updatedSubscription,
  });
}
