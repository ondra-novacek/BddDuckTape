import { createWorkerHandler, type WorkerEnv } from './worker';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env extends WorkerEnv {
  ASSETS: AssetsBinding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      return createWorkerHandler(env)(request);
    }
    return env.ASSETS.fetch(request);
  }
};
