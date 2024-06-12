import { FastifyLoggerInstance } from 'fastify';
import Stripe from 'stripe';
import { FREE_INDIVIDUAL_TIER, FREE_PLAN_BYTES_SPACE } from '../constants';
import CacheService from '../services/CacheService';
import { PaymentService, PriceMetadata } from '../services/PaymentService';
import { StorageService, updateUserTier } from '../services/StorageService';
import { UsersService } from '../services/UsersService';
import { AppConfig } from '../config';

export default async function handleSubscriptionUpdated(
  storageService: StorageService,
  usersService: UsersService,
  subscription: Stripe.Subscription,
  eventPreviousAttributes: any,
  cacheService: CacheService,
  paymentService: PaymentService,
  log: FastifyLoggerInstance,
  config: AppConfig,
): Promise<void> {
  const customerId = subscription.customer as string;
  const productId = subscription.items.data[0].price.product as string;
  const previousPaymentMethod = eventPreviousAttributes?.default_payment_method as Stripe.PaymentMethod;
  const defaultPaymentMethod = subscription?.default_payment_method;
  
  const { metadata : productMetadata } = await paymentService.getProduct(productId);

  if (defaultPaymentMethod && previousPaymentMethod) {
    const { metadata: defaultPaymentMetadata } = await paymentService.getPaymentMethod(defaultPaymentMethod);

    if (defaultPaymentMetadata && defaultPaymentMetadata.type) {
      const productType = productMetadata.type ?? 'individual';
      const paymentType = defaultPaymentMetadata.type;

      if (productType !== paymentType) {
        const previousPaymentMethodId = typeof previousPaymentMethod == 'string'
          ? previousPaymentMethod
          : previousPaymentMethod.id;
        const type = productType == 'business' ? 'B2B' : 'individual';
        await paymentService.updateSubscriptionPaymentMethod(customerId, previousPaymentMethodId, type);
        return;
      }
    }
  }

  const { uuid, lifetime } = await usersService.findUserByCustomerID(customerId);
  if (lifetime) {
    return;
  }

  const productType = productMetadata?.type === 'business' ? 'B2B' : 'individual';
  try {
    await cacheService.clearSubscription(customerId, productType);
  } catch (err) {
    log.error(`Error in handleSubscriptionUpdated after trying to clear ${customerId} subscription`);
  }

  if (productType == 'B2B') {
    const customer = await paymentService.getCustomer(customerId);
    if (customer.deleted) {
      log.error(
        `Customer object could not be retrieved in subscription updated handler with id ${customer.id}`,
      );
      return;
    }
    const { maxSpaceBytes: priceMaxSpaceBytes } = subscription.items.data[0].price.metadata as PriceMetadata;
    const amountOfSeats = subscription.items.data[0]!.quantity!;

    const totalSpaceBytes = parseInt(priceMaxSpaceBytes) * amountOfSeats;
    return usersService.updateWorkspaceStorage(uuid, totalSpaceBytes);
  }

  const isSubscriptionCanceled = subscription.status === 'canceled';
  const bytesSpace = isSubscriptionCanceled
    ? FREE_PLAN_BYTES_SPACE
    : parseInt((subscription.items.data[0].price.metadata as unknown as PriceMetadata).maxSpaceBytes);

  const planId = isSubscriptionCanceled ? FREE_INDIVIDUAL_TIER : productId;
  try {
    await updateUserTier(uuid, planId, config);
  } catch (err) {
    log.error(`Error while updating user tier: uuid: ${uuid} `);
    log.error(err);
    throw err;
  }

  return storageService.changeStorage(uuid, bytesSpace);
}
