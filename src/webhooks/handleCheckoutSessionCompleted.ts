import axios from 'axios';
import { FastifyLoggerInstance } from 'fastify';
import Stripe from 'stripe';
import { type AppConfig } from '../config';
import CacheService from '../services/CacheService';
import { PaymentService, PriceMetadata } from '../services/PaymentService';
import { createOrUpdateUser, updateUserTier } from '../services/StorageService';
import { UsersService } from '../services/UsersService';

export default async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  usersService: UsersService,
  paymentService: PaymentService,
  log: FastifyLoggerInstance,
  cacheService: CacheService,
  config: AppConfig,
): Promise<void> {
  if (session.payment_status !== 'paid') {
    log.info(`Checkout processed without action, ${session.customer_email} has not paid successfully`);
    return;
  }

  const lineItems = await paymentService.getLineItems(session.id);

  const price = lineItems.data[0].price;

  if (!price) {
    log.error(`Checkout session completed does not contain price, customer: ${session.customer_email}`);
    return;
  }

  if (!price.metadata.maxSpaceBytes) {
    log.error(
      `Checkout session completed with a price without maxSpaceBytes as metadata. customer: ${session.customer_email}`,
    );
    return;
  }

  const { maxSpaceBytes } = price.metadata as PriceMetadata;

  const customer = await paymentService.getCustomer(session.customer as string);
  if (customer.deleted) {
    log.error(
      `Customer object could not be retrieved in checkout session completed handler with id ${session.customer}`,
    );
    return;
  }

  let user: { uuid: string };
  try {
    const res = await createOrUpdateUser(maxSpaceBytes, customer.email as string, config);
    user = res.data.user;
  } catch (err) {
    log.error(
      `Error while creating or updating user in checkout session completed handler, email: ${session.customer_email}`,
    );
    log.error(err);

    throw err;
  }

  try {
    await updateUserTier(user.uuid, price.product as string, config);
  } catch (err) {
    log.error(
      `Error while updating user tier: email: ${session.customer_email}, planId: ${price.product} `,
    );
    log.error(err);

    throw err;
  }

  try {
    const { customerId } = await usersService.findUserByUuid(user.uuid);
    if ((price.metadata as PriceMetadata).planType === 'one_time') {
      await usersService.updateUser(customerId, {
        lifetime: (price.metadata as PriceMetadata).planType === 'one_time',
      });
    }
  } catch {
    await usersService.insertUser({
      customerId: customer.id,
      uuid: user.uuid,
      lifetime: (price.metadata as PriceMetadata).planType === 'one_time',
    });
  }
  try {
    await cacheService.clearSubscription(customer.id);
  } catch (err) {
    log.error(`Error in handleCheckoutSessionCompleted after trying to clear ${customer.id} subscription`);
  }
}
