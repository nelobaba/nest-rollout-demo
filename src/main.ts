import 'reflect-metadata';
import {
  Module,
  Controller,
  Get,
  InternalServerErrorException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

// The version is baked in at build time via an env var (see the Dockerfile).
const VERSION = process.env.APP_VERSION ?? 'dev';
// Flip this to make an image "bad" without changing app logic. v2's image sets it to "true".
const FAIL_HEALTH = process.env.FAIL_HEALTH === 'true';

@Controller()
class AppController {
  @Get()
  root() {
    return { app: 'nest-rollout-demo', version: VERSION };
  }

  @Get('health')
  health() {
    // The "taster" (Argo Rollouts analysis) hits this endpoint.
    if (FAIL_HEALTH) {
      // Simulated regression: v2 is broken. Returns HTTP 500.
      throw new InternalServerErrorException({
        status: 'unhealthy',
        version: VERSION,
      });
    }
    return { status: 'ok', version: VERSION };
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`nest-rollout-demo ${VERSION} listening on :3000 (FAIL_HEALTH=${FAIL_HEALTH})`);
}
bootstrap();