import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AppConfig } from './config';
import { UserNotFoundError, UsersService } from './services/UsersService';
import { PaymentService } from './services/PaymentService';
import fastifyJwt from '@fastify/jwt';
import { User, UserSubscription } from './core/users/User';
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
      max: 30, // Modify this according to Stripe rate limit, do we want to only get 30 of the  100 concurrent requests per second that stripe allows? This handles that  
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
        let response: UserSubscription;
  
        const user: User = await assertUser(req, rep);
  
        response = await paymentService.getUserSubscription(user.customerId);
  
        return response;
      });

  };
}
