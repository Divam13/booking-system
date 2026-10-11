import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { pool } from '../db';

export async function authRoutes(app: FastifyInstance) {
  // Register
  app.post('/auth/register', async (request, reply) => {
    const { email, password, name } = request.body as {
      email: string;
      password: string;
      name: string;
    };

    if (!email || !password || !name) {
      return reply.status(400).send({ error: 'Email, password, and name are required' });
    }

    // Check if user already exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount! > 0) {
      return reply.status(409).send({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, passwordHash, name]
    );

    const user = result.rows[0];
    const token = app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });

    return reply.status(201).send({
      user: { id: user.id, email: user.email, name: user.name },
      token,
    });
  });

  // Login
  app.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (result.rowCount === 0) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = app.jwt.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });

    return reply.send({
      user: { id: user.id, email: user.email, name: user.name },
      token,
    });
  });
}
