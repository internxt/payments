import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AppConfig } from './config';
import { UserNotFoundError, UsersService } from './services/UsersService';
import { PaymentService } from './services/PaymentService';
import fastifyJwt from '@fastify/jwt';
import { User } from './core/users/User';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rateLimit = require('fastify-rate-limit');

export default function (
  paymentService: PaymentService,
  usersService: UsersService,
  config: AppConfig,
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
      max: 30, // Modify this according to Stripe rate limit. Max 100 requests per second 
      timeWindow: '1 second',
    });
    fastify.addHook('onRequest', async (request, reply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        request.log.warn(`JWT verification failed with error: ${(err as Error).message}`);
        reply.status(401).send();
      }
    });

    fastify.get('/get-user-subscription', async (req, rep) => {
      let response: { planId: string, type: string, uuid: string };

      const user: User = await assertUser(req, rep);

      if (user.lifetime) {
        const invoices = await paymentService.getInvoicesFromUser(user.customerId, { limit: 100 })
        const oneTimePurchases = invoices.filter(invoice => invoice.paid && !invoice.subscription && invoice?.lines?.data[0]?.price?.type === 'one_time')
          .map(invoice => ({ price: invoice.lines.data[0].price, planId: invoice.lines.data[0].price?.product }))
        response = {
          planId: oneTimePurchases[0].planId as string,
          type: 'lifetime',
          uuid: user.uuid
        }
      } else {
        const subscription = await paymentService.getUserSubscription(user.customerId) as any;
        response = {
          planId: subscription.planId,
          type: subscription.type,
          uuid: user.uuid
        }
      }

      return response;
    });

  };
}
