export interface User {
  id: string;
  customerId: string;
  uuid: string;
  lifetime?: boolean;
}

export type UserSubscription =
  | { type: 'free' | 'lifetime' }
  | {
      type: 'subscription';
      amount: number;
      currency: string;
      amountAfterCoupon?: number;
      interval: 'year' | 'month';
      nextPayment: number;
      priceId: string;
      planId?: string;
      subscriptionType: 'individual' | 'business',
    };
