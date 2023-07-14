import Stripe from 'stripe';
import { DisplayPrice } from '../core/users/DisplayPrice';
import { User, UserSubscription } from '../core/users/User';

type Customer = Stripe.Customer;
type CustomerId = Customer['id'];
type CustomerEmail = Customer['email'];

type Price = Stripe.Price;
type PriceId = Price['id'];

type Subscription = Stripe.Subscription;
type SubscriptionId = Subscription['id'];

type Invoice = Stripe.Invoice;

type SetupIntent = Stripe.SetupIntent;

type PaymentMethod = Stripe.PaymentMethod;

type CustomerSource = Stripe.CustomerSource;

type HasUserAppliedCouponResponse = {
  elegible: boolean;
  reason?: Reason;
};

export type Reason = {
  name: 'prevent-cancellation';
};

const reasonFreeMonthsMap: Record<Reason['name'], number> = {
  'prevent-cancellation': 3,
};

export type PriceMetadata = {
  maxSpaceBytes: string;
  planType: 'subscription' | 'one_time';
};

export class PaymentService {
  private readonly provider: Stripe;

  constructor(provider: Stripe) {
    this.provider = provider;
  }

  async createCustomer(payload: Stripe.CustomerCreateParams): Promise<Stripe.Customer> {
    const customer = await this.provider.customers.create(payload);

    return customer;
  }

  async subscribe(customerId: CustomerId, priceId: PriceId): Promise<{ maxSpaceBytes: number; recurring: boolean }> {
    const price = await this.provider.prices.retrieve(priceId);
    const isRecurring = price.type === 'recurring';

    if (isRecurring) {
      await this.provider.subscriptions.create({
        customer: customerId,
        items: [
          {
            price: priceId,
          },
        ],
      });
    } else {
      await this.provider.invoiceItems.create({
        customer: customerId,
        price: priceId,
        description: 'One-time charge',
      });
      const invoice = await this.provider.invoices.create({
        customer: customerId,
        auto_advance: false,
        pending_invoice_items_behavior: 'include',
      });

      await this.provider.invoices.pay(invoice.id, {
        paid_out_of_band: true,
      });
    }

    return { maxSpaceBytes: parseInt(price.metadata.maxSpaceBytes), recurring: isRecurring };
  }

  async cancelSubscription(subscriptionId: SubscriptionId): Promise<void> {
    await this.provider.subscriptions.del(subscriptionId, {});
  }

  async getActiveSubscriptions(customerId: CustomerId): Promise<Subscription[]> {
    const res = await this.provider.subscriptions.list({
      customer: customerId,
      expand: ['data.default_payment_method', 'data.default_source'],
    });

    return res.data;
  }

  async updateSubscriptionByReason(customerId: CustomerId, priceId: PriceId, reason: Reason) {
    let trialEnd = 0;

    const { data } = await this.provider.subscriptions.list({
      customer: customerId,
      status: 'active',
    });
    const [lastActiveSub] = data;

    if (reason.name in reasonFreeMonthsMap) {
      const date = new Date(lastActiveSub.current_period_end * 1000);
      trialEnd = date.setMonth(date.getMonth() + reasonFreeMonthsMap[reason.name]);
    }

    return this.updateSubscriptionPrice(customerId, priceId, undefined, {
      trial_end: trialEnd === 0 ? undefined : Math.floor(trialEnd / 1000),
      metadata: { reason: reason.name },
    });
  }

  async updateSubscriptionPrice(
    customerId: CustomerId,
    priceId: PriceId,
    couponCode?: string,
    additionalOptions: Partial<Stripe.SubscriptionUpdateParams> = {},
  ): Promise<Subscription> {
    const individualActiveSubscription = await this.findIndividualActiveSubscription(customerId);
    const updatedSubscription = await this.provider.subscriptions.update(individualActiveSubscription.id, {
      cancel_at_period_end: false,
      proration_behavior: 'create_prorations',
      coupon: couponCode ? couponCode : undefined,
      items: [
        {
          id: individualActiveSubscription.items.data[0].id,
          price: priceId,
        },
      ],
      ...additionalOptions,
    });

    return updatedSubscription;
  }

  async updateSubscriptionPaymentMethod(
    customerId: CustomerId,
    paymentMethod: PaymentMethod['id'],
  ): Promise<Subscription> {
    const individualActiveSubscription = await this.findIndividualActiveSubscription(customerId);
    const updatedSubscription = await this.provider.subscriptions.update(individualActiveSubscription.id, {
      default_payment_method: paymentMethod,
    });

    return updatedSubscription;
  }

  async getCustomersByEmail(customerEmail: CustomerEmail): Promise<Customer[]> {
    const res = await this.provider.customers.list({ email: customerEmail as string });

    return res.data;
  }

  async getInvoicesFromUser(
    customerId: CustomerId,
    pagination: { limit?: number; startingAfter?: string },
  ): Promise<Invoice[]> {
    const res = await this.provider.invoices.list({
      customer: customerId,
      limit: pagination.limit,
      starting_after: pagination.startingAfter,
    });

    return res.data;
  }

  async isUserElegibleForTrial(user: User, reason: Reason): Promise<HasUserAppliedCouponResponse> {
    const { lifetime, customerId } = user;

    if (lifetime) {
      return {
        elegible: false,
      };
    }

    const userSubscriptions = await this.provider.subscriptions.list({
      customer: customerId,
      status: 'all',
    });

    const isFreeTrialAlreadyApplied = userSubscriptions.data.some(
      (invoice) => invoice.metadata && invoice.metadata.reason === reason.name,
    );

    return isFreeTrialAlreadyApplied ? { elegible: false } : { elegible: true };
  }

  async applyFreeTrialToUser(user: User, reason: Reason) {
    const { customerId } = user;
    const hasCouponApplied = await this.isUserElegibleForTrial(user, reason);
    if (hasCouponApplied.elegible) {
      const subscription = await this.findIndividualActiveSubscription(customerId);

      await this.updateSubscriptionByReason(customerId, subscription.items.data[0].plan.id, reason);

      return true;
    } else {
      throw new CouponCodeError('User already applied coupon');
    }
  }

  getSetupIntent(customerId: string): Promise<SetupIntent> {
    return this.provider.setupIntents.create({ customer: customerId, usage: 'off_session' });
  }

  /*
   *  When a stripe subscription is going to be charged
   *  subscription.default_payment_method takes precedence over
   *  subscription.default_source that precedence over
   *  customer.invoice_settings.default_payment_method that precedence over
   *  customer.default_source
   */
  async getDefaultPaymentMethod(customerId: string): Promise<PaymentMethod | CustomerSource | null> {
    const subscriptions = await this.getActiveSubscriptions(customerId);
    const subscriptionWithDefaultPaymentMethod = subscriptions.find(
      (subscription) => subscription.default_payment_method,
    );
    if (subscriptionWithDefaultPaymentMethod)
      return subscriptionWithDefaultPaymentMethod.default_payment_method as PaymentMethod;

    const subscriptionWithDefaultSource = subscriptions.find((subscription) => subscription.default_source);
    if (subscriptionWithDefaultSource) return subscriptionWithDefaultSource.default_source as CustomerSource;
    const customer = await this.provider.customers.retrieve(customerId, {
      expand: ['default_source', 'invoice_settings.default_payment_method'],
    });

    if (customer.deleted) return null;

    return (
      (customer.invoice_settings.default_payment_method as PaymentMethod) ?? (customer.default_source as CustomerSource)
    );
  }

  async getUserSubscription(customerId: CustomerId): Promise<UserSubscription> {
    let subscription;
    try {
      subscription = await this.findIndividualActiveSubscription(customerId);
    } catch (err) {
      if (err instanceof NotFoundSubscriptionError) {
        return { type: 'free' };
      } else {
        throw err;
      }
    }

    const upcomingInvoice = await this.provider.invoices.retrieveUpcoming({ customer: customerId });

    const { price } = subscription.items.data[0];

    return {
      type: 'subscription',
      amount: price.unit_amount!,
      currency: price.currency,
      interval: price.recurring!.interval as 'year' | 'month',
      nextPayment: subscription.current_period_end,
      amountAfterCoupon: upcomingInvoice.total,
      priceId: price.id,
    };
  }

  async getPrices(): Promise<DisplayPrice[]> {
    const res = await this.provider.prices.search({
      query: 'metadata["show"]:"1" active:"true"',
      limit: 100,
    });

    return res.data
      .filter((price) => price.metadata.maxSpaceBytes)
      .map((price) => ({
        id: price.id,
        currency: price.currency,
        amount: price.unit_amount!,
        bytes: parseInt(price.metadata.maxSpaceBytes),
        interval: price.type === 'one_time' ? 'lifetime' : (price.recurring!.interval as 'year' | 'month'),
      }));
  }

  async getPaypalSetupIntent({
    priceId,
    coupon,
    user,
  }: {
    priceId: string;
    coupon?: string;
    user: Record<'name' | 'email' | 'uuid', string>;
  }): Promise<Stripe.SetupIntent> {
    const prices = await this.getPrices();
    const product = prices.find((price) => price.id === priceId);

    if (!product) throw new Error('The product does not exist');

    const metadata = {
      email: user.email,
      name: user.name || 'My Internxt',
      uuid: user.uuid,
      priceId: priceId,
      space: String(product?.bytes),
      interval: String(product?.interval),
      ...(coupon && { coupon: coupon }),
    };

    const setupIntent = await this.provider.setupIntents.create({
      payment_method_types: ['paypal'],
      payment_method_data: {
        type: 'paypal',
      },
      metadata: metadata,
    });

    return setupIntent;
  }

  async getCheckoutSession({
    priceId,
    successUrl,
    cancelUrl,
    prefill,
    mode,
    trialDays,
    couponCode,
  }: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    prefill: User | string;
    mode: Stripe.Checkout.SessionCreateParams.Mode;
    trialDays?: number;
    couponCode?: string;
  }): Promise<Stripe.Checkout.Session> {
    const subscriptionData = trialDays ? { subscription_data: { trial_period_days: trialDays } } : {};
    const invoiceCreation = mode === 'payment' && { invoice_creation: { enabled: true } };
    const prices = await this.getPrices();
    const product = prices.find((price) => price.id === priceId);

    if (!product) throw new Error('The product does not exist');

    const paymentMethods: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] =
      product?.interval === 'lifetime'
        ? ['card', 'bancontact', 'ideal', 'sofort', 'paypal']
        : ['card', 'bancontact', 'ideal', 'sofort'];

    const checkout = await this.provider.checkout.sessions.create({
      payment_method_types: paymentMethods,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer: typeof prefill === 'string' ? undefined : prefill?.customerId,
      customer_email: typeof prefill === 'string' ? prefill : undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      mode,
      discounts: couponCode ? [{ coupon: couponCode }] : undefined,
      allow_promotion_codes: couponCode ? undefined : true,
      billing_address_collection: 'required',
      ...invoiceCreation,
      ...subscriptionData,
    });

    return checkout;
  }

  async getLineItems(checkoutSessionId: string) {
    return this.provider.checkout.sessions.listLineItems(checkoutSessionId);
  }

  getCustomer(customerId: CustomerId) {
    return this.provider.customers.retrieve(customerId);
  }

  private async findIndividualActiveSubscription(customerId: CustomerId): Promise<Subscription> {
    const activeSubscriptions = await this.getActiveSubscriptions(customerId);

    const individualActiveSubscription = activeSubscriptions.find(
      (subscription) => subscription.items.data[0].price.metadata.is_teams !== '1',
    );
    if (!individualActiveSubscription) {
      throw new NotFoundSubscriptionError('There is no individual subscription to update');
    }

    return individualActiveSubscription;
  }
}

class NotFoundSubscriptionError extends Error {}
export class CouponCodeError extends Error {
  constructor(message: string) {
    super(message);

    Object.setPrototypeOf(this, CouponCodeError.prototype);
  }
}
