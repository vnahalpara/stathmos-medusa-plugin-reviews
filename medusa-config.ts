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
  // R1: registers the Phase 0 smoke module, not the review module. The
  // review module does not exist until Task 2, which switches this line
  // over; registering a non-existent module here would fail app boot.
  modules: [{ resolve: './src/modules/smoke' }],
})
