import axios from 'axios';
import { UserSubscription } from '../core/users/User';

type RequestData = {
  event: string;
  payload: Record<string, any>;
  userId: string;
  email?: string;
};

export class Notifications {
  private static instance: Notifications;

  static getInstance(): Notifications {
    if (Notifications.instance) {
      return Notifications.instance;
    }

    Notifications.instance = new Notifications();

    return Notifications.instance;
  }

  subscriptionChanged({ userId, subscription }: { userId: string; subscription: UserSubscription }): Promise<void> {
    return this.post({ event: 'SUBSCRIPTION_CHANGED', userId, payload: subscription });
  }

  private async post(data: RequestData): Promise<void> {
    try {
      const res = await axios.post(process.env.NOTIFICATIONS_URL as string, data, {
        headers: { 'X-API-KEY': process.env.NOTIFICATIONS_API_KEY as string },
      });
      if (res.status !== 201)
        console.warn(
          `Post to notifications service failed with status ${res.status}. Data: ${JSON.stringify(data, null, 2)}`,
        );
    } catch (err) {
      console.warn(
        `Post to notifications service failed with error ${(err as Error).message}. Data: ${JSON.stringify(
          data,
          null,
          2,
        )}`,
      );
    }
  }
}
