import { FastifyLoggerInstance } from 'fastify';
import { FREE_INDIVIDUAL_TIER, FREE_PLAN_BYTES_SPACE } from '../constants';
import CacheService from '../services/CacheService';
import { StorageService, updateUserTier } from '../services/StorageService';
import { UsersService } from '../services/UsersService';
import { AppConfig } from '../config';

export default async function handleSubscriptionCanceled(
  storageService: StorageService,
  usersService: UsersService,
  customerId: string,
  cacheService: CacheService,
  log: FastifyLoggerInstance,
  config: AppConfig,
): Promise<void> {
  const { uuid } = await usersService.findUserByCustomerID(customerId);
  try {
    await cacheService.clearSubscription(customerId);
  } catch (err) {
    log.error(`Error in handleSubscriptionCanceled after trying to clear ${customerId} subscription`);
  }

  try {
    await updateUserTier(uuid, FREE_INDIVIDUAL_TIER, config);
  } catch (err) {
    log.error(
      `Error while updating user tier: uuid: ${uuid} `,
    );
    log.error(err);
    throw err;
  }
  
  return storageService.changeStorage(uuid, FREE_PLAN_BYTES_SPACE);
}
