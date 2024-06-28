import Stripe from 'stripe';
import { DisplayPrice } from '../core/users/DisplayPrice';
import { User, UserSubscription, UserType } from '../core/users/User';
import { ProductsRepository } from '../core/users/ProductsRepository';

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

interface ExtendedSubscription extends Subscription {
  product?: Stripe.Product;
}

export type Reason = {
  name: 'prevent-cancellation';
};

const commonPaymentMethodTypes: Record<string, Stripe.Checkout.SessionCreateParams.PaymentMethodType[]> = {
  usd: [],
  eur: ['bancontact', 'ideal', 'sofort'],
};

const additionalPaymentTypesForOneTime: Record<string, Stripe.Checkout.SessionCreateParams.PaymentMethodType[]> = {
  usd: [],
  eur: ['alipay', 'eps', 'giropay'],
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
  private readonly productsRepository: ProductsRepository;

  constructor(provider: Stripe, productsRepository: ProductsRepository) {
    this.provider = provider;
    this.productsRepository = productsRepository;
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

  async getActiveSubscriptions(customerId: CustomerId): Promise<ExtendedSubscription[]> {
    const res = await this.provider.subscriptions.list({
      customer: customerId,
      expand: ['data.default_payment_method', 'data.default_source', 'data.plan.product'],
    });

    const transformedData: ExtendedSubscription[] = res.data.map((subscription) => {
      const untypedSubscription = subscription as any;
      if ('plan' in untypedSubscription) {
        return {
          ...subscription,
          product: (untypedSubscription.plan as Stripe.Plan).product as Stripe.Product,
        };
      }
      return subscription;
    });

    return transformedData;
  }

  /**
   * Function to update the subscription that contains the basic params
   *
   * @param customerId - The customer id
   * @param priceId - The price id
   * @param additionalOptions - Additional options to update the subscription (all the options from Stripe.SubscriptionUpdateParams)
   * @returns The updated subscription
   */
  async updateSub({
    customerId,
    priceId,
    additionalOptions,
  }: {
    customerId: CustomerId;
    priceId: PriceId;
    couponCode?: string;
    additionalOptions?: Partial<Stripe.SubscriptionUpdateParams>;
  }) {
    const individualActiveSubscription = await this.findIndividualActiveSubscription(customerId);
    const updatedSubscription = await this.provider.subscriptions.update(individualActiveSubscription.id, {
      cancel_at_period_end: false,
      proration_behavior: 'none',
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

  /**
   *  Function to update the subscription with a freeTrial (prevent-cancellation flow)
   * @param customerId - The customer id
   * @param priceId - The price id
   * @param reason - The reason to update the subscription
   * @returns The updated subscription with the corresponding trial_end
   */
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

    return this.updateSub({
      customerId: customerId,
      priceId: priceId,
      additionalOptions: {
        trial_end: trialEnd === 0 ? undefined : Math.floor(trialEnd / 1000),
        metadata: { reason: reason.name },
      },
    });
  }

  /**
   * Function to update the subscription price (change the plan)
   * @param customerId - The customer id
   * @param priceId - The price id
   * @param couponCode - The coupon code
   * @returns updated subscription
   */
  async updateSubscriptionPrice({
    customerId,
    priceId,
    couponCode,
  }: {
    customerId: CustomerId;
    priceId: PriceId;
    couponCode: string;
  }) {
    let is3DSecureRequired = false;
    let clientSecret = '';
    const updatedSubscription = await this.updateSub({
      customerId: customerId,
      priceId: priceId,
      additionalOptions: {
        coupon: couponCode,
        billing_cycle_anchor: 'now',
      },
    });

    const getLatestInvoice = await this.provider.invoices.retrieve(updatedSubscription.latest_invoice as string);

    if (getLatestInvoice.payment_intent) {
      const getPaymentIntent: Stripe.PaymentIntent = await this.provider.paymentIntents.retrieve(
        getLatestInvoice.payment_intent as string,
      );
      if (
        getPaymentIntent.status === 'requires_action' &&
        getPaymentIntent.next_action?.type === 'use_stripe_sdk' &&
        getPaymentIntent.client_secret
      ) {
        is3DSecureRequired = true;
        clientSecret = getPaymentIntent.client_secret;
      }
    }

    return {
      is3DSecureRequired,
      clientSecret,
    };
  }

  async updateSubscriptionPaymentMethod(
    customerId: CustomerId,
    paymentMethodId: PaymentMethod['id'],
    subscriptionType: 'individual' | 'business' = 'individual',
  ): Promise<Subscription> {
    const { id: subscriptionId } = subscriptionType == 'business'
      ? await this.findB2BActiveSubscription(customerId)
      : await this.findIndividualActiveSubscription(customerId);

    if (!subscriptionId)
      throw new Error('Subscription not found');

    const { id, customer } = await this.provider.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    })

    if (!id || !customer)
      throw new Error('Payment method not attached');    

    return this.provider.subscriptions.update(subscriptionId, {
      default_payment_method: id,
    });
  }

  async getCustomersByEmail(customerEmail: CustomerEmail): Promise<Customer[]> {
    const res = await this.provider.customers.list({ email: customerEmail as string });

    return res.data;
  }

  async getPlanIdFromLastPayment(
    customerId: CustomerId,
    pagination: { limit?: number; startingAfter?: string },
  ): Promise<string | null> {
    const res = await this.provider.paymentIntents.list({
      customer: customerId,
      limit: pagination.limit,
      starting_after: pagination.startingAfter,
    });

    const lastPaymentIntent = res.data
      .filter((pi) => pi.status === 'succeeded')
      .sort((a, b) => b.created - a.created)
      .at(0);

    if (!lastPaymentIntent) {
      return null;
    }

    const checkout = await this.provider.checkout.sessions.list({ payment_intent: lastPaymentIntent.id });
    const checkoutLines = await this.provider.checkout.sessions.listLineItems(checkout.data[0].id);
    const productId = checkoutLines.data[0].price?.product;

    return productId as string;
  }

  async getInvoicesFromUser(
    customerId: CustomerId,
    pagination: { limit?: number; startingAfter?: string },
    subscriptionId?: SubscriptionId,
  ): Promise<Invoice[]> {
    const res = await this.provider.invoices.list({
      customer: customerId,
      limit: pagination.limit,
      starting_after: pagination.startingAfter,
      subscription: subscriptionId,
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

  getSetupIntent(customerId: string, metadata: Stripe.MetadataParam): Promise<SetupIntent> {
    return this.provider.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      metadata,
    });
  }

  /*
   *  When a stripe subscription is going to be charged
   *  subscription.default_payment_method takes precedence over
   *  subscription.default_source that precedence over
   *  customer.invoice_settings.default_payment_method that precedence over
   *  customer.default_source
   */
  async getDefaultPaymentMethod(
    customerId: CustomerId,
    subscriptionType: 'individual' | 'business' = 'individual',
  ): Promise<PaymentMethod | CustomerSource | null> {
    let subscriptions = await this.getActiveSubscriptions(customerId);
    if (subscriptions.length === 0)
      return null;

    subscriptions = subscriptionType == 'business'
      ? subscriptions.filter(subs => subs.product?.metadata?.type == "business")
      : subscriptions.filter(subs => subs.product?.metadata?.type != "business");

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

  getPaymentMethod(paymentMethod: string | Stripe.PaymentMethod): Promise<PaymentMethod> {
    return typeof paymentMethod == 'string'
      ? this.provider.paymentMethods.retrieve(paymentMethod)
      : this.provider.paymentMethods.retrieve(paymentMethod.id);
  }

  async getUserSubscription(customerId: CustomerId, userType?: UserType): Promise<UserSubscription> {
    let subscription;
    try {
      if (userType === UserType.Business) {
        subscription = await this.findBusinessActiveSubscription(customerId);
      } else {
        subscription = await this.findIndividualActiveSubscription(customerId);
      }
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
      planId: price?.product as string,
      userType,
    };
  }

  async getPrices(
    currency?: string,
    subscriptionType: 'business' | 'individual' = 'individual',
  ): Promise<DisplayPrice[]> {
    const currencyValue = currency ?? 'eur';

    const res = await this.provider.prices.search({
      query: `metadata["show"]:"1" active:"true" currency:"${currencyValue}"`,
      expand: ['data.currency_options', 'data.product'],
      limit: 100,
    });

    return res.data
      .filter((price) => {
        const priceProductType =
          ((price.product as Stripe.Product).metadata.type as 'business' | 'individual' | undefined) ?? 'individual';
        return (
          price.metadata.maxSpaceBytes &&
          price.currency_options &&
          price.currency_options[currencyValue].unit_amount &&
          priceProductType === subscriptionType
        );
      })
      .map((price) => {
        return {
          id: price.id,
          currency: currencyValue,
          amount: price.currency_options![currencyValue].unit_amount as number,
          bytes: parseInt(price.metadata.maxSpaceBytes),
          interval: price.type === 'one_time' ? 'lifetime' : (price.recurring!.interval as 'year' | 'month'),
        };
      });
  }

  async getPricesRaw(currency?: string, expandProduct = false): Promise<Stripe.Price[]> {
    const currencyValue = currency ?? 'eur';

    const expandOptions = ['data.currency_options'];

    if (expandProduct) {
      expandOptions.push('data.product');
    }

    const res = await this.provider.prices.search({
      query: `metadata["show"]:"1" active:"true" currency:"${currencyValue}"`,
      expand: expandOptions,
      limit: 100,
    });

    return res.data.filter(
      (price) =>
        price.metadata.maxSpaceBytes && price.currency_options && price.currency_options[currencyValue].unit_amount,
    );
  }

  private getPaymentMethodTypes(
    currency: string,
    isOneTime: boolean,
  ): Stripe.Checkout.SessionCreateParams.PaymentMethodType[] {
    const commonPaymentTypes = commonPaymentMethodTypes[currency];
    const additionalPaymentTypes = isOneTime ? additionalPaymentTypesForOneTime[currency] : [];

    return ['card', 'paypal', ...commonPaymentTypes, ...additionalPaymentTypes];
  }

  async getCheckoutSession({
    priceId,
    successUrl,
    cancelUrl,
    prefill,
    mode,
    trialDays,
    couponCode,
    currency,
    seats,
  }: {
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    prefill: User | string;
    mode: Stripe.Checkout.SessionCreateParams.Mode;
    trialDays?: number;
    couponCode?: string;
    currency?: string;
    seats?: number;
  }): Promise<Stripe.Checkout.Session> {
    const productCurrency = currency ?? 'eur';
    const subscriptionData = trialDays ? { subscription_data: { trial_period_days: trialDays } } : {};
    const invoiceCreation = mode === 'payment' && { invoice_creation: { enabled: true } };
    const prices = await this.getPricesRaw(productCurrency, true);
    const selectedPrice = prices.find((price) => price.id === priceId);
    const product = selectedPrice?.product as Stripe.Product;
    const paymentMethodTypes: Stripe.Checkout.SessionCreateParams.PaymentMethodType[] = this.getPaymentMethodTypes(
      productCurrency,
      selectedPrice?.type === 'one_time',
    );

    if (!selectedPrice) throw new Error('The product does not exist');

    let lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: priceId, quantity: 1 }];
    if (product.metadata?.type === 'business') {
      const minimumSeats = selectedPrice.metadata?.minimumSeats ? parseInt(selectedPrice.metadata.minimumSeats) : 1;
      const maximumSeats = selectedPrice.metadata?.maximumSeats
        ? parseInt(selectedPrice.metadata.maximumSeats)
        : undefined;
      let seatNumber = seats ?? minimumSeats;

      if (maximumSeats && seatNumber > maximumSeats) {
        seatNumber = maximumSeats;
      }

      lineItems = [
        {
          price: priceId,
          adjustable_quantity: {
            enabled: false,
          },
          quantity: seatNumber,
        },
      ];
    }

    const checkout = await this.provider.checkout.sessions.create({
      payment_method_types: paymentMethodTypes,
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer: typeof prefill === 'string' ? undefined : prefill?.customerId,
      customer_email: typeof prefill === 'string' ? prefill : undefined,
      line_items: lineItems,
      automatic_tax: { enabled: false },
      currency: selectedPrice.currency,
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
    return this.provider.checkout.sessions.listLineItems(checkoutSessionId, {
      expand: ['data.price.product'],
    });
  }

  getCustomer(customerId: CustomerId) {
    return this.provider.customers.retrieve(customerId);
  }

  getProduct(productId: Stripe.Product['id']) {
    return this.provider.products.retrieve(productId);
  }

  private async findIndividualActiveSubscription(customerId: CustomerId): Promise<Subscription> {
    const activeSubscriptions = await this.getActiveSubscriptions(customerId);

    const individualActiveSubscription = activeSubscriptions.find((subscription) => {
      const isNotBusiness = subscription.product?.metadata?.type !== 'business';
      return isNotBusiness;
    });
    if (!individualActiveSubscription) {
      throw new NotFoundSubscriptionError('There is no individual subscription to update');
    }

    return individualActiveSubscription;
  }

// <<<<<<< HEAD
//   private async findB2BActiveSubscription(customerId: CustomerId): Promise<Subscription> {
//     const activeSubscriptions = await this.getActiveSubscriptions(customerId);

//     const b2bActiveSubscription = activeSubscriptions.find((subscription) => {
//       const product = subscription.product;
//       return product && product.metadata?.type === 'business';
//     });
//     if (!b2bActiveSubscription) {
//       throw new NotFoundSubscriptionError('No B2B subscription found');
//     }

//     return b2bActiveSubscription;
// =======
  private async findBusinessActiveSubscription(customerId: CustomerId): Promise<Subscription> {
    const products = await this.productsRepository.findByType(UserType.Business);
    const businessProductIds = products.map(product => product.paymentGatewayId);

    const activeSubscriptions = await this.getActiveSubscriptions(customerId);

    const businessSubscription = activeSubscriptions.find(
      (subscription) => businessProductIds.includes(subscription.items.data[0].price.product.toString()),
    );
    if (!businessSubscription) {
      throw new NotFoundSubscriptionError('There is no individual subscription to update');
    }

    return businessSubscription;
// >>>>>>> master
  }
}

class NotFoundSubscriptionError extends Error {}
export class CouponCodeError extends Error {
  constructor(message: string) {
    super(message);

    Object.setPrototypeOf(this, CouponCodeError.prototype);
  }
}
