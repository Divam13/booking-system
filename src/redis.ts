import Redis from 'ioredis';
import { config } from './config';

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
});

// Separate connection for pub/sub subscriber (ioredis requires a dedicated connection)
export const redisSub = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
});

// Separate connection for Redis Streams (xread blocks)
export const redisStream = new Redis(config.redis.url, {
  maxRetriesPerRequest: null, // xread can block indefinitely
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redisSub.on('error', (err) => {
  console.error('Redis sub connection error:', err);
});

redisStream.on('error', (err) => {
  console.error('Redis stream connection error:', err);
});
