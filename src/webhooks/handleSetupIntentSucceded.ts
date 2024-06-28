import Stripe from 'stripe';
import { PaymentService } from '../services/PaymentService';

type SubscriptionType = 'individual' | 'business';

export default async function handleSetupIntentSucceded(
  setupIntent: Stripe.SetupIntent,
  paymentService: PaymentService,
): Promise<void> {
  const customerId = setupIntent.customer as string;
  const paymentMethodId = setupIntent.payment_method as string;
  const setupIntentMetdata = setupIntent.metadata as Stripe.Metadata;
  
  const subscriptionType: SubscriptionType = setupIntentMetdata?.subscriptionType as SubscriptionType;
  const setupSubscriptionPayment = subscriptionType === 'business' || subscriptionType === 'individual';

  if (setupSubscriptionPayment) {
    await paymentService.updateSubscriptionPaymentMethod(customerId, paymentMethodId, subscriptionType);
  }
}
