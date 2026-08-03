import pino, { type LoggerOptions } from 'pino';
import { config } from './config.js';

const options: LoggerOptions = { level: config.logLevel };
if (config.nodeEnv === 'development') {
  options.transport = {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss' },
  };
}

export const logger = pino(options);
