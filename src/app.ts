import cors from 'cors';
import express from 'express';
import { configured, env } from './config/env';
import { errorHandler } from './middleware/error';
import adminRoutes from './routes/admin';
import appointmentRoutes from './routes/appointments';
import authRoutes from './routes/auth';
import callRoutes from './routes/calls';
import chatRoutes from './routes/chat';
import conversationRoutes from './routes/conversations';
import doctorRoutes from './routes/doctors';
import notificationRoutes from './routes/notifications';
import paymentRoutes from './routes/payments';
import practiceRoutes from './routes/practice';
import reviewRoutes from './routes/reviews';
import uploadRoutes from './routes/uploads';
import webhookRoutes from './routes/webhooks';

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigins.length ? env.corsOrigins : true, credentials: true }));
  app.use(
    express.json({
      // Stash the raw body so Stream webhook signatures can be verified (the
      // signature is an HMAC of the exact bytes Stream sent).
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  // Health check (Railway hits /health). Reports which integrations are live.
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString(),
      services: {
        database: configured.db(),
        stream: configured.stream(),
        flutterwave: configured.flutterwave(),
        paypal: configured.paypal(),
        resend: configured.resend(),
        r2: configured.r2(),
        sms: configured.sms(),
      },
    });
  });

  app.get('/', (_req, res) => {
    res.json({ name: 'Eko Telehealth API', version: '1.0.0', docs: 'See README.md' });
  });

  // Client-facing routes (mobile app)
  app.use('/auth', authRoutes);
  app.use('/doctors', doctorRoutes);
  app.use('/appointments', appointmentRoutes);
  app.use('/conversations', conversationRoutes);
  app.use('/notifications', notificationRoutes);
  app.use('/practice', practiceRoutes);
  app.use('/payments', paymentRoutes);
  app.use('/calls', callRoutes);
  app.use('/chat', chatRoutes);
  app.use('/reviews', reviewRoutes);
  app.use('/uploads', uploadRoutes);

  // Provider callbacks + admin console
  app.use('/webhooks', webhookRoutes);
  app.use('/admin', adminRoutes);

  app.use((_req, res) => res.status(404).json({ message: 'Not found' }));
  app.use(errorHandler);

  return app;
}
