import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS || 'http://localhost:8000',
      adminCors: process.env.ADMIN_CORS || 'http://localhost:9000',
      authCors: process.env.AUTH_CORS || 'http://localhost:9000',
      jwtSecret: process.env.JWT_SECRET || 'test',
      cookieSecret: process.env.COOKIE_SECRET || 'test',
    },
  },
  modules: [
    {
      resolve: './src/modules/review',
      // Cascades to the review module service's constructor as its
      // `options` argument - see src/modules/review/service.ts and
      // src/settings/vote-salt.ts for the resolution precedence and why an
      // absent REVIEW_VOTE_SALT resolves to undefined rather than a
      // hardcoded default.
      options: { voteSalt: process.env.REVIEW_VOTE_SALT },
    },
  ],
})
