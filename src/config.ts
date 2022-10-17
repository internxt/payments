import 'dotenv/config';

const mandatoryVariables = [
  'NODE_ENV',
  'SERVER_PORT',
  'MONGO_URI',
  'STORAGE_GATEWAY_SECRET',
  'STORAGE_GATEWAY_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_KEY',
  'JWT_SECRET',
  'DRIVE_GATEWAY_URL',
  'DRIVE_GATEWAY_USER',
  'DRIVE_GATEWAY_PASSWORD',
  'NOTIFICATIONS_API_KEY',
  'NOTIFICATIONS_URL',
] as const;

type BaseConfig = {
  [name in typeof mandatoryVariables[number]]: string;
};

interface DevConfig extends BaseConfig {
  NODE_ENV: 'development';
  REDIS_HOST?: string;
}

const mandatoryVariablesOnlyInProd = ['REDIS_HOST', 'REDIS_PASSWORD'] as const;

type ProdConfig = BaseConfig & {
  NODE_ENV: 'production';
} & {
  [name in typeof mandatoryVariablesOnlyInProd[number]]: string;
};

export type AppConfig = DevConfig | ProdConfig;

const variablesToCheck = [
  ...mandatoryVariables,
  ...(process.env.NODE_ENV === 'production' ? mandatoryVariablesOnlyInProd : []),
];

const undefinedMandatoryVariables = variablesToCheck.filter((key) => !process.env[key]);

if (undefinedMandatoryVariables.length) {
  throw new Error(`Some mandatory variables are undefined: ${undefinedMandatoryVariables.join(' - ')}.`);
}

export default process.env as AppConfig;
