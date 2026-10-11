import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { config } from './config';
import { authRoutes } from './routes/auth';
import { trainRoutes } from './routes/trains';
import { holdRoutes, startHoldSweeper } from './routes/holds';
import { bookingRoutes } from './routes/bookings';
import { subscribeSeatUpdates } from './events';
import { setupWebSocket } from './ws';

const app = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
});

async function start() {
  // Register plugins
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyJwt, { secret: config.jwt.secret });
  await app.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'public'),
    prefix: '/',
  });

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // Register routes
  await app.register(authRoutes);
  await app.register(trainRoutes);
  await app.register(holdRoutes);
  await app.register(bookingRoutes);

  // Start the server
  await app.listen({ port: config.server.port, host: config.server.host });

  // Setup WebSocket on the underlying HTTP server
  const server = app.server;
  setupWebSocket(server);

  // Subscribe to Redis Pub/Sub for cross-instance seat updates
  await subscribeSeatUpdates();

  // Start the hold sweeper
  await startHoldSweeper();

  console.log(`\n🚂 Railway Booking System running at http://localhost:${config.server.port}`);
  console.log(`📊 Seat map UI: http://localhost:${config.server.port}/index.html`);
  console.log(`💚 Health check: http://localhost:${config.server.port}/health\n`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app };
