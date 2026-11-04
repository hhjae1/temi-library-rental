import { EventEmitter } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApi } from './api.js';
import { defaults } from './config.js';
import { openDb } from './db.js';
import { createDispatcher } from './dispatcher.js';
import { createEventHub } from './events.js';
import { createRentalService } from './rentalService.js';
import { createRobotLink } from './robotLink.js';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));

export async function startServer(overrides = {}) {
  const config = { ...defaults, ...overrides, timeouts: { ...defaults.timeouts, ...overrides.timeouts } };
  const log = overrides.log ?? console;

  const db = openDb(config.dbFile, { seed: config.seed });
  const bus = new EventEmitter();
  const service = createRentalService(db, bus);

  const app = express();
  const server = http.createServer(app);
  const robot = createRobotLink({ server, bus, log });
  const dispatcher = createDispatcher({ service, robot, config, log });
  const events = createEventHub(bus);

  app.get('/api/events', events.handler);
  app.use('/api', createApi({ service, dispatcher, robot, config }));
  app.use('/shared', express.static(`${WEB_DIR}shared`));
  app.use('/admin', express.static(`${WEB_DIR}admin`));
  app.use('/robot', express.static(`${WEB_DIR}robot-sim`));
  app.use('/', express.static(`${WEB_DIR}student`));

  await new Promise((resolve) => server.listen(config.port, resolve));
  dispatcher.start();

  return {
    port: server.address().port,
    service,
    async close() {
      dispatcher.stop();
      events.close();
      robot.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}
