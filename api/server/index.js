require('dotenv').config();
const path = require('path');
require('module-alias')({ base: path.resolve(__dirname, '..') });
const cors = require('cors');
const axios = require('axios');
const express = require('express');
const compression = require('compression');
const passport = require('passport');
const mongoSanitize = require('express-mongo-sanitize');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { jwtLogin, passportLogin } = require('~/strategies');
const { connectDb, indexSync } = require('~/lib/db');
const { isEnabled } = require('~/server/utils');
const { ldapLogin } = require('~/strategies');
const { logger } = require('~/config');
const validateImageRequest = require('./middleware/validateImageRequest');
const errorController = require('./controllers/ErrorController');
const configureSocialLogins = require('./socialLogins');
const AppService = require('./services/AppService');
const staticCache = require('./utils/staticCache');
const noIndex = require('./middleware/noIndex');
const routes = require('./routes');

const { PORT, HOST, ALLOW_SOCIAL_LOGIN, DISABLE_COMPRESSION, TRUST_PROXY } = process.env ?? {};

const port = Number(PORT) || 3080;
const host = HOST || 'localhost';
const trusted_proxy = Number(TRUST_PROXY) || 1; /* trust first proxy by default */

const startServer = async () => {
  try {
    logger.info('Starting server...');
    if (typeof Bun !== 'undefined') {
      axios.defaults.headers.common['Accept-Encoding'] = 'gzip';
    }
    logger.info('Connecting to MongoDB...');
    await connectDb();
    logger.info('Connected to MongoDB');
    logger.info('Syncing indexes...');
    await indexSync();
    logger.info('Indexes synced');

    const app = express();
    logger.info('Express app created');
    app.disable('x-powered-by');
    logger.info('Initializing AppService...');
    await AppService(app);
    logger.info('AppService initialized');

    const indexPath = path.join(app.locals.paths.dist, 'index.html');
    logger.info(`Loading index.html from ${indexPath}`);
    const indexHTML = fs.readFileSync(indexPath, 'utf8');
    logger.info('index.html loaded');

    app.get('/health', (_req, res) => res.status(200).send('OK'));
    logger.info('Health check endpoint configured');

    /* Middleware */
    logger.info('Setting up middleware...');
    app.use(noIndex);
    app.use(errorController);
    app.use(express.json({ limit: '3mb' }));
    app.use(mongoSanitize());
    app.use(express.urlencoded({ extended: true, limit: '3mb' }));
    app.use(staticCache(app.locals.paths.dist));
    app.use(staticCache(app.locals.paths.fonts));
    app.use(staticCache(app.locals.paths.assets));
    app.set('trust proxy', trusted_proxy);
    app.use(cors());
    app.use(cookieParser());
    logger.info('Middleware setup complete');

    if (!isEnabled(DISABLE_COMPRESSION)) {
      app.use(compression());
    }

    if (!ALLOW_SOCIAL_LOGIN) {
      console.warn(
        'Social logins are disabled. Set Environment Variable "ALLOW_SOCIAL_LOGIN" to true to enable them.',
      );
    }

    /* OAUTH */
    logger.info('Setting up authentication...');
    app.use(passport.initialize());
    logger.info('Configuring JWT login strategy...');
    passport.use(await jwtLogin());
    logger.info('Configuring passport login strategy...');
    passport.use(passportLogin());

    /* LDAP Auth */
    if (process.env.LDAP_URL && process.env.LDAP_USER_SEARCH_BASE) {
      logger.info('Configuring LDAP login strategy...');
      passport.use(ldapLogin);
    }

    if (isEnabled(ALLOW_SOCIAL_LOGIN)) {
      logger.info('Configuring social logins...');
      configureSocialLogins(app);
    }
    logger.info('Authentication setup complete');

    logger.info('Mounting routes...');
    app.use('/oauth', routes.oauth);
    /* API Endpoints */
    app.use('/api/auth', routes.auth);
    app.use('/api/actions', routes.actions);
    app.use('/api/keys', routes.keys);
    app.use('/api/user', routes.user);
    app.use('/api/search', routes.search);
    app.use('/api/ask', routes.ask);
    app.use('/api/edit', routes.edit);
    app.use('/api/messages', routes.messages);
    app.use('/api/convos', routes.convos);
    app.use('/api/presets', routes.presets);
    app.use('/api/prompts', routes.prompts);
    app.use('/api/categories', routes.categories);
    app.use('/api/tokenizer', routes.tokenizer);
    app.use('/api/endpoints', routes.endpoints);
    app.use('/api/balance', routes.balance);
    app.use('/api/models', routes.models);
    app.use('/api/plugins', routes.plugins);
    app.use('/api/config', routes.config);
    app.use('/api/assistants', routes.assistants);
    logger.info('Initializing files route...');
    app.use('/api/files', await routes.files.initialize());
    app.use('/images/', validateImageRequest, routes.staticRoute);
    app.use('/api/share', routes.share);
    app.use('/api/roles', routes.roles);
    app.use('/api/agents', routes.agents);
    app.use('/api/banner', routes.banner);
    app.use('/api/bedrock', routes.bedrock);
    app.use('/api/tags', routes.tags);
    logger.info('Routes mounted');

    app.use((req, res) => {
      res.set({
        'Cache-Control': process.env.INDEX_CACHE_CONTROL || 'no-cache, no-store, must-revalidate',
        Pragma: process.env.INDEX_PRAGMA || 'no-cache',
        Expires: process.env.INDEX_EXPIRES || '0',
      });

      const lang = req.cookies.lang || req.headers['accept-language']?.split(',')[0] || 'en-US';
      const saneLang = lang.replace(/"/g, '&quot;');
      const updatedIndexHtml = indexHTML.replace(/lang="en-US"/g, `lang="${saneLang}"`);
      res.type('html');
      res.send(updatedIndexHtml);
    });

    logger.info(`Starting server on ${host}:${port}...`);
    app.listen(port, host, () => {
      if (host == '0.0.0.0') {
        logger.info(
          `Server listening on all interfaces at port ${port}. Use http://localhost:${port} to access it`,
        );
      } else {
        logger.info(`Server listening at http://${host == '0.0.0.0' ? 'localhost' : host}:${port}`);
      }
    });
    logger.info('Server started successfully');
  } catch (error) {
    logger.error('Error starting server:', error);
    process.exit(1);
  }
};

startServer();

let messageCount = 0;
process.on('uncaughtException', (err) => {
  if (!err.message.includes('fetch failed')) {
    logger.error('There was an uncaught error:', err);
  }

  if (err.message.includes('abort')) {
    logger.warn('There was an uncatchable AbortController error.');
    return;
  }

  if (err.message.includes('GoogleGenerativeAI')) {
    logger.warn(
      '\n\n`GoogleGenerativeAI` errors cannot be caught due to an upstream issue, see: https://github.com/google-gemini/generative-ai-js/issues/303',
    );
    return;
  }

  if (err.message.includes('fetch failed')) {
    if (messageCount === 0) {
      logger.warn('Meilisearch error, search will be disabled');
      messageCount++;
    }

    return;
  }

  if (err.message.includes('OpenAIError') || err.message.includes('ChatCompletionMessage')) {
    logger.error(
      '\n\nAn Uncaught `OpenAIError` error may be due to your reverse-proxy setup or stream configuration, or a bug in the `openai` node package.',
    );
    return;
  }

  process.exit(1);
});
